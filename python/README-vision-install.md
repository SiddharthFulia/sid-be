# Deep Vision Pipeline — Install Runbook

This service now runs a two-tier vision pipeline:

- **Light lanes** (eager, always available): MediaPipe Face Mesh, YOLOv8 (ONNX via OpenCV DNN), Tesseract OCR, k-means dominant colours.
- **Deep lanes** (lazy, loaded on first request per endpoint):
  - **BLIP-1 base** (`Salesforce/blip-image-captioning-base`, ~1 GB) — image captioning.
  - **CLIP ViT-B/32** (`openai/clip-vit-base-patch32`, ~350 MB) — zero-shot classification.
  - **InsightFace `buffalo_s`** (~150 MB) — 512-dim face embedding + age + gender + landmarks.
  - **PaddleOCR PP-OCRv4** (~50 MB det+rec) — real-world OCR.
  - **Depth-Anything-V2-Small** (~100 MB) — monocular depth map.

Total warm memory ≈ **1.7 GB** with all deep lanes loaded. Well within the Oracle Cloud ARM box's 12 GB.

---

## Fresh install on the Oracle Cloud box (ARM Ampere A1, Ubuntu 22.04)

```bash
ssh -i "E:\Siddharth\ssh-key-2026-04-19.key" ubuntu@80.225.213.103

cd /home/ubuntu/sid-be
git pull

# Activate the existing venv
source python/venv/bin/activate

# CRITICAL: torch on ARM needs the CPU wheel index. paddleocr + everything
# else will resolve normally against PyPI.
pip install torch==2.2.0 torchvision --index-url https://download.pytorch.org/whl/cpu

# Everything else
pip install -r python/requirements.txt

# Restart PM2
pm2 restart face-service
pm2 logs face-service --lines 40
```

You should see this boot summary:

```
[boot] MediaPipe Face Mesh + Detection loaded
[boot] Loaded YOLOv8n from /home/ubuntu/sid-be/python/yolov8n.onnx
[boot] Deep model probes:
  torch          = True
  transformers   = True   (BLIP + CLIP + Depth-Anything need this)
  insightface    = True   (face embeddings + verify)
  paddleocr      = True   (better OCR than Tesseract)
```

If any probe reads `False`, `/health` will report the import error and that endpoint will return `{ available: false, warning }` — the service still starts. Fix by re-running `pip install` for that specific package.

---

## First cold hit — download the weights

Every deep endpoint lazy-loads its model on first request. Expect **5–10 minutes** for the first hit on each new endpoint. After that, weights sit in `~/.cache/huggingface/` (BLIP, CLIP, Depth-Anything) or `~/.insightface/models/` (buffalo_s) and every future request warm-hits memory.

Warm them up in the background right after deploy:

```bash
# From your laptop, hit each deep endpoint with a small test image once.
# Use the FE at /vision or curl a base64 payload to /api/vision/deep-analyze.

curl -X POST https://api.siddharthfulia.com/api/vision/deep-analyze \
  -F "image=@/tmp/test.jpg"
```

The first call will hang for a few minutes as BLIP + CLIP + InsightFace + PaddleOCR + Depth-Anything all download in parallel. Subsequent calls take ~4-8 s on the ARM box (CPU-only, no batching).

Optional — pre-download without spinning up an inference request:

```bash
source /home/ubuntu/sid-be/python/venv/bin/activate
python - <<'PY'
from transformers import BlipProcessor, BlipForConditionalGeneration, CLIPProcessor, CLIPModel, pipeline
print('BLIP...');    BlipProcessor.from_pretrained('Salesforce/blip-image-captioning-base')
                     BlipForConditionalGeneration.from_pretrained('Salesforce/blip-image-captioning-base')
print('CLIP...');    CLIPProcessor.from_pretrained('openai/clip-vit-base-patch32')
                     CLIPModel.from_pretrained('openai/clip-vit-base-patch32')
print('Depth...');   pipeline('depth-estimation', model='depth-anything/Depth-Anything-V2-Small-hf')
print('InsightFace...')
from insightface.app import FaceAnalysis
fa = FaceAnalysis(name='buffalo_s', providers=['CPUExecutionProvider'])
fa.prepare(ctx_id=-1)
print('PaddleOCR...')
from paddleocr import PaddleOCR
PaddleOCR(use_angle_cls=True, lang='en', show_log=False)
print('All caches populated.')
PY
```

---

## Disk footprint

| Model | Size on disk | Cache location |
|---|---|---|
| BLIP-1 base | ~990 MB | `~/.cache/huggingface/hub/` |
| CLIP ViT-B/32 | ~350 MB | `~/.cache/huggingface/hub/` |
| Depth-Anything-V2-Small | ~100 MB | `~/.cache/huggingface/hub/` |
| InsightFace buffalo_s | ~150 MB | `~/.insightface/models/buffalo_s/` |
| PaddleOCR PP-OCRv4 | ~50 MB | `~/.paddleocr/whl/` |
| YOLOv8n (existing) | ~13 MB | `python/yolov8n.onnx` |
| Tesseract data (system pkg) | ~50 MB | `/usr/share/tesseract-ocr/` |
| **Total** | **~1.7 GB** | |

Nothing exotic — the whole set fits in a single 5 GB tmpfs if you ever need to move it.

---

## Fallback behaviour

The Node BE (`controllers/vision/index.js`) is designed to never hard-fail:

1. `/api/vision/deep-analyze` calls the Python `/vision-deep` omnibus. If that endpoint 404s (older Python service), it falls back to `/vision-analyze` (the light omnibus) and returns `backend: 'light'` in the payload.
2. Each deep lane inside `/vision-deep` is wrapped so a missing model returns `{ available: false, warning }` in that lane's subsection. Other lanes still return real data. No 5xx from a single missing model.
3. `/api/vision/analyze` (the original endpoint) automatically upgrades to `/vision-deep` when available and reports `backend: 'deep'`. If any deep lane fails, it still returns 200 with the light lane results.
4. `/api/tattoo/analyze` prefers the deep pipeline for style/subject/motif inference (BLIP caption + CLIP zero-shot against a tattoo-style label list). Gemini becomes the last-resort fallback for anyone who explicitly wants to burn a Gemini key.

---

## Rate limit + cache

- `/api/vision/deep-analyze` — **3 requests / minute / IP** (CPU-heavy).
- `/api/vision/analyze` — **5 req/min/IP** (light or deep).
- `/api/vision/face-verify` — **3 req/min/IP** (two-image compute).
- SHA-256 image cache — same image bytes never re-process for 24 hours.

---

## Redeploy command (one-liner)

```bash
ssh -i "E:\Siddharth\ssh-key-2026-04-19.key" ubuntu@80.225.213.103 \
  "cd /home/ubuntu/sid-be && git pull && \
   source python/venv/bin/activate && \
   pip install -r python/requirements.txt --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple/ && \
   pm2 restart all"
```
