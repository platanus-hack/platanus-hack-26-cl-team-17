# Imagen del detector YOLO para Cloud Run (solo onnxruntime + numpy + OpenCV; sin torch).
# Necesita los ONNX ya exportados en models/ (export.py). La construye deploy/detector.sh.
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIGIA_DETECTOR_HOST=0.0.0.0 \
    VIGIA_DETECTOR_PORT=8080

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py vocab.py ./
COPY models/vigia-yoloe-26s.onnx models/vigia-yoloe-26s.json models/yolo26n-pose.onnx models/yolo26n-pose.json ./models/

USER nobody
EXPOSE 8080
CMD ["python", "server.py"]
