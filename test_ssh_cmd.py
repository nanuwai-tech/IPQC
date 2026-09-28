import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '--- IS ACTIVE ---' && sudo -n systemctl is-active ipqc-v1.service "
    "&& echo '--- CURL LOCAL 8082 ---' && curl -s -i http://127.0.0.1:8082/health "
    "&& echo '--- NGINX ERROR LOG ---' && sudo -n tail -n 15 /var/log/nginx/error.log"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=20
)

print(res.stdout)
if res.stderr:
    print("STDERR:\n", res.stderr)
