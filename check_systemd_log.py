import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '=== SYSTEMD OUT ===' ; cat /home/ubuntu/ipqc-v1/systemd_out.log ; "
    "echo '=== SYSTEMD ERR ===' ; cat /home/ubuntu/ipqc-v1/systemd_err.log ; "
    "echo '=== LISTENING SOCKETS ===' ; sudo ss -tlpn | grep 8082 || echo 'Port 8082 not open yet' ; "
    "echo '=== CURL 8082 ===' ; curl -s -i --max-time 3 http://127.0.0.1:8082/health || true"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print("=== LOGS ===")
print(res.stdout)
if res.stderr:
    print("STDERR:\n", res.stderr)
