import os, subprocess, sys

sys.stdout.reconfigure(encoding='utf-8')
res = subprocess.run(['git', 'ls-files', '-m'], capture_output=True, text=True)
files_to_update = [f for f in res.stdout.split('\n') if f and f != 'deploy_oracle.py' and f != 'update_deploy_oracle.py']
for extra in ['api/r2_storage.py', 'test_r2_kv.py', 'setup_supabase_db.py']:
    if os.path.exists(extra) and extra not in files_to_update:
        files_to_update.append(extra)

template = '''import tarfile
import subprocess
import os

files_to_update = FILES_PLACEHOLDER
tar_path = 'dist_update_fai.tar.gz'

print(f"Creating {tar_path}...")
with tarfile.open(tar_path, "w:gz") as tar:
    for f in files_to_update:
        if os.path.exists(f):
            print(f"Adding {f}")
            tar.add(f, arcname=f)
        else:
            print(f"WARNING: {f} not found!")

key_path = os.path.expanduser('~/.ssh/oracle_vm_key')
vm_ip = '192.9.135.138'

print("Transferring to Oracle VM via SCP...")
scp_res = subprocess.run(
    ['scp', '-i', key_path, '-o', 'StrictHostKeyChecking=no', tar_path, f'ubuntu@{vm_ip}:/home/ubuntu/dist_update_fai.tar.gz'],
    capture_output=True,
    text=True
)
if scp_res.returncode != 0:
    print("SCP Failed!")
    print(scp_res.stderr)
    exit(1)

print("Extracting and restarting service on Oracle VM...")
remote_cmd = "tar -xzf /home/ubuntu/dist_update_fai.tar.gz -C /home/ubuntu/ipqc-v1/ && sudo -n systemctl restart ipqc-v1.service && sudo -n systemctl is-active ipqc-v1.service"

ssh_res = subprocess.run(
    ['ssh', '-i', key_path, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', f'ubuntu@{vm_ip}', remote_cmd],
    capture_output=True,
    text=True,
    timeout=35
)
print("SSH STDOUT:\\n" + ssh_res.stdout)
if ssh_res.stderr:
    print("SSH STDERR:\\n" + ssh_res.stderr)

print("Oracle VM Deployment Complete!")
'''

with open('deploy_oracle.py', 'w', encoding='utf-8') as f:
    f.write(template.replace('FILES_PLACEHOLDER', repr(files_to_update)))

print('deploy_oracle.py generated. Executing deployment to Oracle VM...')
deploy_res = subprocess.run([sys.executable, 'deploy_oracle.py'])
sys.exit(deploy_res.returncode)
