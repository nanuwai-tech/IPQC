import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

print("Uploading start_service_clean.sh...", flush=True)
res_scp = subprocess.run(
    ['scp', '-i', key_path, '-o', 'StrictHostKeyChecking=no', 'start_service_clean.sh', f'ubuntu@{vm_ip}:/home/ubuntu/start_service_clean.sh'],
    capture_output=True,
    text=True,
    timeout=45
)
if res_scp.returncode != 0:
    print("SCP failed:\n", res_scp.stderr)
    exit(1)

print("Executing start_service_clean.sh on VM...", flush=True)
res_ssh = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', 'bash /home/ubuntu/start_service_clean.sh'],
    capture_output=True,
    text=True,
    timeout=90
)
print("=== SCRIPT OUTPUT ===")
print(res_ssh.stdout)
if res_ssh.stderr:
    print("=== SCRIPT STDERR ===")
    print(res_ssh.stderr)
