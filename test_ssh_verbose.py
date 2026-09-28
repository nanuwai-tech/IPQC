import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

log_path = 'ssh_test.log'
with open(log_path, 'w') as log_f:
    p = subprocess.Popen(
        ['ssh', '-v', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', f'ubuntu@{vm_ip}', 'echo SSH_IS_ALIVE'],
        stdin=subprocess.DEVNULL,
        stdout=log_f,
        stderr=log_f
    )
    try:
        p.wait(timeout=15)
        print("Exit code:", p.returncode)
    except subprocess.TimeoutExpired:
        p.kill()
        print("Timed out!")

with open(log_path, 'r') as log_f:
    print(log_f.read()[:2000])
