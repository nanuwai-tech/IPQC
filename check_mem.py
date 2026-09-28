import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '=== MEMORY INFO ===' && free -h && "
    "echo '=== SWAP INFO ===' && swapon --show && "
    "echo '=== TOP MEMORY PROCESSES ===' && "
    "ps -eo pid,pmem,rss,args --sort=-rss | head -n 12"
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
