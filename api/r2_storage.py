import os
import uuid
import re
import json
import base64
import urllib.request
import urllib.parse
from typing import Optional, List, Dict, Any

try:
    import boto3
    from botocore.config import Config
    BOTO3_AVAILABLE = True
except ImportError:
    boto3 = None
    Config = None
    BOTO3_AVAILABLE = False

# ==============================================================================
# Cloudflare R2 & KV Configuration
# ==============================================================================
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", os.environ.get("R2_ACCOUNT_ID", ""))
CF_R2_ACCESS_KEY_ID = os.environ.get("CF_R2_ACCESS_KEY_ID", os.environ.get("R2_ACCESS_KEY_ID", ""))
CF_R2_SECRET_ACCESS_KEY = os.environ.get("CF_R2_SECRET_ACCESS_KEY", os.environ.get("R2_SECRET_ACCESS_KEY", ""))
CF_R2_BUCKET_NAME = os.environ.get("CF_R2_BUCKET_NAME", os.environ.get("R2_BUCKET_NAME", "small-tooth-cf61"))
CF_R2_PUBLIC_DOMAIN = os.environ.get("CF_R2_PUBLIC_DOMAIN", os.environ.get("CF_WORKER_DOMAIN", "")).rstrip("/")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", os.environ.get("CLOUDFLARE_API_TOKEN", ""))
CF_KV_NAMESPACE_ID = os.environ.get("CF_KV_NAMESPACE_ID", os.environ.get("CLOUDFLARE_KV_NAMESPACE_ID", ""))

_s3_client = None

def get_r2_client():
    global _s3_client
    if _s3_client is not None:
        return _s3_client
    
    if not BOTO3_AVAILABLE or not CF_ACCOUNT_ID or not CF_R2_ACCESS_KEY_ID or not CF_R2_SECRET_ACCESS_KEY:
        return None

    try:
        endpoint = f"https://{CF_ACCOUNT_ID}.r2.cloudflarestorage.com"
        _s3_client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=CF_R2_ACCESS_KEY_ID,
            aws_secret_access_key=CF_R2_SECRET_ACCESS_KEY,
            config=Config(signature_version="s3v4"),
            region_name="auto"
        )
        return _s3_client
    except Exception as e:
        print(f"[R2 Storage] Failed to initialize S3 client: {e}")
        return None

def generate_presigned_upload_url(
    filename: str,
    content_type: str = "image/jpeg",
    folder: str = "uploads",
    expires_in: int = 3600
) -> Dict[str, Any]:
    """
    Generates an S3-compatible pre-signed PUT URL for direct client upload to Cloudflare R2.
    Returns upload_url, r2_key, and public_url.
    """
    clean_name = re.sub(r'[^a-zA-Z0-9._-]', '_', filename or "image.jpg")
    clean_folder = re.sub(r'[^a-zA-Z0-9/_-]', '', folder or "uploads").strip("/")
    r2_key = f"{clean_folder}/{uuid.uuid4().hex[:12]}_{clean_name}" if clean_folder else f"{uuid.uuid4().hex[:12]}_{clean_name}"

    client = get_r2_client()
    if client:
        try:
            upload_url = client.generate_presigned_url(
                ClientMethod="put_object",
                Params={
                    "Bucket": CF_R2_BUCKET_NAME,
                    "Key": r2_key,
                    "ContentType": content_type,
                    "CacheControl": "public, max-age=31536000, immutable"
                },
                ExpiresIn=expires_in,
                HttpMethod="PUT"
            )
            public_base = CF_R2_PUBLIC_DOMAIN or f"https://{CF_ACCOUNT_ID}.r2.cloudflarestorage.com/{CF_R2_BUCKET_NAME}"
            return {
                "success": True,
                "upload_url": upload_url,
                "r2_key": r2_key,
                "public_url": f"{public_base}/{r2_key}",
                "content_type": content_type,
                "expires_in": expires_in,
                "bucket": CF_R2_BUCKET_NAME
            }
        except Exception as e:
            print(f"[R2 Storage] Presigned URL generation failed: {e}")
            return {
                "success": False,
                "error": str(e),
                "r2_key": r2_key,
                "upload_url": "",
                "public_url": ""
            }

    # Fallback response if R2 is not yet configured with valid credentials
    mock_url = f"/api/storage/mock-upload/{r2_key}"
    return {
        "success": True,
        "upload_url": mock_url,
        "r2_key": r2_key,
        "public_url": f"/api/storage/mock-file/{r2_key}",
        "content_type": content_type,
        "expires_in": expires_in,
        "bucket": CF_R2_BUCKET_NAME,
        "is_mock": True
    }

def purge_cloudflare_kv_cache(keys: List[str] | str) -> Dict[str, Any]:
    """
    Purges edge cache keys from Cloudflare KV to invalidate stale thumbnail and profile caches.
    """
    if not CF_ACCOUNT_ID or not CF_KV_NAMESPACE_ID or not CF_API_TOKEN:
        return {"success": False, "message": "Cloudflare KV credentials not configured."}

    if isinstance(keys, str):
        keys = [keys]

    if not keys:
        return {"success": True, "purged_count": 0}

    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_KV_NAMESPACE_ID}/bulk"
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json"
    }

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(keys).encode("utf-8"),
            headers=headers,
            method="DELETE"
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return {
                "success": data.get("success", False),
                "purged_count": len(keys),
                "keys": keys,
                "raw_response": data
            }
    except Exception as e:
        print(f"[Cloudflare KV Purge Error] {e}")
        return {"success": False, "error": str(e), "keys": keys}

def purge_master_profile_cache(model_no: str, pcb_pn: str, r2_key: Optional[str] = None) -> Dict[str, Any]:
    """
    Convenience helper to purge all KV thumbnail & variant keys for a master profile.
    """
    slug_model = re.sub(r'[\s\-_/.]+', '', str(model_no or '').lower())
    slug_pn = re.sub(r'[\s\-_/.]+', '', str(pcb_pn or '').lower())
    slug_key = f"{slug_model}_{slug_pn}"

    keys_to_purge = [
        f"thumb:master:{slug_key}",
        f"thumb:master:{slug_key}:360x360",
        f"thumb:master:{slug_key}:180x180",
        f"profile:master:{slug_key}"
    ]
    if r2_key:
        keys_to_purge.extend([
            f"thumb:{r2_key}",
            f"thumb:{r2_key}:360x360",
            f"thumb:{r2_key}:180x180"
        ])

    return purge_cloudflare_kv_cache(keys_to_purge)


def upload_bytes_to_r2(
    data: bytes,
    filename: str,
    content_type: str = "image/jpeg",
    folder: str = "uploads"
) -> Dict[str, Any]:
    """
    Directly uploads raw binary bytes to Cloudflare R2 bucket.
    """
    clean_name = re.sub(r'[^a-zA-Z0-9._-]', '_', filename or "upload.jpg")
    clean_folder = re.sub(r'[^a-zA-Z0-9/_-]', '', folder or "uploads").strip("/")
    r2_key = f"{clean_folder}/{uuid.uuid4().hex[:12]}_{clean_name}" if clean_folder else f"{uuid.uuid4().hex[:12]}_{clean_name}"

    client = get_r2_client()
    if client:
        try:
            client.put_object(
                Bucket=CF_R2_BUCKET_NAME,
                Key=r2_key,
                Body=data,
                ContentType=content_type,
                CacheControl="public, max-age=31536000, immutable"
            )
            public_base = CF_R2_PUBLIC_DOMAIN or f"https://{CF_ACCOUNT_ID}.r2.cloudflarestorage.com/{CF_R2_BUCKET_NAME}"
            return {
                "success": True,
                "r2_key": r2_key,
                "public_url": f"{public_base}/{r2_key}",
                "content_type": content_type
            }
        except Exception as e:
            print(f"[R2 Storage] Direct put_object failed: {e}")
            return {"success": False, "error": str(e), "r2_key": ""}

    return {"success": False, "error": "R2 client not initialized", "r2_key": ""}


def upload_base64_to_r2(
    b64_str: str,
    folder: str = "uploads",
    filename_prefix: str = "photo"
) -> str:
    """
    Sanitizes base64 image strings: decodes and writes them directly to Cloudflare R2,
    returning the tiny r2_key string. If already an URL or r2_key, returns as-is.
    """
    if not b64_str or not isinstance(b64_str, str):
        return ""

    b64_clean = b64_str.strip()

    # If it's already an HTTP URL or an existing R2 key, no upload needed
    if b64_clean.startswith("http://") or b64_clean.startswith("https://") or b64_clean.startswith("uploads/") or b64_clean.startswith("master_profiles/"):
        return b64_clean

    # Detect base64 Data URI or raw base64 string
    content_type = "image/jpeg"
    ext = "jpg"
    raw_b64 = b64_clean

    if b64_clean.startswith("data:image/"):
        header_match = re.match(r'^data:image/([a-zA-Z0-9+.-]+);base64,(.*)$', b64_clean, re.DOTALL)
        if header_match:
            sub_type = header_match.group(1).lower()
            if "png" in sub_type:
                content_type = "image/png"
                ext = "png"
            elif "webp" in sub_type:
                content_type = "image/webp"
                ext = "webp"
            elif "gif" in sub_type:
                content_type = "image/gif"
                ext = "gif"
            raw_b64 = header_match.group(2)
        else:
            parts = b64_clean.split(",", 1)
            if len(parts) == 2:
                raw_b64 = parts[1]

    # Check minimum length to avoid treating short strings as base64
    if len(raw_b64) < 100:
        return b64_clean

    try:
        data = base64.b64decode(raw_b64)
        filename = f"{filename_prefix}.{ext}"
        res = upload_bytes_to_r2(data=data, filename=filename, content_type=content_type, folder=folder)
        if res.get("success") and res.get("r2_key"):
            return res["r2_key"]
    except Exception as e:
        print(f"[R2 Storage] Base64 decoding/upload failed: {e}")

    # Fallback to original string if upload fails to guarantee zero operational interruption
    return b64_clean


def resolve_image_url(image_ref: str, width: Optional[int] = None, height: Optional[int] = None) -> str:
    """
    Resolves an image reference (r2_key, public URL, or base64 data URI) to a playable browser URL.
    Supports Cloudflare Worker thumbnail resizing when width/height are specified.
    """
    if not image_ref or not isinstance(image_ref, str):
        return ""

    # If it's already an HTTP URL or inline Data URI, return directly
    if image_ref.startswith("http://") or image_ref.startswith("https://") or image_ref.startswith("data:image/"):
        return image_ref

    # Otherwise it's an r2_key: build URL via Cloudflare Worker or R2 endpoint
    base_domain = CF_R2_PUBLIC_DOMAIN or f"https://{CF_ACCOUNT_ID}.r2.cloudflarestorage.com/{CF_R2_BUCKET_NAME}"
    url = f"{base_domain}/{image_ref.lstrip('/')}"

    if width and height:
        url += f"?w={int(width)}&h={int(height)}"
    elif width:
        url += f"?w={int(width)}"
    elif height:
        url += f"?h={int(height)}"

    return url


def sanitize_record_photos(record: Dict[str, Any], folder: str = "uploads") -> Dict[str, Any]:
    """
    Scans a database record dictionary and transparently offloads large base64 image
    attributes to Cloudflare R2, storing only the lightweight r2_key.
    """
    if not isinstance(record, dict):
        return record

    target_fields = ["photo_url", "image_b64", "pcba_photo_url"]
    for field in target_fields:
        val = record.get(field)
        if isinstance(val, str) and (val.startswith("data:image/") or len(val) > 500):
            r2_key = upload_base64_to_r2(val, folder=folder, filename_prefix=field)
            if r2_key and not r2_key.startswith("data:image/"):
                record[field] = r2_key
                record["r2_key"] = r2_key

    # Also sanitize details list if present
    details = record.get("details")
    if isinstance(details, list):
        for item in details:
            if isinstance(item, dict):
                p_url = item.get("photo_url")
                if isinstance(p_url, str) and (p_url.startswith("data:image/") or len(p_url) > 500):
                    item["photo_url"] = upload_base64_to_r2(p_url, folder=folder, filename_prefix="detail")
                    item["r2_key"] = item["photo_url"]

    return record
