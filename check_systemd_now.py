import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "systemctl show ipqc-v1.service -p MainPID,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode ; "
    "echo '--- UVICORN PROCESSES ---' ; "
    "pgrep -a -f 'uvicorn' || echo 'No uvicorn processes' ; "
    "echo '--- TAIL ERR LOG ---' ; "
    "tail -n 20 /home/ubuntu/ipqc-v1/systemd_err.log 2>/dev/null || true ; "
    "echo '--- TAIL OUT LOG ---' ; "
    "tail -n 20 /home/ubuntu/ipqc-v1/systemd_out.log 2>/dev/null || true"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print("=== SERVICE STATE ===")
print(res.stdout)
if res.stderr:
    print("STDERR:\n", res.stderr)
