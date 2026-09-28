#!/bin/bash
set +e

echo "=== 1. Clean kill any leftover processes ==="
pkill -9 -f 'server.py' 2>/dev/null || true
pkill -9 -f 'uvicorn' 2>/dev/null || true
sleep 2

echo "=== 2. Reload and restart systemd service ==="
sudo systemctl daemon-reload
sudo systemctl restart ipqc-v1.service

echo "=== 3. Waiting 20 seconds for Uvicorn to complete import and listen ==="
sleep 20

echo "=== 4. Check systemctl status ==="
sudo systemctl is-active ipqc-v1.service

echo "=== 5. Check listening port 8082 ==="
sudo ss -tlpn | grep 8082 || echo "Port 8082 still not in ss"

echo "=== 6. Test curl on localhost ==="
curl -s -i --max-time 5 http://127.0.0.1:8082/health || echo "Local curl failed"
