# Dockerfile til OCR-servicen. Bruges frem for Nixpacks (Railway foretrækker Dockerfile),
# fordi Nixpacks' apt-pakker ikke pålideligt fulgte med i runtime-imaget → paddle/opencv
# crashede på manglende system-libs (libGL / libgomp). Her installeres de eksplicit.
FROM python:3.12-slim

# System-libs: OpenCV (libgl1, libglib2.0-0) + paddlepaddle OpenMP-runtime (libgomp1)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bag OCR-modellerne ind i imaget (EN + japansk) → ingen runtime-download ved cold start.
# Japansk-modellen er PP-OCR mobile/lite-default (samme størrelsesorden som EN). Egen layer:
# afhænger kun af requirements, så kode-ændringer (COPY . .) genbruger cachen.
RUN python -c "from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=False, lang='en', show_log=False); PaddleOCR(use_angle_cls=False, lang='japan', show_log=False)"

COPY . .

# Railway injicerer $PORT; shell-form CMD så variablen ekspanderes.
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
