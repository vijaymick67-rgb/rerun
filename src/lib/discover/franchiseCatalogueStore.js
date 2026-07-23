// Franchise catalogue cache (Scope 8).
//
// The dynamic discover + detail-confirm pipeline is expensive (many TMDB calls),
// so it must NOT run on every Discover mount. This is a versioned localStorage
// cache with:
//   * a 24h TTL (the catalogue changes slowly — new projects, not new trailers);
//   * stale-while-revalidate: a stale entry is still returned (so the feed keeps
//     working) while the caller refreshes in the background;
//   * stale-on-error: a failed refresh keeps the last usable catalogue rather than
//     emptying the feed;
//   * schema versioning + corruption-safe parsing (a bad/old blob resets cleanly);
//   * a bounded item count;
//   * a config key that embeds the verified seed configuration + date-window
//     version, so changing seeds or the window invalidates the old catalogue.

export const FRANCHISE_CATALOGUE_CACHE_KEY = 'rerun_discover_franchise_catalogue:v1'
export const FRANCHISE_CATALOGUE_SCHEMA = 1
export const FRANCHISE_CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
export const MAX_CACHED_ITEMS = 200

function safeParse(raw) {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

// Deterministic config key: same verified seeds + same window version => same key.
// Enabling/disabling a seed or bumping the window changes it, invalidating stale
// catalogues built under the old configuration.
export function catalogueConfigKey({ seedCompanyIds = [], windowVersion = 'w1' } = {}) {
  const seeds = [...seedCompanyIds].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  return `s:${seeds.join(',')}|${windowVersion}`
}

// Returns { media, cachedAt, fresh, stale, configKey } or null when there is no
// usable cache. `fresh` = within TTL and same config; `stale` = present but
// expired or built under a different config (caller should revalidate but may
// still display it under SWR).
export function readFranchiseCatalogue(storage, now = Date.now(), { configKey = null } = {}) {
  const parsed = safeParse(storage?.getItem?.(FRANCHISE_CATALOGUE_CACHE_KEY))
  if (!parsed || parsed.schema !== FRANCHISE_CATALOGUE_SCHEMA || !Array.isArray(parsed.media)) {
    return null // missing / corrupt / wrong schema -> clean reset
  }
  const cachedAt = Number(parsed.cachedAt)
  if (!Number.isFinite(cachedAt) || cachedAt <= 0) return null
  const sameConfig = configKey == null || parsed.configKey === configKey
  const withinTtl = now - cachedAt <= FRANCHISE_CATALOGUE_TTL_MS
  return {
    media: parsed.media.slice(0, MAX_CACHED_ITEMS),
    coverage: parsed.coverage ?? null,
    cachedAt,
    configKey: parsed.configKey ?? null,
    fresh: sameConfig && withinTtl,
    stale: !(sameConfig && withinTtl),
  }
}

export function writeFranchiseCatalogue({ media = [], coverage = null }, storage, now = Date.now(), { configKey = null } = {}) {
  try {
    const payload = {
      schema: FRANCHISE_CATALOGUE_SCHEMA,
      cachedAt: now,
      configKey,
      coverage,
      media: (Array.isArray(media) ? media : []).slice(0, MAX_CACHED_ITEMS),
    }
    storage?.setItem?.(FRANCHISE_CATALOGUE_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // best effort — a write failure must never break the caller
  }
}
