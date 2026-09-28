import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '=== FUSER 8082 ===' && "
    "sudo fuser 8082/tcp || true ; "
    "echo '=== WHO IS LISTENING ON 8082? ===' && "
    "sudo ss -tlpn | grep 8082 || echo 'Port 8082 is NOT in ss' ; "
    "echo '=== WHAT PORT DOES SERVER.PY USE? ===' && "
    "grep '^PORT=' /home/ubuntu/ipqc-v1/.env || true ; "
    "echo '=== UVICORN LOG OR ERROR? ===' && "
    "sudo systemctl status ipqc-v1.service --lines=15 --no-pager || true"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print("=== STDOUT ===")
print(res.stdout)
if res.stderr:
    print("=== STDERR ===")
    print(res.stderr)
