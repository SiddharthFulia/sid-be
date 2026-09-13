"""Vision service — light + deep lanes on one Flask app.

Light lanes (loaded eagerly at boot, always available):
  • /analyze          — MediaPipe Face Mesh: 468 landmarks → 68 remap + mood
  • /detect-objects   — YOLOv8-nano ONNX via OpenCV DNN (fast, no torch)
  • /ocr              — Tesseract text recognition (soft-fails if binary missing)
  • /dominant-colors  — k-means on a 64x64 downsample (top-K clusters)
  • /vision-analyze   — omnibus of the four above

Deep lanes (lazy-loaded on first hit, each guarded by an install probe so a
missing wheel yields `{ available: false, warning }` instead of hard-failing
the whole service):
  • /caption          — BLIP-1 base           "describe what's in the image"
  • /clip-tags        — CLIP ViT-B/32         zero-shot classification
  • /face-embed       — InsightFace buffalo_s 512-dim embedding + age/gender
  • /face-verify      — two images → cosine sim → { same_person, similarity }
  • /paddle-ocr       — PaddleOCR PP-OCRv4    better than Tesseract on real photos
  • /depth-map        — Depth-Anything-V2-S   monocular depth preview + stats
  • /vision-deep      — omnibus of ALL the above (light + deep in one call)

Design notes:
  • Each deep model is wrapped in a `_LazyModel` singleton with a threading.Lock
    so concurrent requests don't fire the (multi-GB) download twice.
  • First hit on each endpoint blocks until the model downloads (2-10 min on
    Oracle box). Subsequent requests hit warm memory.
  • The service prints a startup summary listing which optional deps imported
    cleanly so the admin can see what's available without spending a real call.
  • Total warm-memory footprint: ~1.7 GB with all lanes hot (BLIP ~1 GB, CLIP
    ~350 MB, Depth-Anything-V2-S ~100 MB, InsightFace buffalo_s ~150 MB,
    YOLOv8n ~15 MB, PaddleOCR det+rec ~50 MB). Comfortable on the 12 GB Oracle
    box; still fine on smaller VMs since deep lanes only load on demand.
"""

import os
import io
import base64
import math
import time
import hashlib
import threading
import traceback
import numpy as np
import cv2
from flask import Flask, request, jsonify
from flask_cors import CORS

# ─── Optional deps: OCR (Tesseract) ──────────────────────────────
try:
    import pytesseract  # type: ignore
    from PIL import Image  # type: ignore
    _OCR_MODULE_OK = True
except Exception as _ocr_err:  # pragma: no cover
    pytesseract = None
    Image = None
    _OCR_MODULE_OK = False
    _OCR_IMPORT_ERR = str(_ocr_err)
else:
    _OCR_IMPORT_ERR = None

# ─── Optional deps: deep pipeline (probes only — real load is lazy) ────
_DEEP_IMPORT_ERRORS = {}


def _probe_import(name, importer):
    """Try to import a module (or run a lambda) — return True on success.

    We probe at boot so the /health endpoint can report which deep lanes will
    plausibly work without actually loading multi-GB weights until a real
    request arrives.
    """
    try:
        importer()
        return True
    except Exception as e:  # pragma: no cover — depends on install
        _DEEP_IMPORT_ERRORS[name] = f'{type(e).__name__}: {e}'
        return False


_HAS_TORCH = _probe_import('torch', lambda: __import__('torch'))
_HAS_TRANSFORMERS = _probe_import('transformers', lambda: __import__('transformers'))
_HAS_INSIGHTFACE = _probe_import('insightface', lambda: __import__('insightface'))
_HAS_PADDLE = _probe_import('paddleocr', lambda: __import__('paddleocr'))

# ─── Flask app + CORS ────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

# ═══════════════════════════════════════════════════════════════════════════════
# LIGHT LANE 1: MediaPipe Face Mesh (kept from the previous build)
# ═══════════════════════════════════════════════════════════════════════════════

import mediapipe as mp

mp_face_mesh = mp.solutions.face_mesh
face_mesh = mp_face_mesh.FaceMesh(
    static_image_mode=True,
    max_num_faces=5,
    refine_landmarks=True,
    min_detection_confidence=0.5,
)
mp_face_detection = mp.solutions.face_detection
face_detector = mp_face_detection.FaceDetection(
    model_selection=0,
    min_detection_confidence=0.5,
)
print('[boot] MediaPipe Face Mesh + Detection loaded')

# MediaPipe 468 → dlib 68 mapping (exactly 68 points)
MP_TO_68 = [
    234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 365, 288, 323,
    70, 63, 105, 66, 107,
    336, 296, 334, 293, 300,
    168, 6, 197, 195,
    5, 4, 45, 275, 1,
    33, 160, 158, 133, 153, 144,
    362, 385, 387, 263, 373, 380,
    61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 321,
    78, 82, 13, 312, 308, 317, 14, 87,
]

OUTER_LIP_LOOP = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]
INNER_LIP_LOOP = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191]
LEFT_EYE = [33, 160, 158, 133, 153, 144]
RIGHT_EYE = [362, 385, 387, 263, 373, 380]
LEFT_EYEBROW = [70, 63, 105, 66, 107]
RIGHT_EYEBROW = [336, 296, 334, 293, 300]


def decode_image(image_data):
    """Accept base64 or a data:URI and return a BGR uint8 numpy array."""
    if not isinstance(image_data, str):
        return None
    if ',' in image_data:
        image_data = image_data.split(',', 1)[1]
    try:
        img_bytes = base64.b64decode(image_data)
    except Exception:
        return None
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return None
    if img.dtype != np.uint8:
        img = img.astype(np.uint8)
    if len(img.shape) == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return img


def eye_aspect_ratio(landmarks, indices, w, h):
    pts = [(landmarks[i].x * w, landmarks[i].y * h) for i in indices]
    v1 = math.dist(pts[1], pts[5])
    v2 = math.dist(pts[2], pts[4])
    ho = math.dist(pts[0], pts[3])
    return (v1 + v2) / (2.0 * ho) if ho > 0 else 0


def detect_mood(landmarks, w, h):
    try:
        def pt(i):
            return (landmarks[i].x * w, landmarks[i].y * h)

        mouth_top = pt(13)
        mouth_bottom = pt(14)
        mouth_left = pt(61)
        mouth_right = pt(291)

        mouth_open = abs(mouth_bottom[1] - mouth_top[1])
        mouth_width = abs(mouth_right[0] - mouth_left[0])
        mouth_ratio = mouth_open / max(mouth_width, 1)

        lip_center_y = (mouth_top[1] + mouth_bottom[1]) / 2
        corner_avg_y = (pt(61)[1] + pt(291)[1]) / 2
        face_h = abs(pt(10)[1] - pt(152)[1])
        smile_score = (lip_center_y - corner_avg_y) / max(face_h, 1)

        left_ear = eye_aspect_ratio(landmarks, LEFT_EYE, w, h)
        right_ear = eye_aspect_ratio(landmarks, RIGHT_EYE, w, h)
        eye_openness = (left_ear + right_ear) / 2

        left_brow_y = np.mean([landmarks[i].y for i in LEFT_EYEBROW]) * h
        right_brow_y = np.mean([landmarks[i].y for i in RIGHT_EYEBROW]) * h
        eye_center_y = (landmarks[159].y * h + landmarks[386].y * h) / 2
        brow_raise = (eye_center_y - (left_brow_y + right_brow_y) / 2) / max(face_h, 1)

        if mouth_ratio > 0.35:
            return 'surprised', min(0.5 + mouth_ratio, 0.95)
        elif smile_score > 0.02:
            return 'happy', min(0.6 + smile_score * 5, 0.98)
        elif smile_score < -0.015:
            return 'sad', min(0.5 + abs(smile_score) * 5, 0.85)
        elif brow_raise > 0.16 and smile_score < 0.0:
            return 'angry', min(0.5 + (brow_raise - 0.16) * 4, 0.8)
        elif eye_openness < 0.15:
            return 'sleepy', 0.7
        else:
            return 'neutral', 0.75
    except Exception:
        return 'neutral', 0.5


def estimate_age(landmarks, w, h):
    """Heuristic age band from MediaPipe landmarks — replaced by InsightFace
    when the deep face lane is used (see /face-embed)."""
    try:
        def pt(i):
            return (landmarks[i].x * w, landmarks[i].y * h)
        top = pt(10)
        chin = pt(152)
        left_cheek = pt(234)
        right_cheek = pt(454)
        eye_y = (pt(33)[1] + pt(263)[1]) / 2.0
        mouth_y = (pt(13)[1] + pt(14)[1]) / 2.0
        face_h = abs(chin[1] - top[1])
        face_w = abs(right_cheek[0] - left_cheek[0])
        ratio = face_h / max(face_w, 1e-3)
        eye_mouth = abs(mouth_y - eye_y) / max(face_h, 1e-3)

        if ratio < 1.10 and eye_mouth < 0.18:
            band, mid = '0-12', 8
        elif ratio < 1.25 and eye_mouth < 0.20:
            band, mid = '13-19', 16
        elif ratio < 1.35:
            band, mid = '20-29', 25
        elif ratio < 1.42:
            band, mid = '30-39', 35
        elif ratio < 1.48:
            band, mid = '40-49', 45
        else:
            band, mid = '50+', 55
        return {'band': band, 'estimate': mid, 'method': 'heuristic'}
    except Exception:
        return None


def get_face_angle(landmarks, w, h):
    left_eye = (landmarks[33].x * w, landmarks[33].y * h)
    right_eye = (landmarks[263].x * w, landmarks[263].y * h)
    dx = right_eye[0] - left_eye[0]
    dy = right_eye[1] - left_eye[1]
    return round(math.degrees(math.atan2(dy, dx)), 2)


@app.route('/analyze', methods=['POST'])
def analyze():
    try:
        data = request.json
        if not data or 'image' not in data:
            return jsonify({'error': 'No image provided'}), 400

        img = decode_image(data['image'])
        if img is None:
            return jsonify({'error': 'Invalid image'}), 400

        h, w = img.shape[:2]
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        mesh_results = face_mesh.process(rgb)
        det_results = face_detector.process(rgb)

        faces = []
        if mesh_results.multi_face_landmarks:
            for i, face_landmarks in enumerate(mesh_results.multi_face_landmarks):
                lm = face_landmarks.landmark
                xs = [l.x * w for l in lm]
                ys = [l.y * h for l in lm]
                x1, y1 = int(min(xs)), int(min(ys))
                x2, y2 = int(max(xs)), int(max(ys))

                confidence = 0.9
                if det_results.detections and i < len(det_results.detections):
                    confidence = det_results.detections[i].score[0]

                points_68 = []
                for idx in MP_TO_68[:68]:
                    points_68.append({'x': round(lm[idx].x * w, 1), 'y': round(lm[idx].y * h, 1)})
                while len(points_68) < 68:
                    points_68.append(points_68[-1])

                mood, mood_conf = detect_mood(lm, w, h)
                age_info = estimate_age(lm, w, h)
                angle = get_face_angle(lm, w, h)

                left_ear = eye_aspect_ratio(lm, LEFT_EYE, w, h)
                right_ear = eye_aspect_ratio(lm, RIGHT_EYE, w, h)
                mouth_top = lm[13].y * h
                mouth_bottom = lm[14].y * h
                mouth_left = lm[61].x * w
                mouth_right = lm[291].x * w
                mouth_open_ratio = abs(mouth_bottom - mouth_top) / max(abs(mouth_right - mouth_left), 1)

                outer_lip_pts = [{'x': round(lm[idx].x * w, 1), 'y': round(lm[idx].y * h, 1)} for idx in OUTER_LIP_LOOP]
                inner_lip_pts = [{'x': round(lm[idx].x * w, 1), 'y': round(lm[idx].y * h, 1)} for idx in INNER_LIP_LOOP]
                left_eye_pts = [{'x': round(lm[idx].x * w, 1), 'y': round(lm[idx].y * h, 1)} for idx in LEFT_EYE]
                right_eye_pts = [{'x': round(lm[idx].x * w, 1), 'y': round(lm[idx].y * h, 1)} for idx in RIGHT_EYE]

                faces.append({
                    'boundingBox': {
                        'x': max(0, x1), 'y': max(0, y1),
                        'width': x2 - x1, 'height': y2 - y1,
                    },
                    'confidence': round(float(confidence), 2),
                    'landmarks': {
                        'points': points_68,
                        'groups': {
                            'outerLip': outer_lip_pts,
                            'innerLip': inner_lip_pts,
                            'leftEye': left_eye_pts,
                            'rightEye': right_eye_pts,
                        },
                    },
                    'mood': mood,
                    'moodConfidence': round(mood_conf, 2),
                    'age': age_info,
                    'faceAngle': angle,
                    'features': {
                        'mouthOpen': round(mouth_open_ratio, 3),
                        'leftEyeOpen': round(left_ear, 3),
                        'rightEyeOpen': round(right_ear, 3),
                        'smiling': mood == 'happy',
                    },
                })

        return jsonify({
            'faces': faces,
            'faceCount': len(faces),
            'imageSize': {'width': w, 'height': h},
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# LIGHT LANE 2: YOLOv8 (kept from previous build — nano ONNX default, upgraded
# to `yolov8s.onnx` automatically if the file is present next to nano)
# ═══════════════════════════════════════════════════════════════════════════════

YOLO_MODEL = None
YOLO_MODEL_NAME = None
YOLO_CLASSES = ['person','bicycle','car','motorcycle','airplane','bus','train','truck','boat',
    'traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse',
    'sheep','cow','elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie',
    'suitcase','frisbee','skis','snowboard','sports ball','kite','baseball bat','baseball glove',
    'skateboard','surfboard','tennis racket','bottle','wine glass','cup','fork','knife','spoon',
    'bowl','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut',
    'cake','chair','couch','potted plant','bed','dining table','toilet','tv','laptop','mouse',
    'remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator','book',
    'clock','vase','scissors','teddy bear','hair drier','toothbrush']


def load_yolo():
    """Prefer yolov8s.onnx (better mAP) if it exists, else fall back to yolov8n.

    The `s` variant is ~22 MB vs ~13 MB for nano — still trivial on 12 GB RAM
    and materially more accurate on small objects. We keep both loaders so a
    box that hasn't downloaded `s` yet keeps working with the nano weights.
    """
    global YOLO_MODEL, YOLO_MODEL_NAME
    here = os.path.dirname(__file__)
    for candidate, label in (('yolov8s.onnx', 'YOLOv8s'), ('yolov8n.onnx', 'YOLOv8n')):
        path = os.path.join(here, candidate)
        if os.path.exists(path):
            try:
                YOLO_MODEL = cv2.dnn.readNetFromONNX(path)
                YOLO_MODEL_NAME = label
                print(f'[boot] Loaded {label} from {path}')
                return
            except Exception as e:
                print(f'[boot] Failed to load {candidate}: {e}')
    print('[boot] YOLOv8 model not found (looked for yolov8s.onnx / yolov8n.onnx)')


load_yolo()


@app.route('/detect-objects', methods=['POST'])
def detect_objects():
    global YOLO_MODEL
    if YOLO_MODEL is None:
        return jsonify({'error': 'YOLOv8 model not loaded', 'objects': [], 'count': 0}), 200
    try:
        data = request.json
        if not data or 'image' not in data:
            return jsonify({'error': 'No image provided'}), 400

        img = decode_image(data['image'])
        if img is None:
            return jsonify({'error': 'Invalid image'}), 400

        h, w = img.shape[:2]
        threshold = float(data.get('threshold', 0.5))

        blob = cv2.dnn.blobFromImage(img, 1/255.0, (640, 640), swapRB=True, crop=False)
        YOLO_MODEL.setInput(blob)
        try:
            outputs = YOLO_MODEL.forward()
        except cv2.error as e:
            # Known compat issue: paddleocr pins opencv-python 4.6.0.66 but
            # YOLOv8-exported ONNX needs opencv-python ≥ 4.7 for its Reshape
            # ops. When the assertion trips, disable YOLO for the rest of
            # this process (so we don't spam the same failure) and return
            # an empty result — better than shipping the raw OpenCV trace
            # to the FE where it lands as an unhelpful red banner.
            msg = str(e)
            print(f'[yolo] forward() failed — disabling for session: {msg[:120]}')
            YOLO_MODEL = None
            return jsonify({
                'objects': [],
                'count': 0,
                'imageSize': {'width': w, 'height': h},
                'model': YOLO_MODEL_NAME,
                'skipped': 'opencv-yolo-shape-compat',
            }), 200

        out = outputs[0].T if len(outputs[0].shape) == 3 else outputs[0]
        if out.shape[0] == 84:
            out = out.T

        objects = []
        for detection in out:
            scores = detection[4:]
            class_id = int(np.argmax(scores))
            confidence = float(scores[class_id])
            if confidence < threshold:
                continue
            cx, cy, bw, bh = detection[:4]
            x1 = int((cx - bw/2) * w / 640)
            y1 = int((cy - bh/2) * h / 640)
            x2 = int((cx + bw/2) * w / 640)
            y2 = int((cy + bh/2) * h / 640)
            class_name = YOLO_CLASSES[class_id] if class_id < len(YOLO_CLASSES) else f'class_{class_id}'
            objects.append({
                'class': class_name,
                'score': round(confidence, 3),
                'bbox': [max(0, x1), max(0, y1), min(w, x2) - max(0, x1), min(h, y2) - max(0, y1)],
            })

        if objects:
            boxes = [o['bbox'] for o in objects]
            scores_list = [o['score'] for o in objects]
            indices = cv2.dnn.NMSBoxes(boxes, scores_list, threshold, 0.4)
            if len(indices) > 0:
                indices = indices.flatten() if hasattr(indices, 'flatten') else [i[0] if isinstance(i, (list, tuple)) else i for i in indices]
                objects = [objects[i] for i in indices]

        return jsonify({
            'objects': objects[:20],
            'count': len(objects),
            'imageSize': {'width': w, 'height': h},
            'model': YOLO_MODEL_NAME,
        })

    except Exception as e:
        return jsonify({'error': str(e), 'objects': [], 'count': 0}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# LIGHT LANE 3: Tesseract OCR (kept from previous build)
# ═══════════════════════════════════════════════════════════════════════════════

_TESSERACT_CHECKED = False
_TESSERACT_OK = False
_TESSERACT_ERR = None


def _check_tesseract():
    global _TESSERACT_CHECKED, _TESSERACT_OK, _TESSERACT_ERR
    if _TESSERACT_CHECKED:
        return _TESSERACT_OK
    _TESSERACT_CHECKED = True
    if not _OCR_MODULE_OK:
        _TESSERACT_ERR = f'pytesseract/Pillow not installed: {_OCR_IMPORT_ERR}'
        return False
    try:
        _ = pytesseract.get_tesseract_version()
        _TESSERACT_OK = True
        return True
    except Exception as e:
        _TESSERACT_ERR = f'tesseract binary not found on PATH: {e}'
        return False


@app.route('/ocr', methods=['POST'])
def ocr():
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        if not image_data:
            return jsonify({'error': 'No image provided', 'words': [], 'available': False}), 400
        if not _check_tesseract():
            return jsonify({
                'words': [], 'available': False,
                'warning': _TESSERACT_ERR or 'tesseract unavailable',
            })
        img = decode_image(image_data)
        if img is None:
            return jsonify({'error': 'Invalid image', 'words': [], 'available': True}), 400
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        pil = Image.fromarray(rgb)
        d = pytesseract.image_to_data(pil, output_type=pytesseract.Output.DICT)
        words = []
        n = len(d.get('text', []))
        for i in range(n):
            txt = (d['text'][i] or '').strip()
            if not txt:
                continue
            try:
                conf = int(d['conf'][i])
            except (TypeError, ValueError):
                continue
            if conf < 40:
                continue
            words.append({
                'text': txt,
                'confidence': round(conf / 100.0, 3),
                'bbox': [int(d['left'][i]), int(d['top'][i]),
                         int(d['width'][i]), int(d['height'][i])],
            })
        return jsonify({'words': words, 'available': True})
    except Exception as e:
        return jsonify({'error': str(e), 'words': [], 'available': True}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# LIGHT LANE 4: Dominant colours (kept from previous build)
# ═══════════════════════════════════════════════════════════════════════════════

def _extract_dominant_colors(bgr_img, k=6):
    small = cv2.resize(bgr_img, (64, 64), interpolation=cv2.INTER_AREA)
    Z = small.reshape(-1, 3).astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
    _, labels, centers = cv2.kmeans(Z, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.flatten()
    total = float(len(labels))
    clusters = []
    for i in range(k):
        weight = float(np.sum(labels == i)) / total if total else 0.0
        b, g, r = [int(round(v)) for v in centers[i]]
        clusters.append({
            'hex': '#{:02x}{:02x}{:02x}'.format(r, g, b),
            'rgb': [r, g, b],
            'weight': round(weight, 4),
        })
    clusters.sort(key=lambda c: c['weight'], reverse=True)
    return clusters


def _image_metadata(bgr_img):
    h, w = bgr_img.shape[:2]
    gray = cv2.cvtColor(bgr_img, cv2.COLOR_BGR2GRAY)
    mean = float(np.mean(gray))
    std = float(np.std(gray))
    return {
        'width': int(w),
        'height': int(h),
        'aspect_ratio': round(w / max(h, 1), 4),
        'avg_brightness': round(mean / 255.0, 4),
        'contrast': round(min(std / 128.0, 1.0), 4),
    }


@app.route('/dominant-colors', methods=['POST'])
def dominant_colors():
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        if not image_data:
            return jsonify({'error': 'No image provided', 'colors': []}), 400
        k = int(data.get('k', 6))
        k = max(2, min(k, 10))
        img = decode_image(image_data)
        if img is None:
            return jsonify({'error': 'Invalid image', 'colors': []}), 400
        colors = _extract_dominant_colors(img, k=k)
        return jsonify({'colors': colors, 'meta': _image_metadata(img)})
    except Exception as e:
        return jsonify({'error': str(e), 'colors': []}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# DEEP-MODEL SINGLETONS (BLIP, CLIP, InsightFace, PaddleOCR, Depth-Anything)
# ═══════════════════════════════════════════════════════════════════════════════
# Each `_LazyModel` wraps a single big model. First `.get()` triggers the load
# under a lock; every subsequent call returns the warm handle. If load fails
# we cache the error so we don't retry the download every request — an admin
# has to fix the underlying issue (missing wheel, no disk space, etc.).

class _LazyModel:
    __slots__ = ('name', 'loader', '_obj', '_err', '_lock')

    def __init__(self, name, loader):
        self.name = name
        self.loader = loader
        self._obj = None
        self._err = None
        self._lock = threading.Lock()

    def get(self):
        if self._obj is not None:
            return self._obj
        if self._err is not None:
            raise self._err
        with self._lock:
            if self._obj is not None:
                return self._obj
            if self._err is not None:
                raise self._err
            try:
                print(f'[lazy-load] {self.name} — starting (may take several minutes on first hit)')
                t0 = time.monotonic()
                self._obj = self.loader()
                print(f'[lazy-load] {self.name} — ready ({time.monotonic() - t0:.1f}s)')
                return self._obj
            except Exception as e:
                self._err = e
                print(f'[lazy-load] {self.name} — FAILED: {e}')
                raise

    @property
    def loaded(self):
        return self._obj is not None

    @property
    def error(self):
        return str(self._err) if self._err else None


# ─── BLIP-1 base — image captioning ─────────────────────────────
def _load_blip():
    if not _HAS_TRANSFORMERS or not _HAS_TORCH:
        raise RuntimeError('transformers + torch not installed')
    from transformers import BlipProcessor, BlipForConditionalGeneration
    processor = BlipProcessor.from_pretrained('Salesforce/blip-image-captioning-base')
    model = BlipForConditionalGeneration.from_pretrained('Salesforce/blip-image-captioning-base')
    model.eval()
    return {'processor': processor, 'model': model}


BLIP = _LazyModel('BLIP-1 base', _load_blip)


# ─── CLIP ViT-B/32 — zero-shot classification ────────────────────
def _load_clip():
    if not _HAS_TRANSFORMERS or not _HAS_TORCH:
        raise RuntimeError('transformers + torch not installed')
    from transformers import CLIPProcessor, CLIPModel
    processor = CLIPProcessor.from_pretrained('openai/clip-vit-base-patch32')
    model = CLIPModel.from_pretrained('openai/clip-vit-base-patch32')
    model.eval()
    return {'processor': processor, 'model': model}


CLIP = _LazyModel('CLIP ViT-B/32', _load_clip)


# ─── InsightFace buffalo_s — 512-dim face embedding + attributes ─
def _load_insightface():
    if not _HAS_INSIGHTFACE:
        raise RuntimeError('insightface not installed')
    from insightface.app import FaceAnalysis
    # buffalo_s is the smallest bundle — det10g + w600k_r50 + age/gender + landmark
    # ~150 MB total on disk. `providers=['CPUExecutionProvider']` keeps ORT off
    # any GPU that might sneak into the runtime.
    fa = FaceAnalysis(name='buffalo_s', providers=['CPUExecutionProvider'])
    fa.prepare(ctx_id=-1, det_size=(640, 640))  # ctx_id=-1 → CPU
    return fa


INSIGHT = _LazyModel('InsightFace buffalo_s', _load_insightface)


# ─── PaddleOCR PP-OCRv4 ─────────────────────────────────────────
def _load_paddle():
    if not _HAS_PADDLE:
        raise RuntimeError('paddleocr not installed')
    from paddleocr import PaddleOCR
    return PaddleOCR(use_angle_cls=True, lang='en', show_log=False)


PADDLE = _LazyModel('PaddleOCR PP-OCRv4', _load_paddle)


# ─── Depth-Anything-V2-Small ─────────────────────────────────────
def _load_depth():
    if not _HAS_TRANSFORMERS or not _HAS_TORCH:
        raise RuntimeError('transformers + torch not installed')
    from transformers import pipeline
    # `depth-estimation` pipeline auto-picks the right head + processor.
    return pipeline(task='depth-estimation', model='depth-anything/Depth-Anything-V2-Small-hf')


DEPTH = _LazyModel('Depth-Anything-V2-Small', _load_depth)


def _pil_from_bgr(bgr):
    """OpenCV BGR ndarray → PIL RGB. Every deep pipeline wants PIL RGB."""
    if Image is None:
        # Pillow only gets imported when the OCR block succeeds — but the deep
        # lanes also need it. Fall back to a direct import so an admin-only
        # Tesseract failure doesn't take down BLIP/CLIP too.
        import PIL.Image as _PILImage  # type: ignore
        return _PILImage.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    return Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))


# ═══════════════════════════════════════════════════════════════════════════════
# DEEP ENDPOINT: /caption  — BLIP-1 base
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/caption', methods=['POST'])
def caption():
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        if not image_data:
            return jsonify({'error': 'No image provided', 'available': False}), 400
        img = decode_image(image_data)
        if img is None:
            return jsonify({'error': 'Invalid image', 'available': False}), 400

        try:
            b = BLIP.get()
        except Exception as e:
            return jsonify({'available': False, 'warning': f'BLIP unavailable: {e}',
                            'caption': '', 'confidence': 0.0})

        import torch  # local import — module-level `_HAS_TORCH` already verified
        pil = _pil_from_bgr(img)
        inputs = b['processor'](images=pil, return_tensors='pt')
        # `generate` returns token IDs; we don't get per-token probs by default,
        # but `output_scores=True` gives us the logits so we can approximate
        # a per-caption confidence (mean softmax of top token at each step).
        with torch.no_grad():
            out = b['model'].generate(
                **inputs, max_new_tokens=32, num_beams=3,
                return_dict_in_generate=True, output_scores=True,
            )
        text = b['processor'].decode(out.sequences[0], skip_special_tokens=True).strip()

        # Confidence proxy — mean of the max softmax value at each generation
        # step. Beam search returns scores per beam; we take the winning beam
        # (index 0). Clamp to [0, 1] just in case of numerical wobble.
        confidence = 0.0
        try:
            if out.scores:
                probs = [torch.softmax(step[0], dim=-1).max().item() for step in out.scores]
                if probs:
                    confidence = float(sum(probs) / len(probs))
                    confidence = max(0.0, min(1.0, confidence))
        except Exception:
            confidence = 0.0

        return jsonify({
            'caption': text,
            'confidence': round(confidence, 3),
            'available': True,
            'model': 'BLIP-1 base',
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'caption': '', 'available': True}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# DEEP ENDPOINT: /clip-tags  — CLIP zero-shot classification
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/clip-tags', methods=['POST'])
def clip_tags():
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        raw_labels = data.get('labels') or []
        top_k = int(data.get('top_k', 5))
        if not image_data:
            return jsonify({'error': 'No image provided', 'available': False}), 400
        if not isinstance(raw_labels, list) or not raw_labels:
            return jsonify({'error': 'Provide a non-empty labels[] array', 'available': True}), 400

        img = decode_image(image_data)
        if img is None:
            return jsonify({'error': 'Invalid image', 'available': False}), 400

        try:
            c = CLIP.get()
        except Exception as e:
            return jsonify({'available': False, 'warning': f'CLIP unavailable: {e}', 'tags': []})

        import torch
        pil = _pil_from_bgr(img)
        # Prepend "a photo of" — CLIP was trained with this template and scores
        # much better with it. Callers can pass their own already-templated
        # strings if they want; we detect that heuristically (contains a space).
        prompts = [str(l).strip() for l in raw_labels if l]
        prompts = [p if ' ' in p else f'a photo of {p}' for p in prompts]

        inputs = c['processor'](text=prompts, images=pil, return_tensors='pt', padding=True)
        with torch.no_grad():
            out = c['model'](**inputs)
            # logits_per_image: (1, N_labels). Softmax across labels → prob mass.
            probs = out.logits_per_image.softmax(dim=1)[0].tolist()

        # Zip back the ORIGINAL labels (not the "a photo of" prompt), sort by score.
        pairs = list(zip([str(l).strip() for l in raw_labels], probs))
        pairs.sort(key=lambda p: p[1], reverse=True)
        top_k = max(1, min(top_k, len(pairs)))
        return jsonify({
            'tags': [{'label': lbl, 'score': round(float(s), 4)} for lbl, s in pairs[:top_k]],
            'available': True,
            'model': 'CLIP ViT-B/32',
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'tags': [], 'available': True}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# DEEP ENDPOINT: /face-embed  — InsightFace buffalo_s
# ═══════════════════════════════════════════════════════════════════════════════

def _insight_face_records(img_bgr):
    """Return list of raw InsightFace Face records. Loads the model lazily."""
    fa = INSIGHT.get()
    return fa.get(img_bgr)


def _serialise_face(f, include_embedding=True):
    """Convert an InsightFace Face → JSON-safe dict."""
    def _f(v):
        try:
            return float(v)
        except Exception:
            return 0.0

    bbox = getattr(f, 'bbox', None)
    kps = getattr(f, 'kps', None)
    emb = getattr(f, 'normed_embedding', None)
    if emb is None:
        emb = getattr(f, 'embedding', None)
    gender = getattr(f, 'gender', None)
    age = getattr(f, 'age', None)

    return {
        'bbox': [int(round(_f(x))) for x in (bbox if bbox is not None else [0, 0, 0, 0])],
        'landmarks_5pt': [[_f(x), _f(y)] for x, y in (kps if kps is not None else [])],
        'age': int(round(_f(age))) if age is not None else None,
        # InsightFace gender is 0=F, 1=M
        'gender': 'M' if gender == 1 else ('F' if gender == 0 else None),
        'det_score': round(_f(getattr(f, 'det_score', 0)), 3),
        'embedding_dim': int(len(emb)) if emb is not None else 0,
        # Only ship the raw 512-dim vector when the caller wants it — it's
        # ~2 KB of JSON per face which bloats the omnibus response.
        'embedding': [round(_f(v), 6) for v in emb] if (include_embedding and emb is not None) else None,
    }


@app.route('/face-embed', methods=['POST'])
def face_embed():
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        include_embedding = bool(data.get('include_embedding', True))
        if not image_data:
            return jsonify({'error': 'No image provided', 'available': False}), 400
        img = decode_image(image_data)
        if img is None:
            return jsonify({'error': 'Invalid image', 'available': False}), 400

        try:
            faces_raw = _insight_face_records(img)
        except Exception as e:
            return jsonify({'available': False, 'warning': f'InsightFace unavailable: {e}',
                            'faces': [], 'faceCount': 0})

        faces = [_serialise_face(f, include_embedding=include_embedding) for f in faces_raw]
        return jsonify({
            'faces': faces,
            'faceCount': len(faces),
            'available': True,
            'model': 'InsightFace buffalo_s',
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'faces': [], 'available': True}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# DEEP ENDPOINT: /face-verify  — cosine similarity on two face embeddings
# ═══════════════════════════════════════════════════════════════════════════════

def _cosine(a, b):
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# 0.5 is the InsightFace-recommended threshold for buffalo family models
# (arcface cosine sim). Above → same person; below → different.
FACE_VERIFY_THRESHOLD = 0.5


@app.route('/face-verify', methods=['POST'])
def face_verify():
    try:
        data = request.get_json(silent=True) or {}
        image_a = data.get('imageA') or data.get('image_a') or data.get('image1')
        image_b = data.get('imageB') or data.get('image_b') or data.get('image2')
        threshold = float(data.get('threshold', FACE_VERIFY_THRESHOLD))

        if not image_a or not image_b:
            return jsonify({'error': 'Provide imageA and imageB', 'available': True}), 400
        a = decode_image(image_a)
        b = decode_image(image_b)
        if a is None or b is None:
            return jsonify({'error': 'Invalid image(s)', 'available': True}), 400

        try:
            fa = _insight_face_records(a)
            fb = _insight_face_records(b)
        except Exception as e:
            return jsonify({'available': False, 'warning': f'InsightFace unavailable: {e}',
                            'same_person': False, 'similarity': 0.0, 'threshold': threshold})

        if not fa or not fb:
            return jsonify({
                'available': True,
                'same_person': False,
                'similarity': 0.0,
                'threshold': threshold,
                'warning': f'No face detected in image{"A" if not fa else "B"}',
                'facesA': len(fa), 'facesB': len(fb),
            })

        # Highest-confidence face per image. If a caller wants a specific pair
        # they should crop the source image before uploading.
        top_a = max(fa, key=lambda f: getattr(f, 'det_score', 0))
        top_b = max(fb, key=lambda f: getattr(f, 'det_score', 0))
        emb_a = getattr(top_a, 'normed_embedding', None) or getattr(top_a, 'embedding', None)
        emb_b = getattr(top_b, 'normed_embedding', None) or getattr(top_b, 'embedding', None)
        if emb_a is None or emb_b is None:
            return jsonify({
                'available': True, 'same_person': False, 'similarity': 0.0,
                'threshold': threshold, 'warning': 'Face has no embedding',
            })

        sim = _cosine(emb_a, emb_b)
        return jsonify({
            'available': True,
            'same_person': bool(sim >= threshold),
            'similarity': round(sim, 4),
            'threshold': threshold,
            'facesA': len(fa),
            'facesB': len(fb),
            'model': 'InsightFace buffalo_s',
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'available': True}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# DEEP ENDPOINT: /paddle-ocr  — PaddleOCR PP-OCRv4
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/paddle-ocr', methods=['POST'])
def paddle_ocr():
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        if not image_data:
            return jsonify({'error': 'No image provided', 'available': False}), 400
        img = decode_image(image_data)
        if img is None:
            return jsonify({'error': 'Invalid image', 'available': False}), 400

        try:
            ocr_engine = PADDLE.get()
        except Exception as e:
            return jsonify({'available': False, 'warning': f'PaddleOCR unavailable: {e}',
                            'words': []})

        # PaddleOCR accepts a numpy array (BGR or RGB — it handles both).
        raw = ocr_engine.ocr(img, cls=True)
        # Raw shape (PaddleOCR 2.7): [[ [ [ [x,y]*4 ], (text, conf) ], ... ]]
        words = []
        # `raw` is a list per image; we always pass a single image so index [0].
        page = raw[0] if raw and raw[0] is not None else []
        for line in page:
            try:
                pts = line[0]
                text, conf = line[1]
                text = str(text).strip()
                if not text:
                    continue
                bbox_4pt = [[float(x), float(y)] for x, y in pts]
                words.append({
                    'text': text,
                    'confidence': round(float(conf), 4),
                    'bbox_4pt': bbox_4pt,
                })
            except Exception:
                continue

        return jsonify({
            'words': words,
            'count': len(words),
            'available': True,
            'model': 'PaddleOCR PP-OCRv4',
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'words': [], 'available': True}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# DEEP ENDPOINT: /depth-map  — Depth-Anything-V2-Small
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/depth-map', methods=['POST'])
def depth_map():
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        if not image_data:
            return jsonify({'error': 'No image provided', 'available': False}), 400
        img = decode_image(image_data)
        if img is None:
            return jsonify({'error': 'Invalid image', 'available': False}), 400

        try:
            depth_pipeline = DEPTH.get()
        except Exception as e:
            return jsonify({'available': False, 'warning': f'Depth-Anything unavailable: {e}',
                            'depth_url': None, 'stats': None})

        pil = _pil_from_bgr(img)
        result = depth_pipeline(pil)
        # `pipeline('depth-estimation')` returns { 'predicted_depth': tensor,
        # 'depth': PIL grayscale image }. We serve the PIL image as a PNG
        # data URL and hand back the raw tensor stats.
        import torch
        depth_tensor = result.get('predicted_depth')
        if depth_tensor is not None:
            arr = depth_tensor.detach().cpu().numpy()
            stats = {
                'min': round(float(arr.min()), 4),
                'max': round(float(arr.max()), 4),
                'mean': round(float(arr.mean()), 4),
                'std': round(float(arr.std()), 4),
            }
        else:
            stats = None

        # PNG-encode the greyscale depth preview.
        depth_img = result.get('depth')
        preview_url = None
        if depth_img is not None:
            buf = io.BytesIO()
            depth_img.save(buf, format='PNG')
            b64 = base64.b64encode(buf.getvalue()).decode('ascii')
            preview_url = f'data:image/png;base64,{b64}'

        return jsonify({
            'depth_url': preview_url,
            'stats': stats,
            'available': True,
            'model': 'Depth-Anything-V2-Small',
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'depth_url': None, 'available': True}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# /extract-subject — isolate dark ink / dark subject from background.
#
# Pure OpenCV (no torch / no extra weights) — tuned for tattoo photos where
# a dark subject sits on lighter skin under uneven lighting. Returns a 1-bit
# alpha mask (downsampled to fit 256×256) plus a bbox / centroid / coverage
# and an RGBA thumbnail of the source cropped to the subject.
#
# Modes:
#   • auto  (default) — adaptive threshold + morphology + largest CC.
#   • dark            — Otsu inverse threshold (aggressive; grabs anything
#                       darker than the frame average).
#   • depth           — uses Depth-Anything if loaded: pixels closer than
#                       the median depth become the subject. Falls back to
#                       `auto` if the depth model isn't loaded.
#
# The FE uses the mask to (a) constrain QR module rendering to the subject
# silhouette, and (b) drive a height map for a 3D scene, so the response is
# aggressively downsampled to keep the data URL small (~4-8 KB).
# ═══════════════════════════════════════════════════════════════════════════════

_EXTRACT_MASK_MAX = 256    # cap mask edge — keeps the PNG data URL small
_EXTRACT_THUMB_MAX = 512   # cap the RGBA subject thumbnail edge


def _extract_auto(img_bgr):
    """Adaptive threshold + morphology — the tattoo default."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    smooth = cv2.bilateralFilter(gray, 9, 75, 75)
    binary = cv2.adaptiveThreshold(
        smooth, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV,
        blockSize=41, C=8,
    )
    kernel3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel3)
    kernel7 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel7)
    return _keep_largest_cc(binary)


def _extract_dark(img_bgr):
    """Otsu inverse — grabs anything darker than the mean.

    More aggressive than `auto`; useful when the subject is a solid dark
    shape (silhouette / logo) rather than fine ink strokes.
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    smooth = cv2.GaussianBlur(gray, (5, 5), 0)
    _, binary = cv2.threshold(
        smooth, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU,
    )
    kernel5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel5)
    return _keep_largest_cc(binary)


def _extract_depth(img_bgr):
    """Depth-Anything median split — subject = closer than median depth.

    Returns None if the depth model isn't loaded; caller should fall back
    to `auto`.
    """
    try:
        depth_pipeline = DEPTH.get()
    except Exception:
        return None
    if depth_pipeline is None:
        return None
    try:
        import torch  # noqa: F401 — needed for tensor ops below
        pil = _pil_from_bgr(img_bgr)
        result = depth_pipeline(pil)
        depth_tensor = result.get('predicted_depth')
        if depth_tensor is None:
            return None
        arr = depth_tensor.detach().cpu().numpy()
        # Resize depth to source resolution so the mask lines up.
        h, w = img_bgr.shape[:2]
        depth = cv2.resize(arr, (w, h), interpolation=cv2.INTER_LINEAR)
        # Depth-Anything convention: LARGER value = CLOSER. Take everything
        # above the median as the subject.
        thresh = float(np.median(depth))
        binary = np.where(depth > thresh, 255, 0).astype(np.uint8)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
        return _keep_largest_cc(binary)
    except Exception:
        traceback.print_exc()
        return None


def _keep_largest_cc(binary):
    """Drop border noise / speckles — keep only the biggest blob."""
    num, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if num <= 1:
        return binary
    areas = stats[1:, cv2.CC_STAT_AREA]
    biggest = 1 + int(np.argmax(areas))
    return np.where(labels == biggest, 255, 0).astype(np.uint8)


def _mask_stats(mask):
    """Compute bbox / centroid / coverage from a uint8 {0, 255} mask.

    Returns bbox as [x, y, w, h] in mask coords, centroid as [cx, cy],
    coverage as fraction 0..1. All zero when the mask is empty.
    """
    ys, xs = np.where(mask > 0)
    if xs.size == 0:
        return {
            'bbox': [0, 0, 0, 0],
            'centroid': [0, 0],
            'coverage': 0.0,
        }
    x1, x2 = int(xs.min()), int(xs.max())
    y1, y2 = int(ys.min()), int(ys.max())
    bw, bh = x2 - x1 + 1, y2 - y1 + 1
    cx = int(round(float(xs.mean())))
    cy = int(round(float(ys.mean())))
    coverage = float(mask.sum()) / float(mask.size * 255)
    return {
        'bbox': [x1, y1, bw, bh],
        'centroid': [cx, cy],
        'coverage': round(coverage, 4),
    }


def _png_data_url(arr, mode='L'):
    """Encode a numpy array as a PNG data URL. mode 'L' = grayscale, 'RGBA' = 4ch."""
    if Image is None:
        import PIL.Image as _PILImage  # type: ignore
        pil = _PILImage.fromarray(arr, mode=mode)
    else:
        pil = Image.fromarray(arr, mode=mode)
    buf = io.BytesIO()
    pil.save(buf, format='PNG', optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    return f'data:image/png;base64,{b64}'


def _downsample_for_wire(mask, max_edge):
    """Resize a binary mask to fit inside `max_edge×max_edge` while preserving aspect.

    Uses nearest-neighbour so the mask stays crisp (no grey fringe).
    """
    h, w = mask.shape[:2]
    if max(h, w) <= max_edge:
        return mask
    scale = max_edge / float(max(h, w))
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return cv2.resize(mask, (new_w, new_h), interpolation=cv2.INTER_NEAREST)


def _subject_thumbnail(img_bgr, mask_full, bbox):
    """Crop source to bbox, apply mask as alpha, cap edge at _EXTRACT_THUMB_MAX.

    Returns a PNG data URL (RGBA) — the FE renders this as a "hero" preview
    of what was extracted. Empty bbox → returns None.
    """
    x, y, bw, bh = bbox
    if bw <= 0 or bh <= 0:
        return None
    crop_bgr = img_bgr[y:y + bh, x:x + bw]
    crop_mask = mask_full[y:y + bh, x:x + bw]
    # Cap the thumbnail — use min(bbox * 2, 512) as the ceiling so tiny subjects
    # still ship a usable preview, and huge ones don't blow up the response.
    max_edge = min(max(bw, bh) * 2, _EXTRACT_THUMB_MAX)
    if max(bw, bh) > max_edge:
        scale = max_edge / float(max(bw, bh))
        new_w = max(1, int(round(bw * scale)))
        new_h = max(1, int(round(bh * scale)))
        crop_bgr = cv2.resize(crop_bgr, (new_w, new_h), interpolation=cv2.INTER_AREA)
        crop_mask = cv2.resize(crop_mask, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
    # Build RGBA — BGR → RGB, then stack the mask as alpha.
    rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
    rgba = np.dstack([rgb, crop_mask])
    return _png_data_url(rgba, mode='RGBA')


@app.route('/extract-subject', methods=['POST'])
def extract_subject():
    started = time.monotonic()
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        if not image_data:
            return jsonify({'ok': False, 'error': 'No image provided'}), 400

        img = decode_image(image_data)
        if img is None:
            return jsonify({'ok': False, 'error': 'Invalid image'}), 400

        mode = str(data.get('mode') or 'auto').lower()
        if mode not in ('auto', 'dark', 'depth'):
            mode = 'auto'

        backend = None
        if mode == 'depth':
            mask_full = _extract_depth(img)
            if mask_full is None:
                # Depth-Anything not loaded → fall back to auto.
                mask_full = _extract_auto(img)
                backend = 'opencv-adaptive (depth-fallback)'
            else:
                backend = 'depth-anything-median'
        elif mode == 'dark':
            mask_full = _extract_dark(img)
            backend = 'opencv-otsu'
        else:
            mask_full = _extract_auto(img)
            backend = 'opencv-adaptive'

        if mask_full is None or mask_full.size == 0:
            return jsonify({'ok': False, 'error': 'Extraction produced an empty mask'}), 500

        # Stats are computed on the FULL-RES mask so bbox / centroid are in
        # source pixel coordinates.
        full_stats = _mask_stats(mask_full)

        # Thumbnail also uses the FULL-RES mask + source, so the RGBA preview
        # retains detail even after the wire mask is downsampled.
        thumbnail_url = _subject_thumbnail(img, mask_full, full_stats['bbox'])

        # Downsample the wire mask so the response stays small.
        wire_mask = _downsample_for_wire(mask_full, _EXTRACT_MASK_MAX)
        wire_stats = _mask_stats(wire_mask)
        png_url = _png_data_url(wire_mask, mode='L')

        elapsed = int((time.monotonic() - started) * 1000)
        h, w = img.shape[:2]

        return jsonify({
            'ok': True,
            'mask': {
                'png_data_url': png_url,
                'coverage': wire_stats['coverage'],
                'bbox': wire_stats['bbox'],       # bbox in mask (downsampled) coords
                'centroid': wire_stats['centroid'],
                'width': int(wire_mask.shape[1]),
                'height': int(wire_mask.shape[0]),
            },
            'source_bbox': full_stats['bbox'],    # bbox in original source coords
            'source_centroid': full_stats['centroid'],
            'source_size': {'width': w, 'height': h},
            'subject_thumbnail_url': thumbnail_url,
            'backend': backend,
            'mode': mode,
            'elapsed_ms': elapsed,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({
            'ok': False,
            'error': str(e),
            'elapsed_ms': int((time.monotonic() - started) * 1000),
        }), 500


# ═══════════════════════════════════════════════════════════════════════════════
# INTERNAL HELPERS — reused by /vision-analyze and /vision-deep omnibuses
# ═══════════════════════════════════════════════════════════════════════════════

def _run_face_analysis_light(img):
    h, w = img.shape[:2]
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mesh_results = face_mesh.process(rgb)
    det_results = face_detector.process(rgb)

    faces = []
    if mesh_results.multi_face_landmarks:
        for i, face_landmarks in enumerate(mesh_results.multi_face_landmarks):
            lm = face_landmarks.landmark
            xs = [l.x * w for l in lm]
            ys = [l.y * h for l in lm]
            x1, y1 = int(min(xs)), int(min(ys))
            x2, y2 = int(max(xs)), int(max(ys))
            confidence = 0.9
            if det_results.detections and i < len(det_results.detections):
                confidence = det_results.detections[i].score[0]
            points_68 = []
            for idx in MP_TO_68[:68]:
                points_68.append({'x': round(lm[idx].x * w, 1), 'y': round(lm[idx].y * h, 1)})
            while len(points_68) < 68:
                points_68.append(points_68[-1])
            mood, mood_conf = detect_mood(lm, w, h)
            angle = get_face_angle(lm, w, h)
            faces.append({
                'boundingBox': {'x': max(0, x1), 'y': max(0, y1),
                                'width': x2 - x1, 'height': y2 - y1},
                'confidence': round(float(confidence), 3),
                'landmarks': {'points': points_68},
                'mood': mood,
                'moodConfidence': round(mood_conf, 2),
                'faceAngle': angle,
            })
    return {'faces': faces, 'faceCount': len(faces),
            'imageSize': {'width': w, 'height': h}}


def _run_object_detection(img, threshold=0.5):
    if YOLO_MODEL is None:
        return {'objects': [], 'count': 0, 'available': False,
                'warning': 'YOLOv8 model not loaded'}
    h, w = img.shape[:2]
    blob = cv2.dnn.blobFromImage(img, 1/255.0, (640, 640), swapRB=True, crop=False)
    YOLO_MODEL.setInput(blob)
    outputs = YOLO_MODEL.forward()
    out = outputs[0].T if len(outputs[0].shape) == 3 else outputs[0]
    if out.shape[0] == 84:
        out = out.T
    objects = []
    for detection in out:
        scores = detection[4:]
        class_id = int(np.argmax(scores))
        confidence = float(scores[class_id])
        if confidence < threshold:
            continue
        cx, cy, bw, bh = detection[:4]
        x1 = int((cx - bw/2) * w / 640)
        y1 = int((cy - bh/2) * h / 640)
        x2 = int((cx + bw/2) * w / 640)
        y2 = int((cy + bh/2) * h / 640)
        class_name = YOLO_CLASSES[class_id] if class_id < len(YOLO_CLASSES) else f'class_{class_id}'
        objects.append({
            'label': class_name,
            'confidence': round(confidence, 3),
            'bbox': [max(0, x1), max(0, y1), min(w, x2) - max(0, x1), min(h, y2) - max(0, y1)],
        })
    if objects:
        boxes = [o['bbox'] for o in objects]
        scores_list = [o['confidence'] for o in objects]
        indices = cv2.dnn.NMSBoxes(boxes, scores_list, threshold, 0.4)
        if len(indices) > 0:
            indices = indices.flatten() if hasattr(indices, 'flatten') else [i[0] if isinstance(i, (list, tuple)) else i for i in indices]
            objects = [objects[i] for i in indices]
    return {'objects': objects[:20], 'count': len(objects), 'available': True,
            'model': YOLO_MODEL_NAME}


def _run_ocr_tesseract(img):
    if not _check_tesseract():
        return {'words': [], 'available': False,
                'warning': _TESSERACT_ERR or 'tesseract unavailable'}
    try:
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        pil = Image.fromarray(rgb)
        d = pytesseract.image_to_data(pil, output_type=pytesseract.Output.DICT)
        words = []
        n = len(d.get('text', []))
        for i in range(n):
            txt = (d['text'][i] or '').strip()
            if not txt:
                continue
            try:
                conf = int(d['conf'][i])
            except (TypeError, ValueError):
                continue
            if conf < 40:
                continue
            words.append({
                'text': txt,
                'confidence': round(conf / 100.0, 3),
                'bbox': [int(d['left'][i]), int(d['top'][i]),
                         int(d['width'][i]), int(d['height'][i])],
            })
        return {'words': words, 'available': True}
    except Exception as e:
        return {'words': [], 'available': True, 'warning': f'ocr failed: {e}'}


# ═══════════════════════════════════════════════════════════════════════════════
# /vision-analyze  — LIGHT omnibus (unchanged from prev build)
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/vision-analyze', methods=['POST'])
def vision_analyze():
    started = time.monotonic()
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        if not image_data:
            return jsonify({'ok': False, 'error': 'No image provided'}), 400
        img = decode_image(image_data)
        if img is None:
            return jsonify({'ok': False, 'error': 'Invalid image'}), 400
        threshold = float(data.get('threshold', 0.5))
        k = int(data.get('k', 6))
        k = max(2, min(k, 10))

        warnings = []
        try:
            face_out = _run_face_analysis_light(img)
        except Exception as e:
            face_out = {'faces': [], 'faceCount': 0}
            warnings.append(f'faces: {e}')
        try:
            obj_out = _run_object_detection(img, threshold=threshold)
            if obj_out.get('warning'):
                warnings.append(f'objects: {obj_out["warning"]}')
        except Exception as e:
            obj_out = {'objects': [], 'count': 0, 'available': False}
            warnings.append(f'objects: {e}')
        try:
            ocr_out = _run_ocr_tesseract(img)
            if ocr_out.get('warning'):
                warnings.append(f'ocr: {ocr_out["warning"]}')
        except Exception as e:
            ocr_out = {'words': [], 'available': False}
            warnings.append(f'ocr: {e}')
        try:
            colors = _extract_dominant_colors(img, k=k)
        except Exception as e:
            colors = []
            warnings.append(f'colors: {e}')
        try:
            meta = _image_metadata(img)
        except Exception as e:
            meta = {}
            warnings.append(f'meta: {e}')

        return jsonify({
            'ok': True,
            'faces': face_out.get('faces', []),
            'faceCount': face_out.get('faceCount', 0),
            'objects': obj_out.get('objects', []),
            'objectCount': obj_out.get('count', 0),
            'text': ocr_out.get('words', []),
            'ocr_available': ocr_out.get('available', False),
            'dominant_colors': colors,
            'meta': meta,
            'warnings': warnings,
            'elapsedMs': int((time.monotonic() - started) * 1000),
        })
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# /vision-deep  — DEEP omnibus: caption + CLIP tags + faces + objects + OCR
#                 + dominant colours + depth-map preview + meta
# ═══════════════════════════════════════════════════════════════════════════════

# Default CLIP label list — the Node BE can override via `labels[]`. Kept broad
# so it works as a "figure out what kind of image this is" tagger out of the box.
DEFAULT_CLIP_LABELS = [
    'portrait photograph', 'landscape photograph', 'street photography',
    'macro photograph', 'food photograph', 'product photograph',
    'painting', 'illustration', 'digital art', 'sketch',
    'tattoo art', 'graffiti', 'poster', 'screenshot', 'meme',
    'indoor scene', 'outdoor scene', 'night scene',
    'warm colour palette', 'cool colour palette', 'monochrome',
    'happy vibe', 'moody vibe', 'romantic vibe', 'aggressive vibe',
]


def _aesthetic_summary(bgr_img, dominant):
    """Cheap heuristic aesthetic tags derived from HSV + palette."""
    try:
        hsv = cv2.cvtColor(bgr_img, cv2.COLOR_BGR2HSV)
        h_mean = float(hsv[:, :, 0].mean())
        s_mean = float(hsv[:, :, 1].mean()) / 255.0
        v_mean = float(hsv[:, :, 2].mean()) / 255.0
        # OpenCV hue is 0-179; wrap into "warm" (red/yellow/orange) vs "cool" (green/blue).
        # Warm ≈ [0..30] ∪ [150..179]; cool ≈ [30..150] roughly.
        if h_mean < 30 or h_mean > 150:
            vibe = 'warm'
        else:
            vibe = 'cool'
        # If saturation is very low regardless of hue, call it neutral/mono.
        if s_mean < 0.15:
            vibe = 'neutral'
        return {
            'vibe': vibe,
            'brightness': round(v_mean, 3),
            'saturation': round(s_mean, 3),
        }
    except Exception:
        return {'vibe': 'neutral', 'brightness': 0.5, 'saturation': 0.5}


def _run_caption(img):
    try:
        b = BLIP.get()
    except Exception as e:
        return {'available': False, 'warning': f'BLIP unavailable: {e}',
                'caption': '', 'confidence': 0.0}
    try:
        import torch
        pil = _pil_from_bgr(img)
        inputs = b['processor'](images=pil, return_tensors='pt')
        with torch.no_grad():
            out = b['model'].generate(
                **inputs, max_new_tokens=32, num_beams=3,
                return_dict_in_generate=True, output_scores=True,
            )
        text = b['processor'].decode(out.sequences[0], skip_special_tokens=True).strip()
        conf = 0.0
        try:
            if out.scores:
                probs = [torch.softmax(step[0], dim=-1).max().item() for step in out.scores]
                if probs:
                    conf = float(sum(probs) / len(probs))
                    conf = max(0.0, min(1.0, conf))
        except Exception:
            conf = 0.0
        return {'available': True, 'caption': text, 'confidence': round(conf, 3)}
    except Exception as e:
        return {'available': True, 'warning': f'caption failed: {e}',
                'caption': '', 'confidence': 0.0}


def _run_clip(img, labels, top_k=8):
    try:
        c = CLIP.get()
    except Exception as e:
        return {'available': False, 'warning': f'CLIP unavailable: {e}', 'tags': []}
    try:
        import torch
        pil = _pil_from_bgr(img)
        prompts = [p if ' ' in p else f'a photo of {p}' for p in labels]
        inputs = c['processor'](text=prompts, images=pil, return_tensors='pt', padding=True)
        with torch.no_grad():
            out = c['model'](**inputs)
            probs = out.logits_per_image.softmax(dim=1)[0].tolist()
        pairs = list(zip(labels, probs))
        pairs.sort(key=lambda p: p[1], reverse=True)
        top_k = max(1, min(top_k, len(pairs)))
        return {
            'available': True,
            'tags': [{'label': lbl, 'score': round(float(s), 4)} for lbl, s in pairs[:top_k]],
        }
    except Exception as e:
        return {'available': True, 'warning': f'clip failed: {e}', 'tags': []}


def _run_insightface(img, include_embedding=False):
    try:
        raw = _insight_face_records(img)
    except Exception as e:
        return {'available': False, 'warning': f'InsightFace unavailable: {e}',
                'faces': [], 'faceCount': 0}
    faces = [_serialise_face(f, include_embedding=include_embedding) for f in raw]
    return {'available': True, 'faces': faces, 'faceCount': len(faces)}


def _run_paddle(img):
    try:
        eng = PADDLE.get()
    except Exception as e:
        return {'available': False, 'warning': f'PaddleOCR unavailable: {e}', 'words': []}
    try:
        raw = eng.ocr(img, cls=True)
        page = raw[0] if raw and raw[0] is not None else []
        words = []
        for line in page:
            try:
                pts = line[0]
                text, conf = line[1]
                text = str(text).strip()
                if not text:
                    continue
                # Convert 4-pt polygon to bbox-style [x, y, w, h] for FE compat,
                # keep 4pt in a separate field for callers that want the exact
                # rotated rectangle.
                xs = [float(x) for x, _ in pts]
                ys = [float(y) for _, y in pts]
                x, y = int(min(xs)), int(min(ys))
                w, h = int(max(xs) - x), int(max(ys) - y)
                words.append({
                    'text': text,
                    'confidence': round(float(conf), 4),
                    'bbox': [x, y, w, h],
                    'bbox_4pt': [[float(px), float(py)] for px, py in pts],
                })
            except Exception:
                continue
        return {'available': True, 'words': words}
    except Exception as e:
        return {'available': True, 'warning': f'paddle failed: {e}', 'words': []}


def _run_depth(img):
    try:
        pipe = DEPTH.get()
    except Exception as e:
        return {'available': False, 'warning': f'Depth-Anything unavailable: {e}',
                'preview_url': None, 'stats': None}
    try:
        pil = _pil_from_bgr(img)
        result = pipe(pil)
        stats = None
        depth_tensor = result.get('predicted_depth')
        if depth_tensor is not None:
            arr = depth_tensor.detach().cpu().numpy()
            stats = {
                'min': round(float(arr.min()), 4),
                'max': round(float(arr.max()), 4),
                'mean': round(float(arr.mean()), 4),
            }
        depth_img = result.get('depth')
        preview_url = None
        if depth_img is not None:
            # Downsize the preview aggressively — a 4K depth PNG bloats the
            # response body to > 2 MB. 512px on the long edge is plenty for a
            # UI thumbnail.
            w, h = depth_img.size
            long_edge = max(w, h)
            if long_edge > 512:
                scale = 512.0 / long_edge
                new_size = (int(round(w * scale)), int(round(h * scale)))
                depth_img = depth_img.resize(new_size)
            buf = io.BytesIO()
            depth_img.save(buf, format='PNG')
            b64 = base64.b64encode(buf.getvalue()).decode('ascii')
            preview_url = f'data:image/png;base64,{b64}'
        return {'available': True, 'preview_url': preview_url, 'stats': stats}
    except Exception as e:
        return {'available': True, 'warning': f'depth failed: {e}',
                'preview_url': None, 'stats': None}


@app.route('/vision-deep', methods=['POST'])
def vision_deep():
    """Omnibus: caption + CLIP tags + faces (InsightFace) + objects + OCR
    (PaddleOCR first, Tesseract fallback) + palette + depth-map + meta.

    Query params (JSON):
      • image (required)          base64 or data-URI
      • labels[]                  override CLIP label list (else DEFAULT_CLIP_LABELS)
      • top_k                     CLIP top-K, default 8
      • threshold                 YOLO min score, default 0.5
      • k                         k-means K, default 6
      • include_embedding         face embedding vector in response, default false
      • skip                      list of lanes to skip (e.g. ['depth','caption'])

    Any lane that fails degrades to `{ available: false, warning }` in its
    subsection — the response body is always 200 unless the image itself is
    invalid.
    """
    started = time.monotonic()
    warnings = []
    models_used = []

    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        if not image_data:
            return jsonify({'ok': False, 'error': 'No image provided'}), 400
        img = decode_image(image_data)
        if img is None:
            return jsonify({'ok': False, 'error': 'Invalid image'}), 400

        threshold = float(data.get('threshold', 0.5))
        k = int(data.get('k', 6))
        k = max(2, min(k, 10))
        top_k = int(data.get('top_k', 8))
        include_embedding = bool(data.get('include_embedding', False))
        labels = data.get('labels') or DEFAULT_CLIP_LABELS
        if not isinstance(labels, list) or not labels:
            labels = DEFAULT_CLIP_LABELS
        skip = set(data.get('skip') or [])

        # ── LIGHT LANES ────────────────────────────────────────────
        try:
            obj_out = _run_object_detection(img, threshold=threshold)
            if obj_out.get('warning'):
                warnings.append(f'objects: {obj_out["warning"]}')
            elif obj_out.get('available'):
                models_used.append(obj_out.get('model') or 'YOLOv8')
        except Exception as e:
            obj_out = {'objects': [], 'count': 0}
            warnings.append(f'objects: {e}')

        try:
            colors = _extract_dominant_colors(img, k=k)
        except Exception as e:
            colors = []
            warnings.append(f'colors: {e}')

        try:
            meta = _image_metadata(img)
        except Exception as e:
            meta = {}
            warnings.append(f'meta: {e}')

        aesthetic = _aesthetic_summary(img, colors)

        # ── DEEP LANES ─────────────────────────────────────────────
        # Caption (BLIP)
        if 'caption' not in skip:
            cap = _run_caption(img)
            if cap.get('warning'):
                warnings.append(f'caption: {cap["warning"]}')
            if cap.get('available') and cap.get('caption'):
                models_used.append('BLIP-1 base')
        else:
            cap = {'available': False, 'caption': '', 'confidence': 0.0}

        # CLIP zero-shot tags
        if 'clip' not in skip:
            clip_out = _run_clip(img, labels, top_k=top_k)
            if clip_out.get('warning'):
                warnings.append(f'clip: {clip_out["warning"]}')
            if clip_out.get('available') and clip_out.get('tags'):
                models_used.append('CLIP ViT-B/32')
        else:
            clip_out = {'available': False, 'tags': []}

        # Faces — try InsightFace first, fall back to MediaPipe light.
        if 'faces' not in skip:
            ifaces = _run_insightface(img, include_embedding=include_embedding)
            if ifaces.get('available'):
                faces_payload = ifaces
                models_used.append('InsightFace buffalo_s')
            else:
                warnings.append(f'insightface: {ifaces.get("warning", "unavailable")}')
                # Fall back to MediaPipe for landmarks — still gives us faces.
                try:
                    light = _run_face_analysis_light(img)
                    faces_payload = {
                        'available': True,
                        'faces': [{
                            'bbox': [f['boundingBox']['x'], f['boundingBox']['y'],
                                     f['boundingBox']['width'], f['boundingBox']['height']],
                            'landmarks_5pt': [],
                            'age': None, 'gender': None,
                            'det_score': f.get('confidence', 0.9),
                            'embedding_dim': 0, 'embedding': None,
                            'mood': f.get('mood'), 'faceAngle': f.get('faceAngle'),
                            'fallback': 'mediapipe',
                        } for f in light['faces']],
                        'faceCount': light['faceCount'],
                        'fallback': 'mediapipe',
                    }
                except Exception as e:
                    faces_payload = {'available': False, 'faces': [], 'faceCount': 0}
                    warnings.append(f'faces fallback: {e}')
        else:
            faces_payload = {'available': False, 'faces': [], 'faceCount': 0}

        # OCR — try PaddleOCR first, fall back to Tesseract.
        if 'ocr' not in skip:
            paddle_out = _run_paddle(img)
            if paddle_out.get('available') and paddle_out.get('words'):
                ocr_out = paddle_out
                models_used.append('PaddleOCR PP-OCRv4')
            elif paddle_out.get('available') and not paddle_out.get('words'):
                # Paddle loaded but found nothing — accept the empty result and
                # skip the fallback (Tesseract is unlikely to find text Paddle
                # missed on clean photos).
                ocr_out = paddle_out
                models_used.append('PaddleOCR PP-OCRv4')
            else:
                warnings.append(f'paddle-ocr: {paddle_out.get("warning", "unavailable")}')
                tess = _run_ocr_tesseract(img)
                if tess.get('warning'):
                    warnings.append(f'tesseract: {tess["warning"]}')
                ocr_out = tess
                if tess.get('available'):
                    models_used.append('Tesseract')
        else:
            ocr_out = {'available': False, 'words': []}

        # Depth map (Depth-Anything)
        if 'depth' not in skip:
            depth_out = _run_depth(img)
            if depth_out.get('warning'):
                warnings.append(f'depth: {depth_out["warning"]}')
            if depth_out.get('available') and depth_out.get('preview_url'):
                models_used.append('Depth-Anything-V2-Small')
        else:
            depth_out = {'available': False, 'preview_url': None, 'stats': None}

        return jsonify({
            'ok': True,
            'caption': cap.get('caption', ''),
            'confidence': cap.get('confidence', 0.0),
            'clip_tags': clip_out.get('tags', []),
            'faces': faces_payload.get('faces', []),
            'faceCount': faces_payload.get('faceCount', 0),
            'face_backend': 'insightface' if faces_payload.get('available') and not faces_payload.get('fallback') else 'mediapipe',
            'objects': obj_out.get('objects', []),
            'objectCount': obj_out.get('count', 0),
            'text': ocr_out.get('words', []),
            'ocr_available': ocr_out.get('available', False),
            'dominant_colors': colors,
            'depth': {
                'preview_url': depth_out.get('preview_url'),
                'stats': depth_out.get('stats'),
                'available': depth_out.get('available', False),
            },
            'aesthetic': aesthetic,
            'meta': meta,
            'warnings': warnings,
            'models_used': models_used,
            'backend': 'deep',
            'elapsedMs': int((time.monotonic() - started) * 1000),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'ok': False, 'error': str(e),
                        'elapsedMs': int((time.monotonic() - started) * 1000)}), 500


# ═══════════════════════════════════════════════════════════════════════════════
# /health — extended to report deep-model status
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        # Light lanes
        'face_detection': 'mediapipe',
        'yolo': {'loaded': YOLO_MODEL is not None, 'model': YOLO_MODEL_NAME},
        'tesseract': {'available': _check_tesseract(), 'error': _TESSERACT_ERR},
        # Deep lanes — import probe results (weights are still lazy).
        'deep': {
            'torch_available': _HAS_TORCH,
            'transformers_available': _HAS_TRANSFORMERS,
            'insightface_available': _HAS_INSIGHTFACE,
            'paddle_available': _HAS_PADDLE,
            'import_errors': _DEEP_IMPORT_ERRORS,
            # Whether each model has been loaded into memory yet.
            'loaded': {
                'blip': BLIP.loaded,
                'clip': CLIP.loaded,
                'insightface': INSIGHT.loaded,
                'paddle': PADDLE.loaded,
                'depth_anything': DEPTH.loaded,
            },
            'errors': {
                'blip': BLIP.error,
                'clip': CLIP.error,
                'insightface': INSIGHT.error,
                'paddle': PADDLE.error,
                'depth_anything': DEPTH.error,
            },
        },
    })


# Startup summary — tell the operator which deep lanes are theoretically usable
# before any request comes in. Actual weight downloads still happen lazily.
print('[boot] Deep model probes:')
print(f'  torch          = {_HAS_TORCH}')
print(f'  transformers   = {_HAS_TRANSFORMERS}   (BLIP + CLIP + Depth-Anything need this)')
print(f'  insightface    = {_HAS_INSIGHTFACE}   (face embeddings + verify)')
print(f'  paddleocr      = {_HAS_PADDLE}   (better OCR than Tesseract)')
if _DEEP_IMPORT_ERRORS:
    print('[boot] Import errors — those lanes will report available=false:')
    for k, v in _DEEP_IMPORT_ERRORS.items():
        print(f'  {k}: {v}')


# ── Warm-up hook ─────────────────────────────────────────────────
# Fire model loads in a background thread on service boot so the first
# user request doesn't eat the 30-60s cold load per model. Each _LazyModel
# has its own lock — this thread just triggers .get() to force the load
# graph to run. Failures are already isolated per-model (they return None
# and stamp _DEEP_IMPORT_ERRORS), so a broken model doesn't stall the rest.
#
# Set WARMUP=0 in env to skip (e.g. during dev with hot reload).
def _warmup_models():
    import time
    if os.environ.get('WARMUP', '1') == '0':
        print('[warmup] skipped (WARMUP=0)')
        return
    print('[warmup] preloading deep models in background…')
    for name, model in [
        ('BLIP',       BLIP),
        ('CLIP',       CLIP),
        ('InsightFace', INSIGHT),
        ('PaddleOCR',  PADDLE),
        ('Depth',      DEPTH),
    ]:
        t0 = time.time()
        try:
            m = model.get()
            status = 'ok' if m is not None else 'unavailable'
        except Exception as e:
            status = f'error: {e.__class__.__name__}'
        dt = time.time() - t0
        print(f'[warmup] {name}: {status} ({dt:.1f}s)')
    print('[warmup] done — first user request will be fast.')


if __name__ == '__main__':
    import threading
    threading.Thread(target=_warmup_models, daemon=True).start()
    app.run(host='0.0.0.0', port=5000)
