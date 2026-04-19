#!/bin/bash
set -e

echo "=== Installing system deps ==="
sudo apt-get update
sudo apt-get install -y python3-pip python3-venv python3-dev cmake

echo "=== Creating Python venv ==="
cd "$(dirname "$0")"
python3 -m venv venv
source venv/bin/activate

echo "=== Installing Python packages ==="
pip install --upgrade pip
pip install -r requirements.txt

echo "=== Downloading dlib model ==="
if [ ! -f shape_predictor_68_face_landmarks.dat ]; then
  wget http://dlib.net/files/shape_predictor_68_face_landmarks.dat.bz2
  bunzip2 shape_predictor_68_face_landmarks.dat.bz2
fi

echo "=== Done! Start with: ==="
echo "pm2 start 'venv/bin/python face_service.py' --name face-service"
