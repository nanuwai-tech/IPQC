import tarfile
import subprocess
import os

files_to_update = [
    'public/index.html',
    'public/js/app.js',
    'public/js/checklist_data.js',
    'public/js/fai_app.js',
    'FAI/public/fai_index.html',
    'FAI/public/js/fai_app.js',
    'api/db_adapter.py',
    'api/index.py',
    'api/pcba_inspection_service.py',
    'api/requirements.txt',
    'deploy_vercel.bat',
    'requirements.txt',
    'setup_supabase_db.py',
    'api/r2_storage.py',
    'test_r2_kv.py'
]
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
print("SSH STDOUT:\n" + ssh_res.stdout)
if ssh_res.stderr:
    print("SSH STDERR:\n" + ssh_res.stderr)

print("Oracle VM Deployment Complete!")
