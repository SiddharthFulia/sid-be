#!/bin/bash
# ============================================
# VPS Setup Script for sid-be
# Server: 80.225.213.103 (Oracle Cloud ARM)
# Domain: api.siddharthfulia.com
# ============================================

set -e

echo "==============================="
echo "  sid-be VPS Setup"
echo "==============================="

# --- System ---
echo "[1/8] Updating system..."
sudo apt update && sudo apt upgrade -y

# --- Node.js 22 ---
echo "[2/8] Installing Node.js 22..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi
echo "Node: $(node -v), NPM: $(npm -v)"

# --- PM2 ---
echo "[3/8] Installing PM2..."
sudo npm install -g pm2

# --- Ollama ---
echo "[4/8] Installing Ollama..."
if ! command -v ollama &>/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
sudo systemctl enable ollama
sudo systemctl start ollama

echo "[4b/8] Pulling models (this takes a while)..."
ollama pull llama3.2:1b
ollama pull llama3.2:3b

# --- Python for face detection ---
echo "[5/8] Setting up Python face service..."
sudo apt install -y python3-pip python3-venv python3-dev cmake
cd /home/ubuntu/sid-be/python
bash setup.sh

# --- Backend ---
echo "[6/8] Setting up backend..."
cd /home/ubuntu/sid-be
npm install

# Create .env if not exists
if [ ! -f .env ]; then
  cat > .env << 'ENVEOF'
PORT=4001
NODE_ENV=production
OLLAMA_URL=http://localhost:11434
NASA_API_KEY=F0B5sBr4BHlAlAyAF0oybmvhcpuuYMBDfK2zZPkX
FACE_SERVICE_URL=http://localhost:5000
FRONTEND_URL=https://siddharthfulia.com
ENVEOF
fi

# Start services with PM2
pm2 start server.js --name sid-be
pm2 start "python/venv/bin/python python/face_service.py" --name face-service
pm2 save
pm2 startup

# --- Nginx ---
echo "[7/8] Setting up Nginx..."
sudo apt install -y nginx

sudo tee /etc/nginx/sites-available/sid-be > /dev/null << 'NGINX'
server {
    listen 80;
    server_name api.siddharthfulia.com;

    location / {
        proxy_pass http://localhost:4001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/sid-be /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx

# --- Firewall ---
echo "[8/8] Configuring firewall..."
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable

echo ""
echo "==============================="
echo "  Setup Complete!"
echo "==============================="
echo ""
echo "Services:"
echo "  Backend:  http://localhost:4001"
echo "  Face:     http://localhost:5000"
echo "  Ollama:   http://localhost:11434"
echo ""
echo "Test:"
echo "  curl http://api.siddharthfulia.com/api/health"
echo ""
echo "Logs:"
echo "  pm2 logs sid-be"
echo "  pm2 logs face-service"
echo ""
echo "Redeploy after git push:"
echo "  cd /home/ubuntu/sid-be && git pull && npm install && pm2 restart all"
echo ""
echo "Next: Point api.siddharthfulia.com DNS A record to 80.225.213.103"
echo "Then: sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d api.siddharthfulia.com"
