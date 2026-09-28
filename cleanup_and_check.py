import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "pkill -f 'import api.index' || true ; "
    "sleep 1 ; "
    "echo '=== LISTENING ON 8082? ===' && "
    "sudo ss -tlpn | grep 8082 || echo 'Not listening yet' ; "
    "echo '=== HEALTH CHECK ===' && "
    "curl -s -i --max-time 5 http://127.0.0.1:8082/health || echo 'Curl failed' ; "
    "echo '=== TOP CPU CONSUMERS ===' && "
    "ps -eo pid,pcpu,pmem,args --sort=-pcpu | head -n 8"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print("=== STDOUT ===")
print(res.stdout)
if res.stderr:
    print("=== STDERR ===")
    print(res.stderr)
