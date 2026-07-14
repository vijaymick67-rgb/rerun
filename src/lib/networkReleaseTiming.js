// Universal release anchor.
//
// TMDB supplies a calendar air_date, not a release instant. We deliberately no
// longer model per-platform release times: every show, on every platform,
// is treated as releasing at 2:00 PM IST on its TMDB air_date. IST (Asia/
// Kolkata) is UTC+5:30 year-round with no daylight saving, so the release
// instant is plain arithmetic — no IANA timezone conversion, no date library.

export const RELEASE_HOUR_IST = 14 // 2:00 PM, Asia/Kolkata

// IST is a fixed +05:30 from UTC (no DST), so 14:00 IST is always 08:30 UTC.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Epoch ms of the release moment for `airDate`: 14:00 IST on that calendar day.
// Returns null for a missing or malformed date (not a full YYYY-MM-DD).
export function releaseTimestamp(airDate) {
  if (!airDate || !ISO_DATE_RE.test(airDate)) return null
  const [year, month, day] = airDate.split('-').map(Number)
  // 14:00 IST == (14:00 wall clock as UTC) − 5:30 == 08:30 UTC the same day.
  return Date.UTC(year, month - 1, day, RELEASE_HOUR_IST, 0) - IST_OFFSET_MS
}

// The IST calendar day the release lands on. Because the anchor is 14:00 IST on
// the air_date itself, this is simply the (validated) air_date — kept as a named
// function so callers read as intent rather than a bare pass-through.
export function releaseDateInIST(airDate) {
  if (!airDate || !ISO_DATE_RE.test(airDate)) return null
  return airDate
}

// Today's date in IST (YYYY-MM-DD). Shifting `now` by the fixed +05:30 offset
// and reading the UTC components keeps this independent of the host timezone.
export function istDateISO(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// --- Priority-chain resolver (TVmaze integration) -------------------------
//
// The universal 14:00-IST anchor above is a *fallback*, not the only source.
// TVmaze's per-episode `airstamp` is a full ISO 8601 instant carrying the
// network's real UTC offset (e.g. "2026-07-19T21:00:00-04:00"), so it already
// pins the release moment timezone-correctly — no arithmetic. Given an episode's
// TMDB air_date plus any higher-priority signals, resolve the release instant
// (epoch ms) in strict priority order:
//   1. manualOverride — an explicit human correction (epoch ms or ISO string);
//      always wins, even over TVmaze.
//   2. airstamp — TVmaze's absolute ISO 8601 timestamp, parsed with new Date().
//   3. releaseTimestamp(airDate) — the existing universal anchor, unchanged,
//      reached only when neither higher source has data (new/niche/regional
//      shows TVmaze doesn't cover).
// Returns epoch ms, or null when nothing resolves. This is additive: callers
// that pass no sources get exactly the old anchor behaviour.
export function resolveReleaseTimestamp(airDate, sources = {}) {
  const override = coerceInstant(sources.manualOverride)
  if (override !== null) return override
  const airstamp = coerceInstant(sources.airstamp)
  if (airstamp !== null) return airstamp
  return releaseTimestamp(airDate)
}

export function releaseInfoFromTimestamp(timestamp, source = 'prediction') {
  const ts = coerceInstant(timestamp)
  if (ts === null) return null
  return {
    timestamp: ts,
    istDate: istDateISO(new Date(ts)),
    istTime: istTimeDisplay(new Date(ts)),
    source,
  }
}

export function resolveReleaseInfo(airDate, sources = {}) {
  const override = coerceInstant(sources.manualOverride)
  if (override !== null) return releaseInfoFromTimestamp(override, 'manualOverride')
  const airstamp = coerceInstant(sources.airstamp)
  if (airstamp !== null) return releaseInfoFromTimestamp(airstamp, 'tvmaze')
  const fallback = releaseTimestamp(airDate)
  return fallback === null ? null : releaseInfoFromTimestamp(fallback, 'fallback')
}

// The IST calendar day a resolved release lands on. For the plain anchor this
// is just the air_date (the anchor sits at 14:00 IST on it); for a TVmaze
// airstamp or manual override it is the true IST day of that instant, which is
// how the HBO "US-day-only" drift gets corrected (a Sunday-night US drop shows
// as its actual Monday-morning IST day). Returns null when nothing resolves.
export function resolveReleaseDateInIST(airDate, sources = {}) {
  return resolveReleaseInfo(airDate, sources)?.istDate ?? null
}

export function resolveReleaseTimeInIST(airDate, sources = {}) {
  return resolveReleaseInfo(airDate, sources)?.istTime ?? null
}

function istTimeDisplay(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS)
  const hours = shifted.getUTCHours()
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0')
  const hour12 = hours % 12 || 12
  return `${hour12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`
}

// Accept either epoch ms (number) or a parseable date string; reject anything
// that doesn't yield a finite instant so resolution falls cleanly to the next
// source in the chain.
function coerceInstant(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}
