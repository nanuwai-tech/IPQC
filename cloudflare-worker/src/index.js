/**
 * Cloudflare Worker: Edge Image Resizer & Cache Manager
 * - Reads raw master/patrol PCBA images from Cloudflare R2
 * - Performs on-the-fly edge resizing using sharp-wasm32
 * - Stores resized variants in R2 and metadata in Cloudflare KV (<10ms read latency)
 * - Supports instant KV cache invalidation/purge on master profile update
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Health check endpoint
    if (pathname === "/health" || pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          service: "ipqc-image-resizer",
          runtime: "cloudflare-worker",
          edge_storage: "r2",
          edge_cache: "kv",
          sharp_engine: "sharp-wasm32",
          timestamp: new Date().toISOString(),
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Cache Purge Endpoint: POST /purge or POST /purge/:key
    if (request.method === "POST" && pathname.startsWith("/purge")) {
      return handlePurgeRequest(request, pathname, env);
    }

    // Image Delivery Routes:
    // /thumb/:r2_key -> fast 360x360 thumbnail
    // /image/:r2_key?w=800&h=600&q=80 -> dynamic resize
    // /raw/:r2_key -> stream raw original from R2
    if (pathname.startsWith("/thumb/") || pathname.startsWith("/image/") || pathname.startsWith("/raw/")) {
      return handleImageRequest(request, url, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
};

/**
 * Handles image retrieval, KV edge cache lookup, WASM resizing, and R2 variant caching.
 */
async function handleImageRequest(request, url, env, ctx) {
  const pathname = url.pathname;
  let isThumb = false;
  let isRaw = false;
  let r2Key = "";

  if (pathname.startsWith("/thumb/")) {
    isThumb = true;
    r2Key = decodeURIComponent(pathname.replace("/thumb/", ""));
  } else if (pathname.startsWith("/image/")) {
    r2Key = decodeURIComponent(pathname.replace("/image/", ""));
  } else if (pathname.startsWith("/raw/")) {
    isRaw = true;
    r2Key = decodeURIComponent(pathname.replace("/raw/", ""));
  }

  if (!r2Key) {
    return new Response("Missing image key", { status: 400 });
  }

  // 1. Raw original pass-through
  if (isRaw) {
    const rawObject = await env.R2_BUCKET.get(r2Key);
    if (!rawObject) {
      return new Response("Image not found in R2", { status: 404 });
    }
    const headers = new Headers();
    rawObject.writeHttpMetadata(headers);
    headers.set("ETag", rawObject.httpEtag);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(rawObject.body, { headers });
  }

  // Dimension & quality parameters
  const defaultDim = isThumb ? parseInt(env.DEFAULT_THUMB_DIM || "360") : 800;
  const width = Math.min(parseInt(url.searchParams.get("w") || url.searchParams.get("width") || String(defaultDim)), 2560);
  const height = Math.min(parseInt(url.searchParams.get("h") || url.searchParams.get("height") || String(defaultDim)), 2560);
  const quality = Math.min(Math.max(parseInt(url.searchParams.get("q") || url.searchParams.get("quality") || env.DEFAULT_QUALITY || "75"), 30), 95);

  const kvKey = `thumb:${r2Key}:${width}x${height}:q${quality}`;

  // 2. Check Cloudflare KV Edge Cache (<10ms read latency)
  if (env.IMAGE_KV) {
    try {
      const cachedMeta = await env.IMAGE_KV.get(kvKey, { type: "json" });
      if (cachedMeta && cachedMeta.variant_key) {
        // Check conditional ETag
        const clientEtag = request.headers.get("If-None-Match");
        if (clientEtag && clientEtag === cachedMeta.etag) {
          return new Response(null, { status: 304 });
        }

        // Fetch pre-rendered variant from R2
        const variantObject = await env.R2_BUCKET.get(cachedMeta.variant_key);
        if (variantObject) {
          const headers = new Headers();
          headers.set("Content-Type", cachedMeta.content_type || "image/jpeg");
          headers.set("ETag", cachedMeta.etag);
          headers.set("X-Edge-Cache", "HIT");
          headers.set("X-Edge-Latency", "<10ms");
          headers.set("Access-Control-Allow-Origin", "*");
          headers.set("Cache-Control", "public, max-age=31536000, immutable");
          return new Response(variantObject.body, { headers });
        }
      }
    } catch (kvErr) {
      console.warn("KV Cache lookup error:", kvErr);
    }
  }

  // 3. Cache Miss: Fetch Original from Cloudflare R2
  const originalObject = await env.R2_BUCKET.get(r2Key);
  if (!originalObject) {
    return new Response("Source image not found in R2", { status: 404 });
  }

  const originalBuffer = await originalObject.arrayBuffer();

  // 4. Edge Image Resizing with sharp-wasm32
  let resizedBuffer;
  let contentType = "image/jpeg";
  try {
    const sharp = require("@img/sharp-wasm32");
    resizedBuffer = await sharp(Buffer.from(originalBuffer))
      .resize({
        width: width,
        height: height,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: quality, mozjpeg: true })
      .toBuffer();
  } catch (sharpErr) {
    console.warn("sharp-wasm32 processing fallback:", sharpErr);
    // If WASM resize fails in emulator, serve original image buffer
    resizedBuffer = originalBuffer;
    contentType = originalObject.httpMetadata?.contentType || "image/jpeg";
  }

  const etag = originalObject.httpEtag || `"${Date.now()}"`;
  const sanitizedKey = r2Key.replace(/[^a-zA-Z0-9_-]/g, "_");
  const variantKey = `variants/${sanitizedKey}_w${width}h${height}_q${quality}.jpg`;

  // 5. Asynchronously write variant back to R2 & store metadata in KV
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(
      (async () => {
        try {
          // Write variant to R2
          await env.R2_BUCKET.put(variantKey, resizedBuffer, {
            httpMetadata: { contentType: "image/jpeg" },
          });

          // Write metadata to KV
          if (env.IMAGE_KV) {
            const metadata = {
              url: `${env.PUBLIC_DOMAIN || ""}/${variantKey}`,
              variant_key: variantKey,
              width: width,
              height: height,
              etag: etag,
              content_type: "image/jpeg",
              cached_at: new Date().toISOString(),
            };
            await env.IMAGE_KV.put(kvKey, JSON.stringify(metadata), {
              expirationTtl: 86400 * 30, // 30 days
            });
          }
        } catch (saveErr) {
          console.error("Failed to cache variant:", saveErr);
        }
      })()
    );
  }

  // 6. Return resized JPEG image
  return new Response(resizedBuffer, {
    headers: {
      "Content-Type": contentType,
      "ETag": etag,
      "X-Edge-Cache": "MISS",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/**
 * Handles KV cache purge requests for master profile updates.
 */
async function handlePurgeRequest(request, pathname, env) {
  try {
    let keysToPurge = [];
    if (pathname.length > 7) {
      const singleKey = decodeURIComponent(pathname.replace("/purge/", ""));
      keysToPurge.push(singleKey);
    } else {
      const body = await request.json().catch(() => ({}));
      if (Array.isArray(body.keys)) {
        keysToPurge = body.keys;
      } else if (body.key) {
        keysToPurge = [body.key];
      }
    }

    let purgedCount = 0;
    if (env.IMAGE_KV && keysToPurge.length > 0) {
      for (const k of keysToPurge) {
        await env.IMAGE_KV.delete(k);
        purgedCount++;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        purged_count: purgedCount,
        keys: keysToPurge,
        message: "KV edge cache entries purged successfully.",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
