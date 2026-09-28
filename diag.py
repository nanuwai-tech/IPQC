import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '=== SERVICE ===' && cat /etc/systemd/system/ipqc-v1.service "
    "&& echo '=== PORTS ===' && sudo ss -tlpn "
    "&& echo '=== NGINX ===' && sudo grep -rn 'proxy_pass' /etc/nginx/sites-enabled/ "
    "&& echo '=== JOURNAL ===' && sudo journalctl -u ipqc-v1.service -n 25 --no-pager"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=20
)

print(res.stdout)
if res.stderr:
    print("STDERR:", res.stderr)
