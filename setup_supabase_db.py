import psycopg2
import json
import os
import hashlib
import uuid

db_host = 'aws-0-ap-northeast-1.pooler.supabase.com'
db_port = 5432
db_name = 'postgres'
db_user = 'postgres.hnzmfcqnlqbbjpaxuucg'
db_pass = '!Qaz7410@wsx7410'
json_path = os.path.join(os.path.dirname(__file__), 'checklist_master.json')

def hash_password(password: str) -> str:
    salt = b'IPQC_SALT_2026'
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000).hex()

print("Connecting to Supabase PostgreSQL...")
conn = psycopg2.connect(
    host=db_host,
    port=db_port,
    dbname=db_name,
    user=db_user,
    password=db_pass
)
cursor = conn.cursor()

# 1. Create Tables
print("Creating Database Tables in Supabase...")

cursor.execute("""
CREATE TABLE IF NOT EXISTS public.users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'auditor',
    line_assignment TEXT DEFAULT 'All Lines',
    language_pref TEXT DEFAULT 'zh',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.stations (
    id TEXT PRIMARY KEY,
    station_code TEXT UNIQUE NOT NULL,
    station_name TEXT NOT NULL,
    line_name TEXT NOT NULL,
    area_name TEXT DEFAULT 'SMT Surface Mount Area',
    process_type TEXT NOT NULL,
    sequence_order INTEGER DEFAULT 1,
    pos_x INTEGER DEFAULT 50,
    pos_y INTEGER DEFAULT 50,
    width INTEGER DEFAULT 220,
    height INTEGER DEFAULT 130,
    qr_code_url TEXT,
    status TEXT DEFAULT 'OK',
    last_audit_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- Add missing columns if stations table already existed
ALTER TABLE public.stations ADD COLUMN IF NOT EXISTS area_name TEXT DEFAULT 'SMT Surface Mount Area';
ALTER TABLE public.stations ADD COLUMN IF NOT EXISTS sequence_order INTEGER DEFAULT 1;
ALTER TABLE public.stations ADD COLUMN IF NOT EXISTS pos_x INTEGER DEFAULT 50;
ALTER TABLE public.stations ADD COLUMN IF NOT EXISTS pos_y INTEGER DEFAULT 50;
ALTER TABLE public.stations ADD COLUMN IF NOT EXISTS width INTEGER DEFAULT 220;
ALTER TABLE public.stations ADD COLUMN IF NOT EXISTS height INTEGER DEFAULT 130;
ALTER TABLE public.stations ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS public.checklist_master (
    id SERIAL PRIMARY KEY,
    item_no INTEGER UNIQUE NOT NULL,
    process TEXT NOT NULL,
    station_tag TEXT NOT NULL,
    requires_qty BOOLEAN DEFAULT FALSE,
    zh TEXT NOT NULL,
    en TEXT NOT NULL,
    th TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.audits (
    id TEXT PRIMARY KEY,
    station_code TEXT NOT NULL,
    station_name TEXT NOT NULL,
    line_name TEXT NOT NULL,
    auditor TEXT NOT NULL,
    shift TEXT NOT NULL,
    time_block TEXT NOT NULL,
    model_no TEXT NOT NULL,
    work_order TEXT DEFAULT 'WO-2026-0802-001',
    audit_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    overall_status TEXT DEFAULT 'OK',
    pass_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    na_count INTEGER DEFAULT 0
);

ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS work_order TEXT DEFAULT 'WO-2026-0802-001';

CREATE TABLE IF NOT EXISTS public.audit_details (
    id SERIAL PRIMARY KEY,
    audit_id TEXT REFERENCES public.audits(id) ON DELETE CASCADE,
    item_no INTEGER,
    result TEXT NOT NULL,
    qty INTEGER DEFAULT 0,
    remark TEXT,
    photo_url TEXT
);

CREATE TABLE IF NOT EXISTS public.capa (
    id TEXT PRIMARY KEY,
    audit_id TEXT,
    station_code TEXT NOT NULL,
    line_name TEXT NOT NULL,
    item_no INTEGER NOT NULL,
    defect_description TEXT NOT NULL,
    photo_url TEXT,
    severity TEXT DEFAULT 'HIGH',
    status TEXT DEFAULT 'OPEN',
    owner TEXT,
    root_cause TEXT,
    action_taken TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    due_date DATE
);

-- Cloudflare R2 Object Storage Keys (Zero DB payload bloat)
ALTER TABLE public.audit_details ADD COLUMN IF NOT EXISTS r2_key TEXT;
ALTER TABLE public.capa ADD COLUMN IF NOT EXISTS r2_key TEXT;

CREATE TABLE IF NOT EXISTS public.fai_master_profiles (
    id SERIAL PRIMARY KEY,
    model_no TEXT NOT NULL,
    pcb_pn TEXT NOT NULL,
    image_b64 TEXT DEFAULT '',
    r2_key TEXT,
    thumbnail_b64 TEXT,
    landmarks JSONB,
    landmark_count INTEGER DEFAULT 0,
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.fai_master_profiles ADD COLUMN IF NOT EXISTS r2_key TEXT;
""");

# Enable RLS & Add Public Access Policies
print("Configuring Row Level Security (RLS) & Policies...")
tables = ['users', 'stations', 'checklist_master', 'audits', 'audit_details', 'capa']
for t in tables:
    cursor.execute(f"ALTER TABLE public.{t} ENABLE ROW LEVEL SECURITY;")
    cursor.execute(f"DROP POLICY IF EXISTS \"allow_public_all_{t}\" ON public.{t};")
    cursor.execute(f"CREATE POLICY \"allow_public_all_{t}\" ON public.{t} FOR ALL USING (true) WITH CHECK (true);")

for t in tables:
    cursor.execute(f"GRANT ALL ON public.{t} TO anon, authenticated, postgres, service_role;")
cursor.execute("GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, postgres, service_role;")

# Seed Initial Default Users
print("Seeding Default Users (admin, supervisor1, auditor1)...")
default_users = [
    ("USR-ADMIN-01", "admin", hash_password("admin123"), "Norman Nan (QA Manager)", "admin", "All Lines", "zh"),
    ("USR-SUP-01", "supervisor1", hash_password("password123"), "John Tan (Line Supervisor)", "supervisor", "SMT Line 1", "en"),
    ("USR-AUD-01", "auditor1", hash_password("password123"), "Somchai (IPQC Inspector)", "auditor", "SMT Line 1", "th")
]

for uid, uname, p_hash, fname, urole, uline, ulang in default_users:
    cursor.execute("""
        INSERT INTO public.users (id, username, password_hash, full_name, role, line_assignment, language_pref)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (username) DO UPDATE SET
            password_hash = EXCLUDED.password_hash,
            full_name = EXCLUDED.full_name,
            role = EXCLUDED.role,
            line_assignment = EXCLUDED.line_assignment,
            language_pref = EXCLUDED.language_pref;
    """, (uid, uname, p_hash, fname, urole, uline, ulang))

# Seed Stations with Standard IPC/SMT Naming & Initial 2D Canvas Coordinates
print("Seeding Stations with Standard IPC/SMT Naming & 2D Canvas Layout Coordinates...")

cursor.execute("TRUNCATE TABLE public.stations RESTART IDENTITY CASCADE;")

default_stations = [
  # SMT Line 1 Sequence & Canvas Coordinates (Row 1: Y=40)
  ("SMT-L1-ESD-01", "SMT-L1-ESD-01", "Central ESD & IQC Material Station", "SMT Line 1", "Quality & ESD Area", "ESD", 1, 30, 40),
  ("SMT-L1-PRINT-01", "SMT-L1-PRINT-01", "Solder Paste Printer #1", "SMT Line 1", "SMT Surface Mount Area", "SMT-Printer", 2, 280, 40),
  ("SMT-L1-SPI-01", "SMT-L1-SPI-01", "3D Solder Paste Inspector #1", "SMT Line 1", "SMT Surface Mount Area", "SMT-SPI", 3, 530, 40),
  ("SMT-L1-MNT-01", "SMT-L1-MNT-01", "High-Speed Chip Mounter #1", "SMT Line 1", "SMT Surface Mount Area", "SMT-Mounter", 4, 780, 40),
  ("SMT-L1-OVEN-01", "SMT-L1-OVEN-01", "10-Zone Nitrogen Reflow Oven #1", "SMT Line 1", "SMT Surface Mount Area", "SMT-Reflow", 5, 1030, 40),
  ("SMT-L1-AOI-01", "SMT-L1-AOI-01", "3D AOI Post-Reflow Inspection #1", "SMT Line 1", "SMT Surface Mount Area", "SMT-AOI", 6, 1280, 40),
  
  # DIP Line 1 Sequence & Canvas Coordinates (Row 2: Y=230)
  ("DIP-L1-INS-01", "DIP-L1-INS-01", "DIP Through-Hole Insertion #1", "DIP Line 1", "DIP Through-Hole Area", "DIP-Insertion", 7, 280, 230),
  ("DIP-L1-WAVE-01", "DIP-L1-WAVE-01", "Dual-Wave Lead-Free Soldering #1", "DIP Line 1", "DIP Through-Hole Area", "DIP-Wave", 8, 530, 230),
  
  # Assembly Line 1 Sequence & Canvas Coordinates (Row 3: Y=420)
  ("ASY-L1-MAIN-01", "ASY-L1-MAIN-01", "Main Mechanical Assembly #1", "Assembly Line 1", "Assembly & Packaging Area", "Assembly", 9, 280, 420),
  ("ASY-L1-FCT-01", "ASY-L1-FCT-01", "FCT & ICT Programming Station #1", "Assembly Line 1", "Assembly & Packaging Area", "Programming & FCT", 10, 530, 420),
  ("ASY-L1-PACK-01", "ASY-L1-PACK-01", "Final Inspection & Box Packaging #1", "Assembly Line 1", "Assembly & Packaging Area", "Inspection & Packaging", 11, 780, 420)
]

for sid, scode, sname, sline, sarea, sproc, seq, px, py in default_stations:
    cursor.execute("""
        INSERT INTO public.stations (id, station_code, station_name, line_name, area_name, process_type, sequence_order, pos_x, pos_y, width, height, qr_code_url)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 210, 135, %s)
        ON CONFLICT (station_code) DO UPDATE SET
            station_name = EXCLUDED.station_name,
            line_name = EXCLUDED.line_name,
            area_name = EXCLUDED.area_name,
            process_type = EXCLUDED.process_type,
            sequence_order = EXCLUDED.sequence_order,
            pos_x = EXCLUDED.pos_x,
            pos_y = EXCLUDED.pos_y;
    """, (sid, scode, sname, sline, sarea, sproc, seq, px, py, f"https://audit.company.com/station/{scode}"))

# Seed Checklist Master (103 Items)
print("Seeding Master Checklist Items (103 Items)...")
if os.path.exists(json_path):
    with open(json_path, 'r', encoding='utf-8') as f:
        items = json.load(f)
        for item in items:
            cursor.execute("""
                INSERT INTO public.checklist_master (item_no, process, station_tag, requires_qty, zh, en, th)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (item_no) DO UPDATE SET
                    process = EXCLUDED.process,
                    station_tag = EXCLUDED.station_tag,
                    requires_qty = EXCLUDED.requires_qty,
                    zh = EXCLUDED.zh,
                    en = EXCLUDED.en,
                    th = EXCLUDED.th;
            """, (
                item['item_no'], item['process'], item.get('station_tag', 'ESD'),
                item['requires_qty'], item['zh'], item['en'], item['th']
            ))

# Seed Initial CAPAs
print("Seeding Initial CAPA Anomaly Tickets...")
cursor.execute("SELECT COUNT(*) FROM public.capa;")
if cursor.fetchone()[0] == 0:
    cursor.execute("""
        INSERT INTO public.capa (id, audit_id, station_code, line_name, item_no, defect_description, photo_url, severity, status, owner, due_date)
        VALUES 
        ('CAPA-2026-001', 'AUD-1001', 'SMT-L1-OVEN-01', 'SMT Line 1', 70, 'Nitrogen Flow rate below 150L/min threshold', 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=500', 'HIGH', 'OPEN', 'Norman Nan (Line Supervisor)', CURRENT_DATE + INTERVAL '2 days'),
        ('CAPA-2026-002', 'AUD-1002', 'SMT-L1-ESD-01', 'Global Factory', 3, 'Operator wrist strap grounding wire unclipped at Station 4', 'https://images.unsplash.com/photo-1581092335397-9583fe92d232?w=500', 'MEDIUM', 'INVESTIGATING', 'John Tan (QA Eng)', CURRENT_DATE + INTERVAL '2 days');
    """)

conn.commit()

cursor.execute("SELECT COUNT(*) FROM public.stations;")
st_cnt = cursor.fetchone()[0]

cursor.execute("SELECT COUNT(*) FROM public.checklist_master;")
item_cnt = cursor.fetchone()[0]

conn.close()

print("\n==================================================")
print("  SUPABASE 2D CANVAS OBJECT LAYOUT UPDATED!       ")
print("==================================================")
print(f"- Stations Table: {st_cnt} records with standard IPC codes and X/Y coordinates")
print("==================================================")
