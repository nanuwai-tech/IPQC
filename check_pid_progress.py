import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "pid=$(pgrep -f 'uvicorn api.index:app' | head -n 1) ; "
    "echo \"PID: $pid\" ; "
    "if [ -n \"$pid\" ]; then "
    "  ps -fp $pid ; "
    "  cat /proc/$pid/stack ; "
    "fi"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print("=== PID PROGRESS ===")
print(res.stdout)
if res.stderr:
    print("STDERR:\n", res.stderr)
