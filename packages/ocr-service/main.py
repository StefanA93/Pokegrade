"""
GradeDex OCR Microservice (PaddleOCR) — deploy på Railway, separat fra CLIP-servicen.

POST /ocr   Body: { "image": "data:image/...;base64,...", "game": "pokemon" }
            Auth: Bearer <EMBED_SECRET> (samme hemmelighed som CLIP-servicen)
            Returns: { "number": "67", "setTotal": 203, "isCode": false,
                       "name": "Sableye", "texts": [...] }
GET  /health  Returns: { "status": "ok", "model": "ready"|"loading" }

PaddleOCR læser hele kortet: number+setTotal (entydig nøgle) OG kortnavnet (robust signal
på holo-kort hvor det bittesmå nummer fejler). Tesseract/TrOCR kunne ingen af delene.
Stabil stak: paddlepaddle==2.6.2 + paddleocr==2.9.1 (3.x har oneDNN/PIR-crash på nogle CPU'er).
"""
import os
# Tråde: 4 (på Railway Hobby — mere RAM). 1-tråds gav OOM-sikkerhed på trial men gjorde multi-pass
# voting for langsom (10-16s → getOcrService-timeouts). 4 tråde → ~4x hurtigere inference.
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

import base64
import io
import re
import math

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from PIL import Image, ImageOps, ImageFilter
from collections import Counter
import numpy as np
import cv2

# Defensiv OOM-cap på dekodet input. scan-free sender nu et ukroppet ~1300px PNG som
# preprocess_v2 selv normaliserer (resize 1300 → card_crop → resize 1200 → cap 1100).
# Cappen her må derfor IKKE skrumpe under 1300 (ville stjæle detalje fra card_crop's kant-
# detektion); 2200 fanger kun urealistisk store billeder.
MAX_DIM = 2200

SECRET = os.environ.get("EMBED_SECRET", "")
VALID_GAMES = {"pokemon", "pokemonjp", "mtg", "yugioh", "onepiece", "lorcana", "dragonball", "riftbound"}
CODE_GAMES = {"yugioh", "dragonball", "onepiece"}

# Ikke-navn-linjer der skal ignoreres ved navne-gæt (rang/stage/korttype/system-tekst)
NAME_STOP = re.compile(
    r"^(BASIC|STAGE\s*\d?|EVOLVES|ABILITY|HP|NO\.|ILLUS|TRAINER|ENERGY|ITEM|SUPPORTER|"
    r"POKE?MON\s*TOOL|STADIUM|©|\d)", re.I)

app = FastAPI()
_ocr = None
_ready = False


def get_ocr():
    global _ocr, _ready
    if _ocr is None:
        from paddleocr import PaddleOCR
        # use_angle_cls=False: drop angle-classifier-modellen (kort er opretstående) → mindre RAM.
        # enable_mkldnn=False + 1 tråd: lavere hukommelses-peak under inference.
        _ocr = PaddleOCR(use_angle_cls=False, lang="en", show_log=False,
                         enable_mkldnn=True, cpu_threads=4)
        _ready = True
    return _ocr


@app.on_event("startup")
def _warm():
    # Pre-load modellen ved startup → ingen cold start pr. request
    try:
        get_ocr()
        # kør ét dummy-kald så vægtene er varme
        _ocr.ocr(np.zeros((32, 64, 3), dtype=np.uint8))
    except Exception as e:
        print("OCR warmup failed:", e)


class OcrReq(BaseModel):
    image: str
    game: str = "pokemon"


def _decode(data_url: str) -> Image.Image:
    b64 = re.sub(r"^data:image/\w+;base64,", "", data_url)
    img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    if max(img.size) > MAX_DIM:   # defensiv cap mod store-billede OOM
        img.thumbnail((MAX_DIM, MAX_DIM))
    return img


def _run(img: Image.Image) -> list[str]:
    res = get_ocr().ocr(np.array(img))
    return [line[1][0] for page in (res or []) for line in (page or [])]


# ── Kort-detektion + deskew (porteret fra _ocrlab/pipeline.py, valideret 211-korts harness:
# cur 180/211 → 186/211, +6 FIXED / -0 REGRESSED). cv2-kontur finder kortets firkant og
# perspektiv-retter den FØR OCR → fjerner baggrund/tilt → small full-art-numre læses pålideligt
# (Victini 131/135, M Charizard 13/108, Brock's Grit 107/108). Guards no-op'er til _autocrop-
# fallback ved usikker detektion (for lille/fuld ramme/ikke-firkant/for smal/akse-justeret).
def _jpg(img: Image.Image, q: int = 90) -> Image.Image:
    b = io.BytesIO(); img.convert("RGB").save(b, "JPEG", quality=q); b.seek(0)
    return Image.open(b).convert("RGB")


def _autocrop(img: Image.Image) -> Image.Image:
    N = 256
    small = img.resize((N, N)).convert("L").filter(ImageFilter.GaussianBlur(0.6))
    g = np.asarray(small, dtype=np.float64); h, w = g.shape
    gx = np.zeros((h, w)); gx[1:h-1, 1:w-1] = np.abs(g[1:h-1, 2:w] - g[1:h-1, 0:w-2])
    gy = np.zeros((h, w)); gy[1:h-1, 1:w-1] = np.abs(g[2:h, 1:w-1] - g[0:h-2, 1:w-1])
    m = gx + gy; rowMass = m.sum(axis=1); colMass = m.sum(axis=0)

    def smooth(p):
        out = np.zeros_like(p)
        for i in range(len(p)):
            s = 0.0; n = 0
            for k in range(-2, 3):
                j = i + k
                if 0 <= j < len(p): s += p[j]; n += 1
            out[i] = s / n
        return out

    rM = smooth(rowMass); cM = smooth(colMass)

    def median(a): s = np.sort(a); return s[len(s) // 2]

    def extent(p, th):
        a = 0; b = len(p) - 1
        while a < len(p) and p[a] < th: a += 1
        while b > a and p[b] < th: b -= 1
        return a, b

    top, bot = extent(rM, median(rM) * 0.40); lft, rgt = extent(cM, median(cM) * 0.40)
    bw = rgt - lft; bh = bot - top; frac = (bw * bh) / (w * h)
    coreMean = rM[top:bot + 1].sum() / max(1, bh)
    marginRows = np.concatenate([rM[:top], rM[bot + 1:]])
    marginMean = marginRows.mean() if len(marginRows) else coreMean
    if frac > 0.86 or bw < w * 0.35 or bh < h * 0.35 or marginMean >= coreMean * 0.55:
        return img
    W, H = img.size
    L = max(0, int((lft / w - 0.015) * W)); T = max(0, int((top / h - 0.02) * H))
    R = min(W, int(np.ceil((rgt / w + 0.015) * W))); B = min(H, int(np.ceil((bot / h + 0.04) * H)))
    asp = (R - L) / max(1, (B - T))
    if asp < 0.55 or asp > 0.95:
        return img
    return img.crop((L, T, R, B))


def _order_pts(p):
    p = p.reshape(4, 2).astype("float32"); ss = p.sum(1); dd = (p[:, 0] - p[:, 1])
    return np.array([p[ss.argmin()], p[dd.argmax()], p[ss.argmax()], p[dd.argmin()]], dtype="float32")


def _skew(tl, tr, br, bl) -> float:
    def a(p, q): return abs(math.degrees(math.atan2(q[1] - p[1], q[0] - p[0])))
    return max(a(tl, tr), a(bl, br), abs(90 - a(tl, bl)), abs(90 - a(tr, br)))


def _card_crop(pil: Image.Image) -> Image.Image:
    img = cv2.cvtColor(np.asarray(pil.convert("RGB")), cv2.COLOR_RGB2BGR); h, w = img.shape[:2]
    gray = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    edges = cv2.dilate(cv2.Canny(gray, 20, 80), np.ones((5, 5), np.uint8), iterations=2)
    cnts, _h = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return pil
    c = max(cnts, key=cv2.contourArea)
    area = cv2.contourArea(c); frac = area / (w * h)
    if frac < 0.25:                       # for lille -> intet kort fundet
        return pil
    if frac > 0.88:                       # fylder rammen (ingen baggrund) -> autocrop-fallback
        return pil
    peri = cv2.arcLength(c, True); approx = cv2.approxPolyDP(c, 0.02 * peri, True)
    if len(approx) != 4:                  # intet rent firkant -> no-op
        return pil
    tl, tr, br, bl = _order_pts(approx)
    tw = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    th = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    if tw < 0.3 * w or th < 0.3 * h or not (0.66 < tw / max(1, th) < 0.95):  # urealistisk/for smal -> no-op
        return pil
    if _skew(tl, tr, br, bl) < 0.8 and frac > 0.80:  # akse-justeret + fylder rammen -> warp giver kun resample-slør
        return pil
    M = cv2.getPerspectiveTransform(
        np.array([tl, tr, br, bl], dtype="float32"),
        np.array([[0, 0], [tw, 0], [tw, th], [0, th]], dtype="float32"))
    return Image.fromarray(cv2.cvtColor(cv2.warpPerspective(img, M, (tw, th)), cv2.COLOR_BGR2RGB))


def _preprocess(img: Image.Image) -> Image.Image:
    w, h = img.size
    big = img.resize((1300, max(1, round(h * 1300 / w))))   # rent (ingen jpeg) -> bedre kant-detektion
    cr = _card_crop(big)
    if cr is big:                                           # intet kort fundet -> gammel autocrop
        cr = _autocrop(_jpg(big))
    cw, ch = cr.size; sc = min(1200 / cw, 1200 / ch)
    o = _jpg(cr.resize((max(1, round(cw * sc)), max(1, round(ch * sc)))))
    if max(o.size) > 1100:
        o.thumbnail((1100, 1100))
    return o


def _parse_number(texts: list[str], game: str) -> dict:
    is_code_game = game in CODE_GAMES
    joined = [t.replace(" ", "") for t in texts]

    if is_code_game:
        for t in joined:
            m = re.search(r"([A-Z]{2,6}\d{0,3}-[A-Z]{0,2}\d{2,4})", t.upper())
            if m:
                return {"number": m.group(1), "setTotal": None, "isCode": True}

    # slash-format NNN/NNN
    for t in joined:
        m = re.search(r"(\d{1,3})\s*/\s*(\d{1,3})", t)
        if m:
            total = int(m.group(2))
            if 10 <= total <= 400:
                return {"number": str(int(m.group(1))), "setTotal": total, "isCode": False}
    # tolerant: skråstreg tabt af recognizer → 6 cifre i træk = NNN + NNN
    for t in joined:
        d = re.sub(r"\D", "", t)
        if len(d) == 6:
            total = int(d[3:])
            if 10 <= total <= 400:
                return {"number": str(int(d[:3])), "setTotal": total, "isCode": False}
    return {"number": None, "setTotal": None, "isCode": False}


def _guess_name(texts: list[str]) -> str | None:
    # Navnet er typisk en af de øverste linjer med overvejende bogstaver, ikke system-tekst.
    # Strip efterhængt HP-tal ("Smeargle80" → "Smeargle") og trim symboler.
    for t in texts[:6]:
        s = re.sub(r"\s*\d{1,3}\s*$", "", t.strip()).strip(" -·.")
        if len(s) >= 3 and not NAME_STOP.match(s) and sum(c.isalpha() for c in s) >= len(s) * 0.6:
            return s
    return None


@app.get("/health")
def health():
    return {"status": "ok", "model": "ready" if _ready else "loading"}


@app.post("/ocr")
def ocr(req: OcrReq, authorization: str = Header(default="")):
    if SECRET and authorization != f"Bearer {SECRET}":
        raise HTTPException(status_code=401, detail="unauthorized")
    game = req.game if req.game in VALID_GAMES else "pokemon"
    try:
        img = _decode(req.image)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid image")
    # Kort-detektion + deskew FØR OCR (scan-free sender nu ukroppet ~1300px PNG → servicen ejer
    # hele preprocessing-kæden). Fald tilbage til ubehandlet billede ved cv2-fejl.
    try:
        img = _preprocess(img)
    except Exception:
        pass

    # Pass 1: hele (deskewede) kortet → navn (+ ofte nummer for regulære kort).
    texts = _run(img)
    # Nummer: multi-pass VOTING over flere preprocessing-varianter af nummer-zonen → stabilt
    # (PaddleOCR's detektion af det lille collector-nummer var intermittent: 214↔null, 106↔"6").
    num = _read_number(img, game, texts)

    return {**num, "name": _guess_name(texts), "texts": texts}


def _up(g: Image.Image, width: int) -> Image.Image:
    scale = width / max(1, g.width)
    return g.resize((width, max(1, int(g.height * scale)))).convert("RGB")


# Flere preprocessing-varianter af nummer-zonen — forskellige greb (upscale/sharpen/edge/tæt-crop)
# giver PaddleOCR flere chancer for at fange det thin ledende ciffer; voting vælger konsensus.
def _number_variants(img: Image.Image) -> list[Image.Image]:
    w, h = img.size
    def ac(x0, y0, x1, y1):
        return ImageOps.autocontrast(img.crop((int(w * x0), int(h * y0), int(w * x1), int(h * y1))).convert("L"))
    # LEAN sæt (bevist via 211-korts bidrags-audit): 3 nummer-zone-crops + fuld-kort-pass = 4 passes total,
    # som læser FLERE numre korrekt (180 vs 178) end det gamle 6-pass-sæt, med -33% CPU/RAM. Det gamle
    # bund-bånd (`og`) bidrog 0 unikke kort = ren dødvægt → fjernet. Collector-nummeret sidder bund-HØJRE
    # (full-art/Prime/LvX/secret-hjørne), bund-bredt, ELLER bund-venstre (dækket af det brede bånd + fuld-kort).
    return [
        _up(ac(0.62, 0.80, 1.0, 0.99), 1500),   # yderste bund-HØJRE — hjørne-nummer (M Venusaur, Donphan Prime)
        _up(ac(0.45, 0.82, 1.0, 1.0), 1500),     # bund-højre bredt
        _up(ac(0.0, 0.82, 1.0, 0.99), 1500),     # fuld-bredde bund-bånd (venstre → højre)
    ]


# Stem på nummeret på tværs af fuld-kort + nummer-varianter. Tie-break: flest stemmer →
# mest komplet (setTotal/kode) → højest num-værdi (3-cifret > misread 1-cifret som mistede ledende ciffer).
def _read_number(img: Image.Image, game: str, full_texts: list[str]) -> dict:
    votes = Counter()
    for texts in [full_texts] + [_run(v) for v in _number_variants(img)]:
        p = _parse_number(texts, game)
        if p["number"] is not None:
            votes[(p["number"], p["setTotal"], p["isCode"])] += 1
    if not votes:
        return {"number": None, "setTotal": None, "isCode": False}

    def rank(item):
        (num, total, is_code), n = item
        complete = 1 if (total is not None or is_code) else 0
        val = int(num) if (num and num.isdigit()) else 0
        return (n, complete, val)

    (num, total, is_code), _ = max(votes.items(), key=rank)
    return {"number": num, "setTotal": total, "isCode": is_code}
