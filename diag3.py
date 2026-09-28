import subprocess
import os
import sys

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

print(f"Connecting to {vm_ip}...", flush=True)

remote_cmd = (
    "echo '=== IPQC SERVICE ===' && sudo -n systemctl status ipqc-v1.service --no-pager "
    "&& echo '=== LISTENING PORTS ===' && sudo ss -tlpn "
    "&& echo '=== TEST LOCALHOST 8082 ===' && curl -s http://127.0.0.1:8082/health "
    "&& echo '' && echo '=== TEST LOCALHOST 8000 ===' && curl -s http://127.0.0.1:8000/ "
    "&& echo '' && echo '=== NGINX CONFIG ===' && sudo cat /etc/nginx/sites-enabled/*"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)

print(res.stdout, flush=True)
if res.stderr:
    print("STDERR:\n", res.stderr, flush=True)
