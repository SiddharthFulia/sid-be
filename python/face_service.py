"""Face detection service using MediaPipe + OpenCV.

Also hosts the offline lanes that back /api/vision/analyze:
  • /ocr             — Tesseract text recognition (soft-fails if tesseract
                       binary or pytesseract module isn't installed)
  • /dominant-colors — k-means on a downsampled image (top-6 clusters)
  • /vision-analyze  — one-shot omnibus: faces + objects + ocr + colors + meta
"""

import os
import base64
import math
import time
import numpy as np
import cv2
from flask import Flask, request, jsonify
from flask_cors import CORS

# Optional deps for OCR — imported lazily so a missing tesseract binary
# doesn't take down the whole service. The /ocr route reports back with
# `{ ok: true, available: false, warning: '...' }` when pytesseract or
# the tesseract binary aren't available.
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

app = Flask(__name__)
CORS(app)

# MediaPipe Face Mesh (468 landmarks)
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
print("MediaPipe Face Mesh + Detection loaded")

# MediaPipe 468 → dlib 68 mapping (exactly 68 points)
MP_TO_68 = [
    # Jaw 0-16 (17 points): ear to ear along jawline
    234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 365, 288, 323,
    # Left eyebrow 17-21 (5 points)
    70, 63, 105, 66, 107,
    # Right eyebrow 22-26 (5 points)
    336, 296, 334, 293, 300,
    # Nose bridge 27-30 (4 points)
    168, 6, 197, 195,
    # Nose tip 31-35 (5 points)
    5, 4, 45, 275, 1,
    # Left eye 36-41 (6 points)
    33, 160, 158, 133, 153, 144,
    # Right eye 42-47 (6 points)
    362, 385, 387, 263, 373, 380,
    # Outer lip 48-59 (12 points): full loop around outer lip
    61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 321,
    # Inner lip 60-67 (8 points): full loop around inner lip
    78, 82, 13, 312, 308, 317, 14, 87,
]

# Full lip contours for better FE rendering (sent separately)
OUTER_LIP_LOOP = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]
INNER_LIP_LOOP = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191]

# For mood/feature detection
LEFT_EYE = [33, 160, 158, 133, 153, 144]
RIGHT_EYE = [362, 385, 387, 263, 373, 380]
LEFT_EYEBROW = [70, 63, 105, 66, 107]
RIGHT_EYEBROW = [336, 296, 334, 293, 300]


def decode_image(image_data):
    if ',' in image_data:
        image_data = image_data.split(',')[1]
    img_bytes = base64.b64decode(image_data)
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
    """Mood detection using MediaPipe landmarks."""
    try:
        def pt(i):
            return (landmarks[i].x * w, landmarks[i].y * h)

        # Mouth measurements
        mouth_top = pt(13)
        mouth_bottom = pt(14)
        mouth_left = pt(61)
        mouth_right = pt(291)

        mouth_open = abs(mouth_bottom[1] - mouth_top[1])
        mouth_width = abs(mouth_right[0] - mouth_left[0])
        mouth_ratio = mouth_open / max(mouth_width, 1)

        # Smile score
        lip_center_y = (mouth_top[1] + mouth_bottom[1]) / 2
        corner_avg_y = (pt(61)[1] + pt(291)[1]) / 2
        face_h = abs(pt(10)[1] - pt(152)[1])  # top of face to chin
        smile_score = (lip_center_y - corner_avg_y) / max(face_h, 1)

        # Eye openness
        left_ear = eye_aspect_ratio(landmarks, LEFT_EYE, w, h)
        right_ear = eye_aspect_ratio(landmarks, RIGHT_EYE, w, h)
        eye_openness = (left_ear + right_ear) / 2

        # Eyebrow raise
        left_brow_y = np.mean([landmarks[i].y for i in LEFT_EYEBROW]) * h
        right_brow_y = np.mean([landmarks[i].y for i in RIGHT_EYEBROW]) * h
        eye_center_y = (landmarks[159].y * h + landmarks[386].y * h) / 2
        brow_raise = (eye_center_y - (left_brow_y + right_brow_y) / 2) / max(face_h, 1)

        # Decision tree.
        # NOTE: brow_raise threshold was 0.08 which fired on neutral faces
        # (most people sit with brows slightly above eye center). Bumped to
        # 0.16 so only a real frown / pulled-down brow registers as angry.
        # Also require smile_score to be non-positive (genuine frown) — a
        # raised brow with a faint smile is more often surprise/expressive
        # than angry.
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
    """Rough age estimator from facial proportions.

    True age detection wants a CNN (DeepFace / InsightFace / age-net).
    Until that's wired in, we return a heuristic age band based on:
      • face length / width ratio (kids have rounder faces)
      • eye-to-mouth distance vs face height (changes with bone growth)
    Banded output ("20-29") keeps the UI honest about the precision.
    """
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
        ratio = face_h / max(face_w, 1e-3)             # 1.25–1.45 typical adult
        eye_mouth = abs(mouth_y - eye_y) / max(face_h, 1e-3)   # 0.18–0.24 typical

        # Heuristic banding. Tuned by inspection; not clinically accurate.
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

        # Face mesh for landmarks
        mesh_results = face_mesh.process(rgb)
        # Face detection for bounding boxes
        det_results = face_detector.process(rgb)

        faces = []

        if mesh_results.multi_face_landmarks:
            for i, face_landmarks in enumerate(mesh_results.multi_face_landmarks):
                lm = face_landmarks.landmark

                # Bounding box from landmarks
                xs = [l.x * w for l in lm]
                ys = [l.y * h for l in lm]
                x1, y1 = int(min(xs)), int(min(ys))
                x2, y2 = int(max(xs)), int(max(ys))

                # Get detection confidence if available
                confidence = 0.9
                if det_results.detections and i < len(det_results.detections):
                    confidence = det_results.detections[i].score[0]

                # Build 68 landmark points using the mapping
                points_68 = []
                for idx in MP_TO_68[:68]:
                    points_68.append({'x': round(lm[idx].x * w, 1), 'y': round(lm[idx].y * h, 1)})
                while len(points_68) < 68:
                    points_68.append(points_68[-1])

                # Mood
                mood, mood_conf = detect_mood(lm, w, h)

                # Age (heuristic for now — see estimate_age docstring)
                age_info = estimate_age(lm, w, h)

                # Face angle
                angle = get_face_angle(lm, w, h)

                # Eye/mouth features
                left_ear = eye_aspect_ratio(lm, LEFT_EYE, w, h)
                right_ear = eye_aspect_ratio(lm, RIGHT_EYE, w, h)
                mouth_top = lm[13].y * h
                mouth_bottom = lm[14].y * h
                mouth_left = lm[61].x * w
                mouth_right = lm[291].x * w
                mouth_open_ratio = abs(mouth_bottom - mouth_top) / max(abs(mouth_right - mouth_left), 1)

                # Full contour points for better rendering
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


# ═══ Object Detection (YOLOv8-nano via OpenCV DNN) ═══

YOLO_MODEL = None
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
    global YOLO_MODEL
    model_path = os.path.join(os.path.dirname(__file__), 'yolov8n.onnx')
    if os.path.exists(model_path):
        YOLO_MODEL = cv2.dnn.readNetFromONNX(model_path)
        print(f"Loaded YOLOv8n from {model_path}")
    else:
        print(f"YOLOv8n not found at {model_path}")

load_yolo()


@app.route('/detect-objects', methods=['POST'])
def detect_objects():
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
        })

    except Exception as e:
        return jsonify({'error': str(e), 'objects': [], 'count': 0}), 500


# ═══ OCR (Tesseract) ═══
# Cache the "does tesseract actually run" answer so we don't fork a subprocess
# on every request just to fail.
_TESSERACT_CHECKED = False
_TESSERACT_OK = False
_TESSERACT_ERR = None


def _check_tesseract():
    """Verify pytesseract module + tesseract binary are both usable.

    Called on the first /ocr or /vision-analyze request. Result cached
    for the process lifetime.
    """
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
    """Run Tesseract on the image, return per-word bboxes + confidences.

    Contract:
      request  : { image: <base64 or data-uri> }
      response : { words: [{ text, confidence, bbox: [x, y, w, h] }],
                   available: bool, warning?: str }
    Always 200 — if tesseract isn't available we return an empty word list
    plus a warning so the omnibus /vision-analyze caller can degrade
    gracefully instead of surfacing a 5xx.
    """
    try:
        data = request.get_json(silent=True) or {}
        image_data = data.get('image')
        if not image_data:
            return jsonify({'error': 'No image provided', 'words': [], 'available': False}), 400

        if not _check_tesseract():
            return jsonify({
                'words': [],
                'available': False,
                'warning': _TESSERACT_ERR or 'tesseract unavailable',
            })

        img = decode_image(image_data)
        if img is None:
            return jsonify({'error': 'Invalid image', 'words': [], 'available': True}), 400

        # PIL wants RGB. OpenCV gives BGR.
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


# ═══ Dominant colours (k-means on downsampled image) ═══

def _extract_dominant_colors(bgr_img, k=6):
    """Return the top-k colour clusters as { hex, rgb, weight } list.

    Downsamples to 64x64 first so k-means converges in a few ms even on
    4K photos. Weight is the fraction of sampled pixels in that cluster.
    """
    small = cv2.resize(bgr_img, (64, 64), interpolation=cv2.INTER_AREA)
    # OpenCV k-means wants float32 in shape (N, 3).
    Z = small.reshape(-1, 3).astype(np.float32)
    # 10 iterations / eps 1.0 is plenty for a 4096-pixel palette; termination
    # criteria bounds the CPU cost.
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
    # KMEANS_PP_CENTERS = k-means++ seeding — better clusters than random.
    _, labels, centers = cv2.kmeans(Z, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.flatten()
    total = float(len(labels))
    clusters = []
    for i in range(k):
        weight = float(np.sum(labels == i)) / total if total else 0.0
        # centers come back BGR (because Z was BGR) — swap to RGB for the API.
        b, g, r = [int(round(v)) for v in centers[i]]
        clusters.append({
            'hex': '#{:02x}{:02x}{:02x}'.format(r, g, b),
            'rgb': [r, g, b],
            'weight': round(weight, 4),
        })
    clusters.sort(key=lambda c: c['weight'], reverse=True)
    return clusters


def _image_metadata(bgr_img):
    """width, height, aspect_ratio, avg_brightness (0-1), contrast (stddev/128)."""
    h, w = bgr_img.shape[:2]
    gray = cv2.cvtColor(bgr_img, cv2.COLOR_BGR2GRAY)
    mean = float(np.mean(gray))
    std = float(np.std(gray))
    return {
        'width': int(w),
        'height': int(h),
        'aspect_ratio': round(w / max(h, 1), 4),
        'avg_brightness': round(mean / 255.0, 4),
        # Normalise stddev by 128 (max meaningful spread for 0-255). Values
        # >1 are possible but rare on real photos.
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


# ═══ /vision-analyze — omnibus: faces + objects + ocr + colours + meta ═══

def _run_face_analysis(img):
    """Inline copy of /analyze's core so we can call it without a HTTP hop.

    Returns the same shape as /analyze's response body.
    """
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
                'boundingBox': {
                    'x': max(0, x1), 'y': max(0, y1),
                    'width': x2 - x1, 'height': y2 - y1,
                },
                'confidence': round(float(confidence), 3),
                'landmarks': {'points': points_68},
                'mood': mood,
                'moodConfidence': round(mood_conf, 2),
                'faceAngle': angle,
            })
    return {
        'faces': faces,
        'faceCount': len(faces),
        'imageSize': {'width': w, 'height': h},
    }


def _run_object_detection(img, threshold=0.5):
    """Inline copy of /detect-objects's core."""
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

    return {'objects': objects[:20], 'count': len(objects), 'available': True}


def _run_ocr(img):
    """Inline copy of /ocr's core."""
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


@app.route('/vision-analyze', methods=['POST'])
def vision_analyze():
    """One-shot: faces + objects + OCR + dominant colours + metadata.

    Each lane is wrapped so a single failure yields a `warnings[]` entry
    rather than tanking the response. The Node BE proxies this endpoint
    and adds its own SHA-256 cache + IP rate limit on top.
    """
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
        # Each lane is wrapped: on failure we log a warning and keep going.
        try:
            face_out = _run_face_analysis(img)
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
            ocr_out = _run_ocr(img)
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


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'face_detection': 'mediapipe',
        'yolo_loaded': YOLO_MODEL is not None,
        'ocr_available': _check_tesseract(),
        'ocr_error': _TESSERACT_ERR,
    })


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
