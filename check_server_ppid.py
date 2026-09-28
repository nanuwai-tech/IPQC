import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "ps -f -p 2196891,2198332 || ps -ef | grep -E 'server.py|8082' ; "
    "echo '=== WHAT SERVICES ARE RUNNING? ===' ; "
    "systemctl list-units --type=service --state=running | grep -E 'ipqc|server|uvicorn|quality' || true"
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
