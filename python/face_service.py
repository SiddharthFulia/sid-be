"""Face detection service using dlib + OpenCV."""

import os
import base64
import math
import numpy as np
import cv2
import dlib
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

PREDICTOR_PATH = os.path.join(os.path.dirname(__file__), 'shape_predictor_68_face_landmarks.dat')
detector = dlib.get_frontal_face_detector()
predictor = None

if os.path.exists(PREDICTOR_PATH):
    predictor = dlib.shape_predictor(PREDICTOR_PATH)
    print(f"Loaded landmark model from {PREDICTOR_PATH}")
else:
    print(f"WARNING: {PREDICTOR_PATH} not found")

haar_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

LANDMARK_GROUPS = {
    'jaw': list(range(0, 17)),
    'left_eyebrow': list(range(17, 22)),
    'right_eyebrow': list(range(22, 27)),
    'nose_bridge': list(range(27, 31)),
    'nose_tip': list(range(31, 36)),
    'left_eye': list(range(36, 42)),
    'right_eye': list(range(42, 48)),
    'outer_lip': list(range(48, 60)),
    'inner_lip': list(range(60, 68)),
}


def decode_image(image_data):
    if ',' in image_data:
        image_data = image_data.split(',')[1]
    img_bytes = base64.b64decode(image_data)
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return None
    # Force uint8 BGR — fixes ARM/Linux compatibility
    if img.dtype != np.uint8:
        img = img.astype(np.uint8)
    if len(img.shape) == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return img


def detect_mood(landmarks, face_rect):
    """Mood detection with normalized face height."""
    try:
        pts = landmarks

        # Mouth measurements
        mouth_open = abs(pts[66][1] - pts[62][1])
        mouth_width = abs(pts[54][0] - pts[48][0])
        mouth_ratio = mouth_open / max(mouth_width, 1)

        # Smile: compare lip corner height vs mouth center height
        mouth_center_y = (pts[62][1] + pts[66][1]) / 2
        corner_avg_y = (pts[48][1] + pts[54][1]) / 2
        face_h = max(face_rect.height(), 1)
        smile_score = (mouth_center_y - corner_avg_y) / face_h

        # Eye openness
        left_eye_ratio = abs(pts[41][1] - pts[37][1]) / max(abs(pts[39][0] - pts[36][0]), 1)
        right_eye_ratio = abs(pts[47][1] - pts[43][1]) / max(abs(pts[45][0] - pts[42][0]), 1)
        eye_openness = (left_eye_ratio + right_eye_ratio) / 2

        # Eyebrow raise
        left_brow = np.mean([pts[i][1] for i in range(17, 22)])
        right_brow = np.mean([pts[i][1] for i in range(22, 27)])
        eye_center_y = (pts[37][1] + pts[43][1]) / 2
        brow_raise = (eye_center_y - (left_brow + right_brow) / 2) / face_h

        # Decision tree
        if mouth_ratio > 0.35:
            return 'surprised', min(0.5 + mouth_ratio, 0.95)
        elif smile_score > 0.02:
            return 'happy', min(0.6 + smile_score * 5, 0.98)
        elif smile_score < -0.015:
            return 'sad', min(0.5 + abs(smile_score) * 5, 0.85)
        elif brow_raise > 0.08:
            return 'angry', min(0.5 + brow_raise * 3, 0.8)
        elif eye_openness < 0.15:
            return 'sleepy', 0.7
        else:
            return 'neutral', 0.75
    except Exception:
        return 'neutral', 0.5


def get_face_angle(landmarks):
    """Head tilt angle from eye positions."""
    left_eye = np.mean([(landmarks[36][0], landmarks[36][1]), (landmarks[39][0], landmarks[39][1])], axis=0)
    right_eye = np.mean([(landmarks[42][0], landmarks[42][1]), (landmarks[45][0], landmarks[45][1])], axis=0)
    dx = right_eye[0] - left_eye[0]
    dy = right_eye[1] - left_eye[1]
    return round(float(np.degrees(np.arctan2(dy, dx))), 2)


def eye_aspect_ratio(eye_pts):
    v1 = np.linalg.norm(np.array(eye_pts[1]) - np.array(eye_pts[5]))
    v2 = np.linalg.norm(np.array(eye_pts[2]) - np.array(eye_pts[4]))
    h = np.linalg.norm(np.array(eye_pts[0]) - np.array(eye_pts[3]))
    return (v1 + v2) / (2.0 * h) if h > 0 else 0


@app.route('/analyze', methods=['POST'])
def analyze():
    try:
        data = request.json
        if not data or 'image' not in data:
            return jsonify({'error': 'No image provided'}), 400

        img = decode_image(data['image'])
        if img is None:
            return jsonify({'error': 'Invalid image'}), 400

        # img is already guaranteed BGR uint8 from decode_image
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        h, w = img.shape[:2]

        # Detect faces
        dlib_faces = detector(gray, 0)  # 0 = no upsampling = faster

        if len(dlib_faces) == 0:
            haar = haar_cascade.detectMultiScale(gray, 1.1, 5, minSize=(30, 30))
            dlib_faces = [dlib.rectangle(x, y, x + fw, y + fh) for (x, y, fw, fh) in haar]

        faces = []
        for face_rect in dlib_faces:
            result = {
                'boundingBox': {
                    'x': max(0, face_rect.left()),
                    'y': max(0, face_rect.top()),
                    'width': face_rect.width(),
                    'height': face_rect.height(),
                },
                'confidence': 0.9,
            }

            if predictor:
                shape = predictor(gray, face_rect)
                points = [(shape.part(i).x, shape.part(i).y) for i in range(68)]

                result['landmarks'] = {
                    'points': [{'x': p[0], 'y': p[1]} for p in points],
                    'groups': {k: [{'x': points[i][0], 'y': points[i][1]} for i in v] for k, v in LANDMARK_GROUPS.items()},
                }

                # Mood
                mood, conf = detect_mood(points, face_rect)
                result['mood'] = mood
                result['moodConfidence'] = round(conf, 2)

                # Face angle
                result['faceAngle'] = get_face_angle(points)

                # Features
                left_ear = eye_aspect_ratio([points[i] for i in [36, 37, 38, 39, 40, 41]])
                right_ear = eye_aspect_ratio([points[i] for i in [42, 43, 44, 45, 46, 47]])
                mouth_h = abs(points[66][1] - points[62][1])
                mouth_w = abs(points[54][0] - points[48][0])

                result['features'] = {
                    'mouthOpen': round(mouth_h / max(mouth_w, 1), 3),
                    'leftEyeOpen': round(left_ear, 3),
                    'rightEyeOpen': round(right_ear, 3),
                    'smiling': mood == 'happy',
                }

            faces.append(result)

        return jsonify({
            'faces': faces,
            'faceCount': len(faces),
            'imageSize': {'width': w, 'height': h},
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ═══ Object Detection (YOLOv8-nano via OpenCV DNN) ═══

YOLO_MODEL = None
YOLO_CLASSES = []

def load_yolo():
    """Load YOLOv8-nano ONNX model if available."""
    global YOLO_MODEL, YOLO_CLASSES
    model_path = os.path.join(os.path.dirname(__file__), 'yolov8n.onnx')
    classes_path = os.path.join(os.path.dirname(__file__), 'coco_classes.txt')
    if os.path.exists(model_path):
        YOLO_MODEL = cv2.dnn.readNetFromONNX(model_path)
        print(f"Loaded YOLOv8n from {model_path}")
    else:
        print(f"YOLOv8n not found at {model_path} — object detection disabled")
        print("Download: pip install ultralytics && yolo export model=yolov8n.pt format=onnx")
    if os.path.exists(classes_path):
        with open(classes_path) as f:
            YOLO_CLASSES = [l.strip() for l in f.readlines()]
    else:
        # COCO 80 class names
        YOLO_CLASSES = ['person','bicycle','car','motorcycle','airplane','bus','train','truck','boat',
            'traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse',
            'sheep','cow','elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie',
            'suitcase','frisbee','skis','snowboard','sports ball','kite','baseball bat','baseball glove',
            'skateboard','surfboard','tennis racket','bottle','wine glass','cup','fork','knife','spoon',
            'bowl','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut',
            'cake','chair','couch','potted plant','bed','dining table','toilet','tv','laptop','mouse',
            'remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator','book',
            'clock','vase','scissors','teddy bear','hair drier','toothbrush']

load_yolo()


@app.route('/detect-objects', methods=['POST'])
def detect_objects():
    """Object detection using YOLOv8-nano."""
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

        # Preprocess for YOLOv8
        blob = cv2.dnn.blobFromImage(img, 1/255.0, (640, 640), swapRB=True, crop=False)
        YOLO_MODEL.setInput(blob)
        outputs = YOLO_MODEL.forward()

        # YOLOv8 output: (1, 84, 8400) -> transpose to (8400, 84)
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
            # Scale from 640x640 back to original
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

        # NMS to remove duplicates
        if objects:
            boxes = [o['bbox'] for o in objects]
            scores = [o['score'] for o in objects]
            indices = cv2.dnn.NMSBoxes(boxes, scores, threshold, 0.4)
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


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'predictor_loaded': predictor is not None,
        'yolo_loaded': YOLO_MODEL is not None,
    })


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
