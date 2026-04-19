"""Face detection service using dlib + OpenCV."""

import os
import sys
import json
import base64
import math
import numpy as np
import cv2
import dlib
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Load models
PREDICTOR_PATH = os.path.join(os.path.dirname(__file__), 'shape_predictor_68_face_landmarks.dat')
detector = dlib.get_frontal_face_detector()
predictor = None

if os.path.exists(PREDICTOR_PATH):
    predictor = dlib.shape_predictor(PREDICTOR_PATH)
else:
    print(f"WARNING: {PREDICTOR_PATH} not found. Landmarks won't work.")
    print("Download: wget http://dlib.net/files/shape_predictor_68_face_landmarks.dat.bz2 && bunzip2 *.bz2")

# Haar cascade fallback
cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
haar_cascade = cv2.CascadeClassifier(cascade_path)

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
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def eye_aspect_ratio(eye_points):
    v1 = np.linalg.norm(eye_points[1] - eye_points[5])
    v2 = np.linalg.norm(eye_points[2] - eye_points[4])
    h = np.linalg.norm(eye_points[0] - eye_points[3])
    return (v1 + v2) / (2.0 * h) if h > 0 else 0


def detect_mood(landmarks):
    pts = np.array(landmarks)

    # Mouth
    mouth_h = np.linalg.norm(pts[62] - pts[66])
    mouth_w = np.linalg.norm(pts[48] - pts[54])
    mouth_ratio = mouth_h / mouth_w if mouth_w > 0 else 0

    # Smile
    left_corner = pts[48][1] - pts[33][1]
    right_corner = pts[54][1] - pts[33][1]
    smile_score = -(left_corner + right_corner) / 2

    # Eyes
    left_ear = eye_aspect_ratio(pts[36:42])
    right_ear = eye_aspect_ratio(pts[42:48])
    avg_ear = (left_ear + right_ear) / 2

    # Eyebrow raise
    brow_dist = (np.mean(pts[17:22, 1]) + np.mean(pts[22:27, 1])) / 2
    eye_center = (np.mean(pts[36:42, 1]) + np.mean(pts[42:48, 1])) / 2
    brow_raise = eye_center - brow_dist

    scores = {
        'happy': max(0, smile_score * 0.05 + (1 if mouth_ratio > 0.3 else 0) * 0.5),
        'surprised': min(1, mouth_ratio * 2 + (brow_raise * 0.02 if brow_raise > 0 else 0)),
        'angry': max(0, -brow_raise * 0.03),
        'sad': max(0, -smile_score * 0.03),
        'sleepy': max(0, 1 - avg_ear * 4),
        'neutral': 0.3,
    }

    mood = max(scores, key=scores.get)
    return mood, scores[mood]


@app.route('/analyze', methods=['POST'])
def analyze():
    try:
        data = request.json
        if not data or 'image' not in data:
            return jsonify({'error': 'No image provided'}), 400

        img = decode_image(data['image'])
        if img is None:
            return jsonify({'error': 'Invalid image'}), 400

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        h, w = img.shape[:2]

        # Detect faces
        dlib_faces = detector(gray, 1)

        if len(dlib_faces) == 0:
            haar_faces = haar_cascade.detectMultiScale(gray, 1.1, 5, minSize=(30, 30))
            dlib_faces = [dlib.rectangle(x, y, x + fw, y + fh) for (x, y, fw, fh) in haar_faces]

        faces = []
        for face in dlib_faces:
            result = {
                'boundingBox': {
                    'x': max(0, face.left()),
                    'y': max(0, face.top()),
                    'width': face.width(),
                    'height': face.height(),
                },
                'confidence': 0.9,
            }

            if predictor:
                shape = predictor(gray, face)
                points = [(shape.part(i).x, shape.part(i).y) for i in range(68)]

                result['landmarks'] = {
                    'points': points,
                    'groups': {k: [points[i] for i in v] for k, v in LANDMARK_GROUPS.items()},
                }

                mood, conf = detect_mood(points)
                result['mood'] = mood
                result['moodConfidence'] = round(conf, 2)

                # Features
                pts = np.array(points)
                left_ear = eye_aspect_ratio(pts[36:42])
                right_ear = eye_aspect_ratio(pts[42:48])
                mouth_h = np.linalg.norm(pts[62] - pts[66])
                mouth_w = np.linalg.norm(pts[48] - pts[54])

                dx = pts[45][0] - pts[36][0]
                dy = pts[45][1] - pts[36][1]
                angle = math.degrees(math.atan2(dy, dx))

                result['faceAngle'] = round(angle, 2)
                result['features'] = {
                    'mouthOpen': round(mouth_h / mouth_w if mouth_w > 0 else 0, 3),
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


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'predictor_loaded': predictor is not None})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
