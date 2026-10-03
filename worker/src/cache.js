const CACHE_HOST = "https://livery-watch.cache";
const memory = new Map();

/** JSON cache: Cloudflare's Cache API when available, plus memory within one isolate. */
export async function cached(key, ttlSeconds, produce) {
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && hit.expires > now) return hit.value;

  const store = globalThis.caches?.default;
  const url = `${CACHE_HOST}/${encodeURIComponent(key)}`;
  if (store) {
    const response = await store.match(url);
    if (response) {
      const value = await response.json();
      memory.set(key, { value, expires: now + ttlSeconds * 1000 });
      return value;
    }
  }

  const value = await produce();
  memory.set(key, { value, expires: now + ttlSeconds * 1000 });
  if (store) {
    await store.put(url, new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttlSeconds}` },
    }));
  }
  return value;
}

export function clearMemoryCache() {
  memory.clear();
}
