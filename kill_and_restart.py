import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '=== 1. KILLING LEFTOVER SERVER.PY ===' && "
    "sudo kill -9 2196891 || true ; "
    "pkill -9 -f 'server.py' || true ; "
    "pkill -9 -f 'import api.index' || true ; "
    "sleep 2 ; "
    "echo '=== 2. RESTARTING IPQC-V1.SERVICE ===' && "
    "sudo -n systemctl restart ipqc-v1.service ; "
    "sleep 3 ; "
    "echo '=== 3. CHECKING SYSTEMD STATUS ===' && "
    "sudo -n systemctl is-active ipqc-v1.service ; "
    "echo '=== 4. CHECKING PORT 8082 ===' && "
    "sudo ss -tlpn | grep 8082 || echo 'Port 8082 not yet open' ; "
    "echo '=== 5. CURL /health ===' && "
    "curl -s -i --max-time 5 http://127.0.0.1:8082/health || echo 'Curl failed'"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print("=== OUTPUT ===")
print(res.stdout)
if res.stderr:
    print("STDERR:\n", res.stderr)
