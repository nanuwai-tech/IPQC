import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '=== IPQC STATUS ===' && "
    "sudo -n systemctl is-active ipqc-v1.service || true ; "
    "echo '=== NGINX ERROR LOG ===' && "
    "sudo -n tail -n 20 /var/log/nginx/error.log 2>&1 || true ; "
    "echo '=== CHECK PORT 8082 ===' && "
    "curl -s -i http://127.0.0.1:8082/health 2>&1 || true ; "
    "echo '=== CHECK PYTHON RUN DIRECTLY ===' && "
    "/home/ubuntu/ipqc-v1/venv/bin/python3 -c 'import api.index; print(\"VM IMPORT OK\")' 2>&1 || true"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=40
)

print(res.stdout)
if res.stderr:
    print("STDERR:\n", res.stderr)
