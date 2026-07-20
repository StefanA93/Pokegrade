import os, io, json, urllib.request, re, sys
os.environ["PYTHONIOENCODING"] = "utf-8"
import numpy as np
from PIL import Image
sys.path.insert(0, "packages/ocr-service")
import main as svc

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
test = [json.loads(l) for l in open("_ebay/raw_yugioh.jsonl", encoding="utf-8")]

def norm(s): return re.sub(r"[^a-z0-9]", "", (s or "").lower())
def base(s): return re.sub(r"\s*\([^)]*\)\s*$", "", s or "")

def fetch(url):
    return Image.open(io.BytesIO(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=25).read())).convert("RGB")

flagged = []
for i, t in enumerate(test):
    try:
        img = fetch(t["src"])
    except Exception:
        flagged.append((t["number"], t["name"], "fetch-fejl", "")); continue
    w, h = img.size
    asp = w / h
    framing_bad = w < 900 or h < 900 or asp < 0.64 or asp > 0.78
    # navn-verifikation: OCR alle tekster, tjek om label-navnet (eller et markant ord) optræder
    try:
        texts = svc._run(img, "yugioh")
    except Exception:
        texts = []
    joined = norm(" ".join(texts))
    labeln = norm(base(t["name"]))
    # markante ord fra label (≥4 tegn) — mindst ét skal optræde i OCR-teksten
    words = [norm(x) for x in base(t["name"]).split() if len(norm(x)) >= 4]
    name_hit = (labeln and labeln in joined) or any(wd and wd in joined for wd in words) or (labeln and joined and (labeln[:8] in joined))
    label_bad = not name_hit and len(joined) > 10  # kun flag hvis vi FIK tekst men navnet mangler
    if framing_bad or label_bad:
        reason = ("framing " if framing_bad else "") + ("LABEL-MISMATCH" if label_bad else "")
        flagged.append((t["number"], t["name"], reason.strip(), f"{w}x{h} asp{asp:.2f} ocr='{' '.join(texts)[:40]}'"))
    if i % 30 == 0: sys.stderr.write(f"\r  {i}/{len(test)}")

print(f"\n== GATE: {len(flagged)} flagged af {len(test)} ==")
for num, name, reason, det in flagged:
    print(f"  {reason.ljust(22)} {num.ljust(12)} {name[:24].ljust(25)} {det}")
# gem flaggede numre
json.dump([f[0] for f in flagged], open("_ebay/ygo_flagged.json", "w"))
print(f"\ngemte flaggede numre → _ebay/ygo_flagged.json")
