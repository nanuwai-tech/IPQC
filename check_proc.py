import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '=== SYSTEMCTL SHOW ===' && "
    "systemctl show ipqc-v1.service -p MainPID,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode && "
    "echo '=== PS AUX UVICORN ===' && "
    "ps aux | grep -E 'uvicorn|ipqc' | grep -v grep || true && "
    "echo '=== ENV FILE KEYS ===' && "
    "grep -o '^[^=]*' /home/ubuntu/ipqc-v1/.env || true"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print(res.stdout)
if res.stderr:
    print("STDERR:\n", res.stderr)
