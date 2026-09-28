import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "sudo ls -l /proc/2204672/fd ; "
    "echo '--- CPU TIME ---' ; "
    "ps -f -p 2204672 ; "
    "echo '--- LISTENING ON 8082? ---' ; "
    "sudo ss -tlpn | grep 8082 || echo 'Not yet'"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print(res.stdout)
if res.stderr:
    print("STDERR:\n", res.stderr)
