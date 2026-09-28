import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

def run_ssh(remote_cmd, timeout=15):
    res = subprocess.run(
        ['ssh', '-n', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=timeout
    )
    return res.stdout, res.stderr

print("1. Checking service is-active:")
out, err = run_ssh("sudo -n systemctl is-active ipqc-v1.service")
print("Status:", out.strip(), err.strip())

print("\n2. Checking localhost:8082 curl:")
out, err = run_ssh("curl -s http://127.0.0.1:8082/health || curl -s http://127.0.0.1:8082/")
print("Curl output:\n", out[:500])

print("\n3. Testing Python import:")
out, err = run_ssh("cd /home/ubuntu/ipqc-v1 && /home/ubuntu/ipqc-v1/venv/bin/python3 -c 'import api.index; print(\"IMPORT SUCCESS\")'")
print("Python import:\n", out, err)
