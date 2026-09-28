import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

# All commands on a single line, no raw newlines in quotes
remote_cmd = (
    "cd /home/ubuntu/ipqc-v1 && "
    "/home/ubuntu/ipqc-v1/venv/bin/python3 -c \"import api.index; print('--- IMPORT OK ---')\" 2>&1"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print("=== STDOUT ===")
print(res.stdout)
print("=== STDERR ===")
print(res.stderr)
