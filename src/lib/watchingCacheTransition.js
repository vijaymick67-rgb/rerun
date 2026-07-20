// Feature 2 — advance an expired cached countdown before first render.
//
// Watching intentionally renders its local cache immediately (see
// watchingCache.js). If the cache was written before a show's next episode
// actually released, the cached row still says "New episode soon" for the
// brief window until the background network refresh corrects it — a visible
// flip the user shouldn't have to see.
//
// This module is a single pure, synchronous helper: it consumes a cached
// Watching row plus an injectable "now", and only ever compares that now
// against an *already-resolved* release timestamp the row was cached with
// (produced earlier by Rerun's release engine — see
// networkReleaseTiming.js/watchHelpers.js). It never parses a date, never
// recomputes a release instant, and never introduces a calendar-day
// comparison — it does a single numeric `now >= timestamp` check.

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// True only for a row that's actually eligible to advance: a real countdown
// row (never nextUp/caughtUp/completed — see below for why that alone makes
// this idempotent) carrying a well-formed lightweight candidate with a
// numeric, already-resolved release timestamp and a real episode identity.
function readyToAdvance(row) {
  if (!isPlainObject(row)) return false
  // Restricting to 'countdown' is what makes re-running this helper
  // idempotent: the first transition rewrites status.type to 'nextUp', so a
  // second call on the same (now-transitioned) row always fails this check
  // and returns it unchanged — never a second increment. It's also how rule
  // 4/5 ("not already watched" / "not already transitioned") are satisfied:
  // a row that's already nextUp, caughtUp, or completed is left alone.
  if (row.status?.type !== 'countdown') return false

  const candidate = row.nextScheduledEpisode
  if (!isPlainObject(candidate)) return false
  if (!Number.isInteger(candidate.season_number) || !Number.isInteger(candidate.episode_number)) return false

  const release = candidate.release
  return isPlainObject(release) && Number.isFinite(release.timestamp)
}

// Advance one cached Watching row to `nextUp` if — and only if — its stored
// nextScheduledEpisode candidate's authoritative release timestamp has
// already passed. Returns the row unchanged (same reference) when the
// candidate is missing, malformed, or still in the future. Never throws.
export function advanceCachedWatchingRow(row, now = Date.now()) {
  try {
    if (!readyToAdvance(row)) return row

    const nowMs = Number(now)
    if (!Number.isFinite(nowMs)) return row

    const candidate = row.nextScheduledEpisode
    const release = candidate.release
    if (nowMs < release.timestamp) return row

    const releasedEpisodeCount = (row.releasedEpisodeCount ?? 0) + 1
    const releasedWatchedCount = row.releasedWatchedCount ?? 0
    const releasedProgress = releasedEpisodeCount > 0
      ? Math.min(100, (releasedWatchedCount / releasedEpisodeCount) * 100)
      : 0

    return {
      ...row,
      status: {
        type: 'nextUp',
        season_number: candidate.season_number,
        episode_number: candidate.episode_number,
        name: candidate.name ?? null,
        air_date: release.istDate ?? null,
        release,
      },
      nextReleasedUnwatchedEpisode: {
        season_number: candidate.season_number,
        episode_number: candidate.episode_number,
        name: candidate.name ?? null,
        runtime: candidate.runtime ?? null,
      },
      releasedEpisodeCount,
      releasedWatchedCount,
      releasedProgress,
    }
  } catch {
    // Malformed cache data must never crash Watching — leave the row exactly
    // as it was read from localStorage.
    return row
  }
}

// Batch form for the Watching cache's initial-render path. Never throws, and
// tolerates a non-array input by returning it unchanged.
export function advanceCachedWatchingRows(rows, now = Date.now()) {
  if (!Array.isArray(rows)) return rows
  return rows.map((row) => advanceCachedWatchingRow(row, now))
}
