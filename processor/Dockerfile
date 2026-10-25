FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 DEBIAN_FRONTEND=noninteractive
# Open-source OCR + common document conversion. Container instances should use at least standard-2.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-all tesseract-ocr-osd \
    libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-core \
    fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-extra \
    libglib2.0-0 libgl1 libgomp1 \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app
WORKDIR /app
COPY processor/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY processor/app.py ./app.py
RUN chown -R app:app /app
USER app
ENV HOME=/home/app
EXPOSE 8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --timeout-keep-alive 30"]
