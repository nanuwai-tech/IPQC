import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

# Test running server.py directly with timeout to see exact console logs
remote_cmd = (
    "cd /home/ubuntu/ipqc-v1 && "
    "PORT=8083 timeout 15 /home/ubuntu/ipqc-v1/venv/bin/python3 server.py 2>&1"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print("=== SERVER.PY OUTPUT ===")
print(res.stdout)
if res.stderr:
    print("STDERR:\n", res.stderr)
