// TMDB supplies a calendar air_date, not a release timestamp.  Release rules
// keep the platform's local wall-clock time and IANA timezone together so the
// browser applies daylight-saving changes when resolving the real instant.
const NETWORK_RELEASE_RULES = {
  'HBO': { timeZone: 'America/New_York', hour: 21 },
  'HBO Max': { timeZone: 'America/New_York', hour: 21 },
  'Max': { timeZone: 'America/New_York', hour: 21 },
  'Netflix': { timeZone: 'America/Los_Angeles', hour: 0 },
  // Prime library titles drop at midnight UTC (5:30 AM IST) year-round — no DST.
  'Prime Video': { timeZone: 'Etc/GMT', hour: 0 },
  'Amazon Prime Video': { timeZone: 'Etc/GMT', hour: 0 },
  // Apple TV+ drops at midnight PT (12 AM PST/PDT) on the TMDB air_date, which
  // is ~12:30-1:30 PM IST the SAME day. Confirmed against dated 2026 episodes
  // (Sugar, Silo, Foundation). The old 9 PM ET rule pushed it a day late.
  'Apple TV+': { timeZone: 'America/Los_Angeles', hour: 0 },
  'Apple TV': { timeZone: 'America/Los_Angeles', hour: 0 },
  'Disney+': { timeZone: 'America/Los_Angeles', hour: 0 },
  'Hulu': { timeZone: 'America/Los_Angeles', hour: 0 },
  'Paramount+': { timeZone: 'America/Los_Angeles', hour: 0 },
  'Peacock': { timeZone: 'America/Los_Angeles', hour: 0 },
  'AMC': { timeZone: 'America/New_York', hour: 21 },
  'AMC+': { timeZone: 'America/New_York', hour: 21 },
  'Showtime': { timeZone: 'America/New_York', hour: 21 },
  'Starz': { timeZone: 'America/New_York', hour: 21 },
  'FX': { timeZone: 'America/New_York', hour: 21 },
  'ABC': { timeZone: 'America/New_York', hour: 21 },
  'CBS': { timeZone: 'America/New_York', hour: 21 },
  'NBC': { timeZone: 'America/New_York', hour: 21 },
  'FOX': { timeZone: 'America/New_York', hour: 21 },
}

// Per-show overrides keyed by tmdb_show_id. Five platforms run two schedules
// each, so a single network rule is provably wrong for shows on the "other"
// schedule. An entry here takes precedence over the network fallback in
// releaseRuleForShow. Dead-simple map — no heuristics, no network-name parsing.
//
// Seed candidates (add the ones on your Watching list; don't guess IDs):
//   HBO Max  — prestige (HOTD, The Pitt) = 9 PM ET; back-catalog = 3 AM ET
//   Disney+  — prestige live-action (Loki S2+, Ahsoka) = 9 PM ET
//   Hulu     — ALL FX-branded series = 9 PM ET simulcast (2026 policy)
//   Peacock  — reality/linear crossover = 9 PM ET
//   Prime    — possible flagship exceptions, UNCONFIRMED — do not hardcode
const SHOW_RELEASE_OVERRIDES = {
  // House of the Dragon (HBO prestige): Sunday 9 PM ET → Monday 6:30 AM IST
  // in daylight time. Pinned here so it holds even if network detection misses.
  94997: { timeZone: 'America/New_York', hour: 21 },
}

// A conservative unknown-network fallback.  Noon UTC is 5:30 PM IST, so an
// unknown TMDB date can never become "Up next" merely because IST hit midnight.
export const UNKNOWN_RELEASE_RULE = { timeZone: 'UTC', hour: 12, fallback: true }

const NORMALIZED_NETWORK_RELEASE_RULES = Object.fromEntries(
  Object.entries(NETWORK_RELEASE_RULES).map(([name, rule]) => [name.toLowerCase(), rule]),
)

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
}

// Converts a wall-clock time in an IANA zone into a UTC timestamp.  The second
// pass handles the offset change around daylight-saving boundaries.
function zonedDateTimeToTimestamp(year, month, day, hour, minute, timeZone) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute)
  let timestamp = localAsUtc
  for (let pass = 0; pass < 2; pass++) {
    const actual = zonedParts(new Date(timestamp), timeZone)
    const offset = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second) - timestamp
    timestamp = localAsUtc - offset
  }
  return timestamp
}

export function releaseRuleForShow(tmdbId, networks) {
  if (SHOW_RELEASE_OVERRIDES[tmdbId]) return SHOW_RELEASE_OVERRIDES[tmdbId]
  for (const name of networks ?? []) {
    const rule = NORMALIZED_NETWORK_RELEASE_RULES[name?.trim().toLowerCase()]
    if (rule) return rule
  }
  return UNKNOWN_RELEASE_RULE
}

// Day comes straight from the TMDB per-episode air_date; the rule only carries
// {timeZone, hour}. No day-shift table — the wall-clock instant in the
// platform's IANA zone lands on the correct IST calendar day on its own.
export function releaseTimestamp(airDate, rule = UNKNOWN_RELEASE_RULE) {
  if (!airDate || !ISO_DATE_RE.test(airDate)) return null
  const [year, month, day] = airDate.split('-').map(Number)
  return zonedDateTimeToTimestamp(year, month, day, rule.hour ?? 0, rule.minute ?? 0, rule.timeZone)
}

export function releaseDateInIST(airDate, rule) {
  const timestamp = releaseTimestamp(airDate, rule)
  if (timestamp === null) return null
  const { year, month, day } = zonedParts(new Date(timestamp), 'Asia/Kolkata')
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function istDateISO(now = new Date()) {
  const { year, month, day } = zonedParts(now, 'Asia/Kolkata')
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
