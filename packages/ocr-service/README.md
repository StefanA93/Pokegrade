# GradeDex OCR Service (PaddleOCR)

Separat Railway-service der læser kortnummer + kortnavn fra et foto. Erstatter Tesseract
(kunne ikke læse holo-numre). Kaldes parallelt med CLIP-servicen fra `api/scan-free.js`.

## Endpoints
- `POST /ocr` — Body `{ image: "data:image/...;base64,...", game }`, header `Authorization: Bearer <EMBED_SECRET>`.
  Returnerer `{ number, setTotal, isCode, name, texts }`.
- `GET /health` — `{ status, model }`.

## Lokal kørsel
```bash
py -3.12 -m pip install -r requirements.txt
EMBED_SECRET=gd_embed_2024 py -3.12 -m uvicorn main:app --port 3002
```

## Railway-deploy
1. Opret ny service i Railway-projektet, peg **Root Directory** på `packages/ocr-service`.
2. Railway (Nixpacks) auto-detekterer Python via `requirements.txt`; `Procfile` giver start-kommandoen.
3. Sæt env `EMBED_SECRET` = samme værdi som CLIP-servicen.
4. Kopiér service-URL'en → sæt `OCR_SERVICE_URL` i Vercel (bruges af `api/scan-free.js`).

## Noter
- Stak pinned til `paddlepaddle==2.6.2` + `paddleocr==2.9.1`: 3.x har en oneDNN/PIR-crash
  (`ConvertPirAttribute2RuntimeAttribute`) på nogle CPU'er. `numpy<2` kræves af paddle 2.6.2.
- Modellen pre-loades ved startup (varm) → ingen cold start pr. request.
