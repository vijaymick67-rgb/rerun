// Announcement deduplication + supersession (Scope I).
//
// Many outlets report the same real-world event. Each normalized announcement
// already carries a stable event `id` (from announcementEventKey), so the same
// event from five publishers shares one id. Within an id cluster we pick a single
// representative using a documented, consistent rule:
//
//   1. Highest source trust (Tier 1 official > Tier 2 trade > Tier 3 other).
//   2. Newest published report wins. This doubles as the SUPERSESSION rule for
//      season_date: a newer premiere-date report for the same show+season
//      supersedes an older/changed date (the cluster id intentionally excludes
//      the specific date, so a date change lands in the same cluster and the
//      newest report is kept). For renewal/cancellation/cast_addition the newest
//      report is treated as the most current/corrected wording.
//   3. Higher confidence.
//   4. Stable deterministic tiebreak on source URL.
//
// Distinct events never merge: two different cast additions (different people),
// a renewal vs a cancellation, or two different seasons all have different ids.

import { resolveSourceTrust, TRUST_TIER } from './sourceTrust.js'

function trustOf(announcement) {
  return resolveSourceTrust({
    canonicalUrl: announcement.sourceUrl,
    url: announcement.sourceUrl,
    sourceName: announcement.sourceName,
  }) ?? TRUST_TIER.OTHER
}

function publishedMs(announcement) {
  const value = Date.parse(announcement.publishedAt)
  return Number.isFinite(value) ? value : 0
}

// Returns < 0 if a is a better representative than b.
function compareRepresentatives(a, b) {
  const trustDelta = trustOf(a) - trustOf(b)
  if (trustDelta) return trustDelta
  const publishedDelta = publishedMs(b) - publishedMs(a) // newest first (supersession)
  if (publishedDelta) return publishedDelta
  const confidenceDelta = (b.confidence ?? 0) - (a.confidence ?? 0)
  if (confidenceDelta) return confidenceDelta
  return String(a.sourceUrl ?? '').localeCompare(String(b.sourceUrl ?? ''))
}

export function dedupeAnnouncements(announcements) {
  const clusters = new Map()
  for (const announcement of Array.isArray(announcements) ? announcements : []) {
    if (!announcement?.id) continue
    const existing = clusters.get(announcement.id)
    if (!existing || compareRepresentatives(announcement, existing) < 0) {
      clusters.set(announcement.id, announcement)
    }
  }
  return [...clusters.values()]
}
