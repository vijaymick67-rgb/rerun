// Announcement cache (Scope O + P). A NEW versioned localStorage namespace,
// deliberately separate from the legacy `rerun_news_cache:v1` so old generic
// news articles can never contaminate the announcements feed. Robust parsing,
// explicit schema version, TTL, and bounded storage; any corruption resets to a
// clean empty state rather than crashing boot.

export const ANNOUNCEMENTS_CACHE_KEY = 'rerun_discover_announcements:v1'
export const ANNOUNCEMENTS_CACHE_VERSION = 1
export const ANNOUNCEMENTS_MAX_ITEMS = 40
export const ANNOUNCEMENTS_MAX_DISMISSED_IDS = 500
// Stored announcements older than this (by publishedAt) are pruned even if a
// refresh has not run — the feed must not resurrect stale events on reload.
export const ANNOUNCEMENTS_MAX_AGE_MS = 100 * 24 * 60 * 60 * 1000

export function emptyAnnouncementsState() {
  return {
    version: ANNOUNCEMENTS_CACHE_VERSION,
    items: [],
    dismissedIds: [],
    lastSuccess: null,
  }
}

function validItem(item) {
  if (!item || typeof item !== 'object') return null
  if (!item.id || !item.showId || !item.eventType || !item.publishedAt) return null
  return item
}

function ageMs(item, now) {
  const published = Date.parse(item.publishedAt)
  return Number.isFinite(published) ? now - published : Infinity
}

export function sanitizeAnnouncementsState(value, now = Date.now()) {
  if (!value || value.version !== ANNOUNCEMENTS_CACHE_VERSION || !Array.isArray(value.items)) {
    return emptyAnnouncementsState()
  }
  const dismissedIds = [...new Set(
    (Array.isArray(value.dismissedIds) ? value.dismissedIds : [])
      .filter((id) => typeof id === 'string' && id),
  )].slice(-ANNOUNCEMENTS_MAX_DISMISSED_IDS)
  const dismissed = new Set(dismissedIds)
  const seen = new Set()
  const items = []
  for (const raw of value.items) {
    const item = validItem(raw)
    if (!item || seen.has(item.id) || dismissed.has(item.id)) continue
    if (ageMs(item, now) > ANNOUNCEMENTS_MAX_AGE_MS) continue
    seen.add(item.id)
    items.push(item)
  }
  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  return {
    version: ANNOUNCEMENTS_CACHE_VERSION,
    items: items.slice(0, ANNOUNCEMENTS_MAX_ITEMS),
    dismissedIds,
    lastSuccess: Number.isFinite(value.lastSuccess) ? value.lastSuccess : null,
  }
}

export function readAnnouncementsCache(storage = globalThis.localStorage, now = Date.now()) {
  try {
    const raw = storage?.getItem(ANNOUNCEMENTS_CACHE_KEY)
    return raw ? sanitizeAnnouncementsState(JSON.parse(raw), now) : emptyAnnouncementsState()
  } catch {
    return emptyAnnouncementsState()
  }
}

export function writeAnnouncementsCache(state, storage = globalThis.localStorage, now = Date.now()) {
  const safe = sanitizeAnnouncementsState(state, now)
  try { storage?.setItem(ANNOUNCEMENTS_CACHE_KEY, JSON.stringify(safe)) } catch { /* best effort */ }
  return safe
}

// Merge a freshly classified+deduped set of announcements into the cache. New
// events replace an existing item with the same id (a newer supersession), and
// the combined set is re-deduped, capped, and timestamped.
export function mergeAnnouncements(state, incoming, now = Date.now()) {
  const current = sanitizeAnnouncementsState(state, now)
  const dismissed = new Set(current.dismissedIds)
  const byId = new Map(current.items.map((item) => [item.id, item]))
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const item = validItem(raw)
    if (!item || dismissed.has(item.id)) continue
    const existing = byId.get(item.id)
    // Keep whichever report is newer (supersession already resolved upstream by
    // dedupeAnnouncements; this guards a cross-refresh replacement too).
    if (!existing || Date.parse(item.publishedAt) >= Date.parse(existing.publishedAt)) {
      byId.set(item.id, item)
    }
  }
  return sanitizeAnnouncementsState(
    {
      version: ANNOUNCEMENTS_CACHE_VERSION,
      items: [...byId.values()],
      dismissedIds: current.dismissedIds,
      lastSuccess: now,
    },
    now,
  )
}

export function dismissAnnouncement(state, announcementId, now = Date.now()) {
  const current = sanitizeAnnouncementsState(state, now)
  if (typeof announcementId !== 'string' || !announcementId) return current
  return sanitizeAnnouncementsState({
    ...current,
    items: current.items.filter((item) => item.id !== announcementId),
    dismissedIds: [...current.dismissedIds, announcementId],
  }, now)
}
