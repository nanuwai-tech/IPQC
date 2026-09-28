import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'
remote_cmd = 'cat /home/ubuntu/ipqc-v1/.env'

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=20
)
print("STDOUT:\n" + res.stdout)
if res.stderr:
    print("STDERR:\n" + res.stderr)
