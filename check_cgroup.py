import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '=== CGROUP 2196891 (server.py) ===' && cat /proc/2196891/cgroup && "
    "echo '=== CGROUP 2198332 (ipqc-v1.service) ===' && cat /proc/2198332/cgroup && "
    "echo '=== ALL IPQC SYSTEMD UNITS ===' && "
    "ls -la /etc/systemd/system/*ipqc* /etc/systemd/system/*smart*"
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
