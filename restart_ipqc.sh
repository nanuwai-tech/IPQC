#!/bin/bash
set +e

echo "--- 1. Stop systemd service ---"
sudo systemctl stop ipqc-v1.service
pkill -9 -f 'uvicorn' 2>/dev/null
pkill -9 -f 'server.py' 2>/dev/null
sleep 2

echo "--- 2. Run uvicorn directly and capture output ---"
cd /home/ubuntu/ipqc-v1
/home/ubuntu/ipqc-v1/venv/bin/uvicorn api.index:app --host 0.0.0.0 --port 8082 > /home/ubuntu/uvicorn_manual.log 2>&1 &
UVICORN_PID=$!
echo "Started uvicorn PID: $UVICORN_PID"

echo "Waiting 12 seconds for startup..."
sleep 12

echo "--- 3. UVICORN MANUAL LOG ---"
cat /home/ubuntu/uvicorn_manual.log

echo "--- 4. Check Listening Ports ---"
sudo ss -tlpn | grep 8082 || echo "Port 8082 not open"

echo "--- 5. Test Curl ---"
curl -s -i --max-time 5 http://127.0.0.1:8082/health || echo "Local curl failed"
