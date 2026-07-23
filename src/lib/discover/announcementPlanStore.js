// Durable, server-accessible announcement plan store (Blocker 2).
//
// ---------------------------------------------------------------------------
// WHAT THIS STORES AND WHY IT MUST BE DURABLE
// ---------------------------------------------------------------------------
// The opaque plan id (announcementPlan.computePlanId) is a SHA-256 digest — it is
// deliberately NOT self-describing, so the URL leaks no tracked titles and can
// never overflow. The trade-off: the server cannot rebuild the query set from the
// id alone. It needs the normalized plan (the actual search terms) that the id
// stands for. This module is that mapping:  opaque id -> { terms }.
//
// A GET (the normal, CDN-cacheable mount path) carries ONLY the id; the server
// looks the terms up here. So this lookup MUST survive serverless cold starts and
// be shared across instances/POPs — an in-process Map alone would lose every
// registration on the next cold start, turning ordinary mounts into permanent
// PLAN_NOT_REGISTERED misses. Durability is a correctness requirement here, unlike
// the announcement *result* cache (where the Vercel CDN is the durable layer and
// the in-process Map is only a warm-invocation optimisation).
//
// ---------------------------------------------------------------------------
// BACKENDS (and ACTUAL persistence guarantees)
// ---------------------------------------------------------------------------
//   1. DURABLE — a Redis-compatible REST KV (Vercel KV or Upstash Redis), used
//      automatically when its env vars are present. Reached over HTTPS with the
//      server-only token (no npm dependency, key never sent to the client). This
//      is the real production persistence: registrations survive cold starts and
//      are shared across every serverless instance. TTL is enforced by the store
//      (EX seconds), giving bounded storage + expiry for free.
//
//   2. FALLBACK — a bounded, TTL'd in-process Map, used ONLY when no KV env is
//      configured (e.g. a preview without KV wired up, or tests). It is explicitly
//      NOT durable across invocations and is documented as such; the endpoint's
//      recoverable PLAN_NOT_REGISTERED response means a lost registration is
//      re-established by the client's POST rather than being a hard failure.
//
// Configure the durable backend with EITHER pair of env vars:
//   KV_REST_API_URL + KV_REST_API_TOKEN            (Vercel KV)
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (Upstash Redis)

export const PLAN_STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
export const PLAN_STORE_MAX_ENTRIES = 500

const KEY_PREFIX = 'rerun:discover:plan:'

// Bounded, expiring, corruption-safe in-process store. Best-effort only.
export function createMemoryPlanStore({ max = PLAN_STORE_MAX_ENTRIES, ttlMs = PLAN_STORE_TTL_MS, now = () => Date.now() } = {}) {
  const map = new Map()
  return {
    backend: 'memory',
    async get(id) {
      try {
        const entry = map.get(id)
        if (!entry) return null
        if (now() - entry.storedAt > ttlMs) { map.delete(id); return null }
        return entry.value
      } catch {
        return null
      }
    },
    async set(id, value) {
      try {
        if (map.size >= max && !map.has(id)) map.delete(map.keys().next().value)
        map.set(id, { value, storedAt: now() })
      } catch {
        // best effort
      }
    },
  }
}

// Redis-compatible REST KV store (Vercel KV / Upstash). Durable + shared. Values
// are JSON-encoded; SET uses EX for TTL so storage is bounded and self-expiring.
export function createKvRestPlanStore({ url, token, ttlMs = PLAN_STORE_TTL_MS, fetchImpl = globalThis.fetch }) {
  const base = String(url).replace(/\/+$/, '')
  const ttlSeconds = Math.max(1, Math.floor(ttlMs / 1000))
  const auth = { Authorization: `Bearer ${token}` }
  return {
    backend: 'kv-rest',
    async get(id) {
      try {
        const response = await fetchImpl(`${base}/get/${encodeURIComponent(KEY_PREFIX + id)}`, { headers: auth })
        if (!response?.ok) return null
        const payload = await response.json()
        // Upstash returns { result: <stringified value | null> }.
        if (payload?.result == null) return null
        return typeof payload.result === 'string' ? JSON.parse(payload.result) : payload.result
      } catch {
        return null
      }
    },
    async set(id, value) {
      try {
        // POST body carries the value; EX query sets the TTL. Path-encoded key.
        const endpoint = `${base}/set/${encodeURIComponent(KEY_PREFIX + id)}?EX=${ttlSeconds}`
        await fetchImpl(endpoint, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        })
      } catch {
        // best effort — a failed registration just means the client re-POSTs
      }
    },
  }
}

// Pick the durable KV backend when its env vars are present; otherwise fall back
// to the bounded in-process store (best-effort, non-durable — documented above).
export function createPlanStore({ env = {}, fetchImpl = globalThis.fetch, ttlMs = PLAN_STORE_TTL_MS } = {}) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    return createKvRestPlanStore({ url, token, ttlMs, fetchImpl })
  }
  return createMemoryPlanStore({ ttlMs })
}
