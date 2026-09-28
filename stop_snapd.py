import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '=== STOPPING SNAPD ===' ; "
    "sudo systemctl stop snapd.service snapd.socket snapd.seeded.service 2>/dev/null || true ; "
    "sudo pkill -9 -f 'snapd' || true ; "
    "sleep 2 ; "
    "echo '=== TOP CPU CONSUMERS NOW ===' ; "
    "ps -eo pid,pcpu,pmem,args --sort=-pcpu | head -n 8"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print("=== OUTPUT ===")
print(res.stdout)
if res.stderr:
    print("STDERR:\n", res.stderr)
