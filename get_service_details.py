import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "systemctl show ipqc-v1.service -p MainPID,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode,UnitFileState && "
    "pid=$(systemctl show ipqc-v1.service -p MainPID --value) && "
    "echo \"Current MainPID: $pid\" && "
    "if [ \"$pid\" -gt 0 ] 2>/dev/null; then "
    "  ps -fp $pid || echo 'PID not running' ; "
    "  ls -la /proc/$pid/fd 2>/dev/null || true ; "
    "fi"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=60
)
print("=== SERVICE DETAILS ===")
print(res.stdout)
if res.stderr:
    print("=== STDERR ===")
    print(res.stderr)
