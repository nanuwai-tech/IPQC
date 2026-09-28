import subprocess
import os
import time

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

# Run uvicorn directly with python to capture stderr/traceback immediately
remote_cmd = (
    "cd /home/ubuntu/ipqc-v1 && "
    "/home/ubuntu/ipqc-v1/venv/bin/python3 -c '"
    "import traceback\n"
    "try:\n"
    "    import api.index\n"
    "    print(\"IMPORT WORKED!\")\n"
    "except Exception as e:\n"
    "    traceback.print_exc()\n"
    "'"
)

print("Running import test inside VM venv...", flush=True)
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
