import subprocess
import os
import time

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

t0 = time.time()
print("Starting SSH echo test...", flush=True)
res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', 'echo SSH_HELLO_WORLD'],
    capture_output=True,
    text=True,
    timeout=35
)
elapsed = time.time() - t0
print(f"Elapsed: {elapsed:.2f}s", flush=True)
print("Returncode:", res.returncode, flush=True)
print("STDOUT:", res.stdout, flush=True)
if res.stderr:
    print("STDERR:", res.stderr, flush=True)
