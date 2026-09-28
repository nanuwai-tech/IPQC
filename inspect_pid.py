import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "pid=$(pgrep -f 'uvicorn api.index:app' | head -n 1) ; "
    "echo \"Uvicorn PID: $pid\" ; "
    "if [ -n \"$pid\" ]; then "
    "  echo '=== WCHAN ===' ; cat /proc/$pid/wchan ; echo '' ; "
    "  echo '=== FD LIST ===' ; sudo ls -la /proc/$pid/fd ; "
    "  echo '=== NET STATS FOR PID ===' ; sudo ss -tlpn | grep $pid || echo 'No listening sockets' ; "
    "fi ; "
    "echo '=== CHECK PORT 8082 VIA CURL ===' ; "
    "curl -s -i --connect-timeout 2 http://127.0.0.1:8082/health || echo 'Curl 8082 connection failed'"
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
