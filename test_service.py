import subprocess
import os
import time

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

def run_ssh(cmd, timeout=20):
    print("Running:", cmd)
    res = subprocess.run(
        ['ssh.exe', '-n', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', cmd],
        capture_output=True,
        text=True,
        timeout=timeout
    )
    print("STDOUT:", res.stdout)
    if res.stderr:
        print("STDERR:", res.stderr)
    return res

run_ssh('cd /home/ubuntu/ipqc-v1 && nohup ./venv/bin/python -m uvicorn api.index:app --host 0.0.0.0 --port 8082 > uvicorn.log 2>&1 & sleep 2 && head -n 15 uvicorn.log')
