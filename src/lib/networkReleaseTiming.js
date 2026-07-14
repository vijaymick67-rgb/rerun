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
