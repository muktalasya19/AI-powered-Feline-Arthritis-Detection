# CPU image for running the polling worker on any machine with Docker
# (your PC, a spare server, or a free-tier VM). No GPU needed; a 20 s clip takes a few minutes.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && pip install torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install "deeplabcut==3.0.0"

COPY . .
CMD ["python", "worker.py"]
