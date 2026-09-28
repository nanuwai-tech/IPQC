import subprocess
import os
import time

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

remote_cmd = (
    "echo '=== 1. SERVICE STATUS ===' && "
    "sudo -n systemctl is-active ipqc-v1.service ; "
    "echo '=== 2. LISTENING PORTS ===' && "
    "sudo -n ss -tlpn ; "
    "echo '=== 3. NGINX ERROR LOG ===' && "
    "sudo -n tail -n 20 /var/log/nginx/error.log ; "
    "echo '=== 4. SERVICE UNIT DEFINITION ===' && "
    "cat /etc/systemd/system/ipqc-v1.service ; "
    "echo '=== 5. NGINX CONFIG ===' && "
    "sudo -n cat /etc/nginx/sites-enabled/* ; "
    "echo '=== 6. CURL LOCAL 8082 ===' && "
    "curl -s -i --max-time 5 http://127.0.0.1:8082/health ; "
    "echo '' ; "
    "echo '=== 7. FIX SSH DNS DELAY ===' && "
    "echo 'UseDNS no' | sudo -n tee /etc/ssh/sshd_config.d/99-disable-dns.conf && "
    "sudo -n systemctl reload sshd"
)

t0 = time.time()
print("Starting SSH diagnostic run (approx 32s)...", flush=True)
res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=75
)
elapsed = time.time() - t0
print(f"Completed in {elapsed:.2f}s", flush=True)
print("=== STDOUT ===")
print(res.stdout)
if res.stderr:
    print("=== STDERR ===")
    print(res.stderr)
