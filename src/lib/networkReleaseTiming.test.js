import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseDateInIST, releaseTimestamp } from './networkReleaseTiming'
import { hasAired } from './watchHelpers'

afterEach(() => {
  vi.useRealTimers()
})

// Renders a timestamp as its IST wall-clock — the human-readable form of the
// release moment. Uses Intl only to describe the expected instant in the test;
// the source itself is plain arithmetic (IST is a fixed +05:30, no DST).
function istStamp(ts) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
    .formatToParts(new Date(ts))
    .filter((x) => x.type !== 'literal')
    .reduce((a, x) => ((a[x.type] = x.value), a), {})
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} IST`
}

describe('universal release anchor', () => {
  // FIX A: releaseTimestamp takes only an air_date now — there is no platform
  // parameter. The release is always 14:00 IST (08:30 UTC) on that date.
  it('anchors an air_date to 14:00 IST == 08:30 UTC', () => {
    const ts = releaseTimestamp('2026-07-14')
    expect(new Date(ts).toISOString()).toBe('2026-07-14T08:30:00.000Z')
    expect(istStamp(ts)).toBe('2026-07-14 14:00 IST')
  })

  // The old model gave Netflix, HBO, and Apple TV+ three different release
  // instants. They now collapse to one formula — the same air_date, whatever
  // the show, resolves to the same moment.
  it('applies the same anchor regardless of platform', () => {
    const netflixShow = releaseTimestamp('2026-03-01') // once midnight PT
    const hboShow = releaseTimestamp('2026-03-01') // once 9 PM ET
    const appleShow = releaseTimestamp('2026-03-01') // once midnight PT
    expect(netflixShow).toBe(hboShow)
    expect(hboShow).toBe(appleShow)
    // And it holds in the other half of the year — no DST to shift it.
    expect(istStamp(releaseTimestamp('2026-01-12'))).toBe('2026-01-12 14:00 IST')
    expect(istStamp(releaseTimestamp('2026-07-12'))).toBe('2026-07-12 14:00 IST')
  })

  it('returns null for a missing or malformed air_date', () => {
    expect(releaseTimestamp(null)).toBeNull()
    expect(releaseTimestamp('2026-07')).toBeNull()
    expect(releaseTimestamp('')).toBeNull()
  })

  // The release lands at 14:00 IST on the air_date itself, so its IST calendar
  // day is just the air_date — no cross-midnight day shift like the old rules.
  it('reports the IST release day as the air_date itself', () => {
    expect(releaseDateInIST('2026-07-14')).toBe('2026-07-14')
    expect(releaseDateInIST('2026-01-01')).toBe('2026-01-01')
    expect(releaseDateInIST('nope')).toBeNull()
  })
})

describe('hasAired flips exactly at 14:00 IST on the air_date', () => {
  it('is false just before the instant and true exactly at it', () => {
    vi.useFakeTimers()
    // 14:00 IST on 2026-07-14 is 08:30:00 UTC.
    vi.setSystemTime(new Date('2026-07-14T08:29:59.999Z'))
    expect(hasAired({ air_date: '2026-07-14' })).toBe(false)

    vi.setSystemTime(new Date('2026-07-14T08:30:00.000Z'))
    expect(hasAired({ air_date: '2026-07-14' })).toBe(true)

    // Still aired later the same day.
    vi.setSystemTime(new Date('2026-07-14T18:00:00.000Z'))
    expect(hasAired({ air_date: '2026-07-14' })).toBe(true)
  })
})
