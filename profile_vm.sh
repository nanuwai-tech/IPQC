#!/bin/bash
set +e

echo "=== PID 2202869 STATUS ==="
ps -fp 2202869 || echo "Process exited"

echo "=== MANUAL LOG NOW (AFTER 1 MINUTE) ==="
cat /home/ubuntu/uvicorn_manual.log || true

echo "=== PORT 8082 NOW ==="
sudo ss -tlpn | grep 8082 || echo "Still not listening"

echo "=== PROFILE IMPORTS ==="
/home/ubuntu/ipqc-v1/venv/bin/python3 -c "
import time

def check(mod):
    t0 = time.time()
    try:
        __import__(mod)
        print(f'{mod}: {time.time()-t0:.2f}s')
    except Exception as e:
        print(f'{mod} FAILED: {e}')

for m in ['fastapi', 'psycopg2', 'openpyxl', 'xlrd', 'cv2', 'torch', 'ultralytics', 'api.db_adapter', 'api.pcba_inspection_service', 'api.index']:
    check(m)
"
