import sys
import os

_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_CURRENT_DIR)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)
if _CURRENT_DIR not in sys.path:
    sys.path.insert(0, _CURRENT_DIR)

import re
import json
import time
import urllib.request
import urllib.parse
from datetime import datetime, date
from decimal import Decimal
import psycopg2
from psycopg2.pool import SimpleConnectionPool
from psycopg2.extras import RealDictCursor

# Global DB Pool
_pg_pool = None
_last_failed_time = 0

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://yfpowaudcciepubtjkdr.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", os.environ.get("SUPABASE_ANON_KEY", "sb_publishable_shOnteL2raHE5OynKjPkPw_aHX3vp5F"))

# ── In-memory TTL cache for static/rarely-changing tables ─────────────────
# Reduces Supabase egress by serving repeated GET requests from RAM.
_STATIC_TABLE_CACHE: dict = {}          # { table: {"data": [...], "ts": float} }
_STATIC_CACHE_TTL: int = 300            # 5 minutes
_STATIC_CACHEABLE_TABLES = {"stations", "checklist_master", "sys_lines", "sys_defects"}

def _cache_get(table: str):
    """Return cached list for *table* if still fresh, else None."""
    entry = _STATIC_TABLE_CACHE.get(table)
    if entry and (time.time() - entry["ts"]) < _STATIC_CACHE_TTL:
        return entry["data"]
    return None

def _cache_set(table: str, data):
    """Store *data* in the TTL cache for *table*."""
    _STATIC_TABLE_CACHE[table] = {"data": data, "ts": time.time()}

def _cache_invalidate(table: str):
    """Evict *table* from the TTL cache (call on write operations)."""
    _STATIC_TABLE_CACHE.pop(table, None)
# ──────────────────────────────────────────────────────────────────────────


def get_pg_pool():
    global _pg_pool, _last_failed_time
    if _pg_pool is not None:
        return _pg_pool

    now = time.time()
    if (now - _last_failed_time) < 15:
        return None

    db_urls = [
        "postgresql://appuser:pg_pass_ab8b4b05859d46839003b565@127.0.0.1:5432/appdb"
    ]
    if os.environ.get("DATABASE_URL"):
        # If running locally on VM, translate public IP to localhost
        db_url_env = os.environ.get("DATABASE_URL").replace("192.9.135.138", "127.0.0.1")
        if db_url_env not in db_urls:
            db_urls.append(db_url_env)

    for url in db_urls:
        if not url:
            continue
        try:
            pool = SimpleConnectionPool(1, 20, url, connect_timeout=2)
            conn = pool.getconn()
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.close()
            pool.putconn(conn)
            _pg_pool = pool
            _last_failed_time = 0
            return _pg_pool
        except Exception:
            continue

    _last_failed_time = now
    return None

def json_serial(obj):
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    elif isinstance(obj, Decimal):
        return float(obj)
    return obj

def parse_postgrest_query(table: str, method: str = "GET", data: dict = None, params: str = ""):
    if table == "capas":
        table = "capa"
    
    where_clauses = []
    where_values = []
    select_cols = "*"
    order_clause = ""
    limit_clause = ""
    offset_clause = ""

    if params:
        or_match = re.search(r'or=\((.*?)\)', params)
        remaining_params = params
        if or_match:
            or_expr = or_match.group(1)
            remaining_params = params[:or_match.start()] + params[or_match.end():]
            or_parts = []
            for part in or_expr.split(','):
                part = part.strip()
                if not part:
                    continue
                m = re.match(r'^(\w+)\.(eq|neq|gte|lte|gt|lt|like|ilike)\.(.*)$', part)
                if m:
                    col, op, val = m.groups()
                    val = urllib.parse.unquote(val)
                    sql_op = {"eq": "=", "neq": "!=", "gte": ">=", "lte": "<=", "gt": ">", "lt": "<", "like": "LIKE", "ilike": "ILIKE"}.get(op, "=")
                    or_parts.append(f"{col} {sql_op} %s")
                    where_values.append(val)
            if or_parts:
                where_clauses.append("(" + " OR ".join(or_parts) + ")")

        parts = remaining_params.split('&')
        for p in parts:
            p = p.strip()
            if not p or '=' not in p:
                continue
            key, val = p.split('=', 1)
            key = key.strip()
            val = urllib.parse.unquote(val.strip())

            if key == 'select':
                select_cols = val if val else "*"
            elif key == 'order':
                order_parts = []
                for opart in val.split(','):
                    if '.' in opart:
                        col, dir = opart.split('.', 1)
                        order_parts.append(f"{col} {'DESC' if dir.lower() == 'desc' else 'ASC'}")
                    else:
                        order_parts.append(f"{opart} ASC")
                if order_parts:
                    order_clause = "ORDER BY " + ", ".join(order_parts)
            elif key == 'limit':
                try:
                    limit_clause = f"LIMIT {int(val)}"
                except Exception:
                    pass
            elif key == 'offset':
                try:
                    offset_clause = f"OFFSET {int(val)}"
                except Exception:
                    pass
            else:
                m = re.match(r'^(eq|neq|gte|lte|gt|lt|like|ilike)\.(.*)$', val)
                if m:
                    op, fval = m.groups()
                    sql_op = {"eq": "=", "neq": "!=", "gte": ">=", "lte": "<=", "gt": ">", "lt": "<", "like": "LIKE", "ilike": "ILIKE"}.get(op, "=")
                    where_clauses.append(f"{key} {sql_op} %s")
                    where_values.append(fval)
                else:
                    where_clauses.append(f"{key} = %s")
                    where_values.append(val)

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    if method.upper() == "GET":
        sql = f"SELECT {select_cols} FROM public.{table} {where_sql} {order_clause} {limit_clause} {offset_clause};".strip()
        return sql, tuple(where_values)

    elif method.upper() == "POST":
        if not data:
            return None, ()
        cols = list(data.keys())
        placeholders = ["%s"] * len(cols)
        col_names = ", ".join(cols)
        ph_str = ", ".join(placeholders)
        vals = [data[c] for c in cols]
        
        if table == "fai_master_profiles":
            update_cols = [f"{c} = EXCLUDED.{c}" for c in cols if c not in ("model_no", "pcb_pn")]
            if update_cols:
                sql = f"INSERT INTO public.{table} ({col_names}) VALUES ({ph_str}) ON CONFLICT (model_no, pcb_pn) DO UPDATE SET {', '.join(update_cols)} RETURNING *;"
            else:
                sql = f"INSERT INTO public.{table} ({col_names}) VALUES ({ph_str}) ON CONFLICT (model_no, pcb_pn) DO NOTHING RETURNING *;"
            return sql, tuple(vals)

        pk_map = {"users": "id", "stations": "id", "checklist_master": "item_no", "audits": "id", "capa": "id", "fai_audits": "audit_id"}
        pk = pk_map.get(table)
        if pk and pk in cols:
            update_cols = [f"{c} = EXCLUDED.{c}" for c in cols if c != pk]
            if update_cols:
                sql = f"INSERT INTO public.{table} ({col_names}) VALUES ({ph_str}) ON CONFLICT ({pk}) DO UPDATE SET {', '.join(update_cols)} RETURNING *;"
            else:
                sql = f"INSERT INTO public.{table} ({col_names}) VALUES ({ph_str}) ON CONFLICT ({pk}) DO NOTHING RETURNING *;"
        else:
            sql = f"INSERT INTO public.{table} ({col_names}) VALUES ({ph_str}) RETURNING *;"
        return sql, tuple(vals)

    elif method.upper() == "PATCH":
        if not data:
            return None, ()
        set_clauses = [f"{k} = %s" for k in data.keys()]
        vals = list(data.values()) + where_values
        sql = f"UPDATE public.{table} SET {', '.join(set_clauses)} {where_sql} RETURNING *;"
        return sql, tuple(vals)

    elif method.upper() == "DELETE":
        sql = f"DELETE FROM public.{table} {where_sql} RETURNING *;"
        return sql, tuple(where_values)

    return None, ()

def supabase_rest_fallback(endpoint: str, method: str = "GET", data: dict = None, params: str = ""):
    if endpoint == "capas":
        endpoint = "capa"
    if SUPABASE_URL.endswith("/rest/v1"):
        base_url = SUPABASE_URL
    elif "supabase.co" in SUPABASE_URL:
        base_url = f"{SUPABASE_URL.rstrip('/')}/rest/v1"
    else:
        base_url = SUPABASE_URL.rstrip('/')
    url = f"{base_url}/{endpoint}"
    if params:
        if " " in params:
            params = urllib.parse.quote(params, safe="=&?+,()[]:*")
        url += f"?{params}"
    # ── Egress Optimization ──────────────────────────────────────────────────
    # For writes (PATCH, DELETE, and heavy POSTs), use return=minimal.
    # When return=minimal is set, Supabase responds with HTTP 204 No Content (0 bytes egress).
    # Requesting return=representation causes Supabase to serialize and return the entire
    # modified rows across the wire (including huge base64 photos), causing severe egress spikes.
    if method.upper() in ("PATCH", "DELETE"):
        prefer_str = "return=minimal"
    elif method.upper() == "POST":
        if endpoint in ("fai_master_profiles", "fai_audits"):
            prefer_str = "resolution=merge-duplicates,return=minimal"
        else:
            prefer_str = "return=minimal"
    else:
        prefer_str = "return=representation"

    headers = {
        "Content-Type": "application/json",
        "Prefer": prefer_str
    }
    if SUPABASE_KEY and SUPABASE_KEY != "anon":
        headers["apikey"] = SUPABASE_KEY
        headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
    body = json.dumps(data).encode("utf-8") if data else None
    try:
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=25) as resp:
            res_body = resp.read().decode("utf-8")
            if not res_body:
                return [data] if (data and method.upper() == "POST") else []
            return json.loads(res_body)
    except Exception as e:
        err_msg = str(e)
        if hasattr(e, 'read'):
            try:
                err_msg += f" - {e.read().decode('utf-8')}"
            except Exception:
                pass
        print(f"[Supabase REST] {method} {url} error: {err_msg}")
        return None

import threading

def _async_sync_to_supabase(endpoint: str, method: str, data: dict, params: str):
    """Background worker to mirror writes from Oracle Primary DB to Supabase Secondary DB asynchronously."""
    def _worker():
        try:
            # Supabase audit_details and capa store the r2_key directly inside photo_url;
            # strip redundant 'r2_key' key to conform to Supabase PostgREST schema cache
            sync_data = data
            if isinstance(data, dict) and endpoint in ("audit_details", "capa", "audits"):
                sync_data = {k: v for k, v in data.items() if k != "r2_key"}
            supabase_rest_fallback(endpoint, method, sync_data, params)
        except Exception as e:
            print(f"[Supabase Backup Sync] {method} {endpoint} warning: {e}")
    threading.Thread(target=_worker, daemon=True).start()

def unified_db_query(endpoint: str, method: str = "GET", data: dict = None, params: str = ""):
    # ── Photo Sanitizer: Offload inline base64 images to Cloudflare R2 ────────
    if method.upper() in ("POST", "PATCH") and isinstance(data, dict):
        try:
            from api.r2_storage import sanitize_record_photos
            data = sanitize_record_photos(data, folder="uploads")
        except Exception:
            pass
    # ──────────────────────────────────────────────────────────────────────────

    # ── TTL cache: serve static tables from memory on unfiltered GETs ──────
    _cacheable = (
        method.upper() == "GET"
        and endpoint in _STATIC_CACHEABLE_TABLES
        and not params
    )
    if _cacheable:
        cached = _cache_get(endpoint)
        if cached is not None:
            return cached
    # ────────────────────────────────────────────────────────────────────────

    # PRIMARY: Oracle VM PostgreSQL (Local 127.0.0.1, 0 bytes egress, ~1-5ms latency)
    pool = get_pg_pool()
    if pool:
        sql, sql_params = parse_postgrest_query(endpoint, method, data, params)
        if sql:
            conn = None
            try:
                conn = pool.getconn()
                cur = conn.cursor(cursor_factory=RealDictCursor)
                cur.execute(sql, sql_params)
                if method.upper() == "GET" or "RETURNING" in sql:
                    rows = cur.fetchall()
                    conn.commit()
                    cur.close()
                    pool.putconn(conn)
                    conn = None
                    res = []
                    for r in rows:
                        row_dict = {}
                        for k, v in r.items():
                            row_dict[k] = json_serial(v)
                        res.append(row_dict)
                    # Populate cache for unfiltered GET on static tables
                    if _cacheable:
                        _cache_set(endpoint, res)
                    
                    # Mirror write to Secondary Supabase in background thread
                    if method.upper() in ("POST", "PATCH", "DELETE"):
                        _async_sync_to_supabase(endpoint, method, data, params)

                    return res
                else:
                    conn.commit()
                    cur.close()
                    pool.putconn(conn)
                    conn = None
                    # Writes invalidate the cache so next GET re-fetches fresh data
                    if endpoint in _STATIC_CACHEABLE_TABLES:
                        _cache_invalidate(endpoint)

                    # Mirror write to Secondary Supabase in background thread
                    if method.upper() in ("POST", "PATCH", "DELETE"):
                        _async_sync_to_supabase(endpoint, method, data, params)

                    return []
            except Exception:
                if conn:
                    try:
                        conn.rollback()
                        pool.putconn(conn)
                    except Exception:
                        pass

    # SECONDARY / FALLBACK: Supabase PostgREST (used if Oracle VM is down or outside VM)
    result = supabase_rest_fallback(endpoint, method, data, params)
    # Cache Supabase GET results for static tables; invalidate on writes
    if _cacheable and isinstance(result, list):
        _cache_set(endpoint, result)
    elif method.upper() in ("POST", "PATCH", "DELETE") and endpoint in _STATIC_CACHEABLE_TABLES:
        _cache_invalidate(endpoint)
    return result

def supabase_paginated_query(endpoint, params="", page_size=900):
    if params:
        param_parts = [p for p in params.split('&') if not p.startswith('limit=') and not p.startswith('offset=')]
        base_params = "&".join(param_parts)
    else:
        base_params = ""
    
    all_rows = []
    offset = 0
    max_total_rows = 5000
    
    while True:
        page_params = f"{base_params}&offset={offset}&limit={page_size}".strip('&')
        page_rows = supabase_rest_fallback(endpoint, method="GET", params=page_params)
        
        if not page_rows or not isinstance(page_rows, list):
            break
            
        all_rows.extend(page_rows)
        
        if len(page_rows) < page_size:
            break
            
        offset += page_size
        
        if len(all_rows) >= max_total_rows:
            break
            
    return all_rows

def unified_db_query_all(endpoint, params=""):
    pool = get_pg_pool()
    if pool:
        if params:
            param_parts = [p for p in params.split('&') if not p.startswith('limit=')]
            base_params = "&".join(param_parts)
            local_params = f"{base_params}&limit=10000".strip('&')
        else:
            local_params = "limit=10000"
            
        sql, sql_params = parse_postgrest_query(endpoint, "GET", None, local_params)
        if sql:
            conn = None
            try:
                conn = pool.getconn()
                cur = conn.cursor(cursor_factory=RealDictCursor)
                cur.execute(sql, sql_params)
                rows = cur.fetchall()
                conn.commit()
                cur.close()
                pool.putconn(conn)
                res = []
                for r in rows:
                    row_dict = {}
                    for k, v in r.items():
                        row_dict[k] = json_serial(v)
                    res.append(row_dict)
                return res
            except Exception:
                if conn:
                    try:
                        conn.rollback()
                        pool.putconn(conn)
                    except Exception:
                        pass
                        
    return supabase_paginated_query(endpoint, params)
