// Ported from the GitHub Actions TV notifier's NETWORK_RELEASE config
// (lib.js) — TMDB's air_date is the US release date, but different
// networks/platforms actually drop episodes at moments that land on a
// different IST calendar day than the raw US date suggests.
const DAY_SHIFT_BY_NETWORK = {
  // dayShift 1: evening-ET premiere (linear cable or simulcast) —
  // TMDB's recorded air_date lands one IST calendar day early
  'HBO': 1,
  'HBO Max': 1,
  'Max': 1,
  'Apple TV+': 1,
  'Apple TV': 1, // TMDB sometimes omits the "+" for Apple TV+ originals
  'AMC': 1,
  'AMC+': 1,
  'FX': 1,
  'Showtime': 1,
  'Starz': 1,
  'MGM+': 1,
  'ABC': 1,
  'NBC': 1,
  'CBS': 1,
  'FOX': 1,
  'The CW': 1,

  // dayShift 0: midnight PT/ET streaming-native drop — same IST calendar day
  'Netflix': 0,
  'Prime Video': 0,
  'Disney+': 0,
  'Paramount+': 0,
  'Peacock': 0,
  'Hulu': 0, // NOTE: was 1 before this PR — see below
  'Tubi': 0,
  'Crunchyroll': 0, // low-confidence, verify against a real title
}

const NORMALIZED_DAY_SHIFT_BY_NETWORK = Object.fromEntries(
  Object.entries(DAY_SHIFT_BY_NETWORK).map(([name, shift]) => [
    name.trim().toLowerCase(),
    shift,
  ])
)

// `networks` is an array of TMDB network name strings. A show with no
// matching network defaults to no shift rather than guessing.
export function dayShiftForNetworks(networks) {
  for (const name of networks ?? []) {
    const key = name?.trim().toLowerCase()
    const shift = NORMALIZED_DAY_SHIFT_BY_NETWORK[key]
    if (shift !== undefined) return shift
  }
  if (networks?.length) {
    console.warn(
      'networkReleaseTiming: no day-shift match for networks',
      networks
    )
  }
  return 0
}

// Applies a network's day shift to a TMDB air_date (YYYY-MM-DD), returning
// the IST-effective release date in the same format.
export function shiftAirDate(airDate, dayShift) {
  if (!dayShift) return airDate
  const [year, month, day] = airDate.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + dayShift)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
