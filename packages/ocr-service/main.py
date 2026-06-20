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
# Begræns RAM-peak FØR paddle/numpy importeres: 1 tråd pr. math-lib → markant lavere hukommelse
# (PaddleOCR-inference OOM-dræbte containeren på trial-instansen ved samtidige tråde).
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import base64
import io
import re

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from PIL import Image, ImageOps
import numpy as np

# Maks billed-dimension før OCR — beskytter mod store-billede memory-spikes (scan-free sender
# 800px, men en defensiv cap forhindrer OOM hvis et større billede slipper igennem).
MAX_DIM = 1100

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
                         enable_mkldnn=False, cpu_threads=1)
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

    # Pass 1: hele kortet → navn + ofte nummer
    texts = _run(img)
    parsed = _parse_number(texts, game)

    # Pass 2 (kun hvis nummer mangler): beskær nummer-zonen (bund-venstre), gråtone +
    # autokontrast + opskalér — recept bevist på standalone-crops (læser hvor fuldt kort missede).
    if parsed["number"] is None:
        parsed = _parse_number(_run(_number_region(img)), game)

    return {**parsed, "name": _guess_name(texts), "texts": texts}


def _number_region(img: Image.Image) -> Image.Image:
    w, h = img.size
    region = img.crop((int(w * 0.02), int(h * 0.88), int(w * 0.42), int(h * 0.98)))
    region = ImageOps.autocontrast(region.convert("L"))
    scale = 800 / max(1, region.width)   # opskalér til ~800px bredde (float, ikke heltal)
    return region.resize((800, max(1, int(region.height * scale)))).convert("RGB")
