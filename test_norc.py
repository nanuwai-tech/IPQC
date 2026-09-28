import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

cmd = "bash --norc --noprofile -c 'echo HELLO_FROM_VM'"
p = subprocess.Popen(
    ['ssh', '-T', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', cmd],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True
)
try:
    stdout, stderr = p.communicate(timeout=10)
    print("SUCCESS:")
    print("STDOUT:", stdout)
    print("STDERR:", stderr)
except subprocess.TimeoutExpired:
    p.kill()
    print("TIMED OUT WITH -T AND --norc")
