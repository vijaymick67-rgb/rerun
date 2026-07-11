// Ported from the GitHub Actions TV notifier's NETWORK_RELEASE config
// (lib.js) — TMDB's air_date is the US release date, but different
// networks/platforms actually drop episodes at moments that land on a
// different IST calendar day than the raw US date suggests.
const DAY_SHIFT_BY_NETWORK = {
  HBO: 1,
  'Apple TV+': 1,
  Hulu: 1,
  AMC: 1,
  FX: 1,
  Showtime: 1,
  Netflix: 0,
  'Prime Video': 0,
  'Disney+': 0,
  'Paramount+': 0,
}

// `networks` is an array of TMDB network name strings. A show with no
// matching network defaults to no shift rather than guessing.
export function dayShiftForNetworks(networks) {
  for (const name of networks ?? []) {
    const shift = DAY_SHIFT_BY_NETWORK[name]
    if (shift !== undefined) return shift
  }
  return 0
}

// Applies a network's day shift to a TMDB air_date (YYYY-MM-DD), returning
// the IST-effective release date in the same format.
export function shiftAirDate(airDate, dayShift) {
  if (!dayShift) return airDate
  const [year, month, day] = airDate.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() - dayShift)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
