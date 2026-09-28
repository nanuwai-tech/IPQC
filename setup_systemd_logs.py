import subprocess
import os

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

# Configure explicit file logging in systemd unit so we can inspect output directly without journalctl
unit_content = """[Unit]
Description=Smart IPQC Digital Audit System Mirror
After=network.target postgresql.service docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/ipqc-v1
ExecStart=/home/ubuntu/ipqc-v1/venv/bin/uvicorn api.index:app --host 0.0.0.0 --port 8082
Restart=always
RestartSec=5
EnvironmentFile=/home/ubuntu/ipqc-v1/.env
StandardOutput=append:/home/ubuntu/ipqc-v1/systemd_out.log
StandardError=append:/home/ubuntu/ipqc-v1/systemd_err.log

[Install]
WantedBy=multi-user.target
"""

remote_cmd = (
    f"cat << 'EOF' | sudo tee /etc/systemd/system/ipqc-v1.service > /dev/null\n{unit_content}\nEOF\n"
    "sudo systemctl daemon-reload && "
    "> /home/ubuntu/ipqc-v1/systemd_out.log && "
    "> /home/ubuntu/ipqc-v1/systemd_err.log && "
    "sudo systemctl restart ipqc-v1.service && "
    "sleep 15 && "
    "echo '=== SYSTEMD OUT ===' && cat /home/ubuntu/ipqc-v1/systemd_out.log && "
    "echo '=== SYSTEMD ERR ===' && cat /home/ubuntu/ipqc-v1/systemd_err.log && "
    "echo '=== SS 8082 ===' && sudo ss -tlpn | grep 8082 || echo 'Port 8082 not open'"
)

res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=90
)
print("=== OUTPUT ===")
print(res.stdout)
if res.stderr:
    print("=== STDERR ===")
    print(res.stderr)
