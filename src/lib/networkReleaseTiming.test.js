import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { releaseDateInIST, releaseRuleForShow, releaseTimestamp } from './networkReleaseTiming'
import { computeWatchingStatus, hasAired } from './watchHelpers'

// Renders a timestamp as its IST wall-clock, derived purely from IANA zone
// resolution — the human-readable form of what the app shows the user.
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

describe('release timing rules', () => {
  it('keeps HOTD in Airs soon through Sunday night IST and releases it Monday 6:30 AM IST', () => {
    vi.useFakeTimers()
    const rule = releaseRuleForShow(94997, ['HBO'])
    expect(new Date(releaseTimestamp('2026-07-12', rule)).toISOString()).toBe('2026-07-13T01:00:00.000Z')
    expect(releaseDateInIST('2026-07-12', rule)).toBe('2026-07-13')

    vi.setSystemTime(new Date('2026-07-12T18:00:00.000Z'))
    expect(hasAired({ air_date: '2026-07-12' }, rule)).toBe(false)
    expect(computeWatchingStatus(
      { 1: [{ episode_number: 1, name: 'Episode', air_date: '2026-07-12' }] },
      new Set(), rule, { next_episode_to_air: { air_date: '2026-07-12', episode_number: 1 } },
    )).toMatchObject({ type: 'countdown', airsSoon: true })

    vi.setSystemTime(new Date('2026-07-13T01:00:00.000Z'))
    expect(hasAired({ air_date: '2026-07-12' }, rule)).toBe(true)
    expect(computeWatchingStatus(
      { 1: [{ episode_number: 1, name: 'Episode', air_date: '2026-07-12' }] },
      new Set(), rule, { next_episode_to_air: { air_date: '2026-07-12', episode_number: 1 } },
    )).toMatchObject({ type: 'nextUp', season_number: 1, episode_number: 1 })
    vi.useRealTimers()
  })

  it('resolves Netflix midnight Pacific in the platform timezone', () => {
    const rule = releaseRuleForShow(1, ['Netflix'])
    expect(new Date(releaseTimestamp('2026-07-12', rule)).toISOString()).toBe('2026-07-12T07:00:00.000Z')
  })

  // FIX 4 regression: Apple TV+ drops at midnight PT on the TMDB air_date, so
  // it becomes available the SAME day ~12:30 PM IST. The old rule asserted a
  // 9 PM ET release (2026-07-15T01:00:00Z) — a full day late. That was the bug.
  it.each([285404, 203744, 277439])(
    'releases Apple show %s at midnight PT on the TMDB air_date (~12:30 PM IST same day)',
    (showId) => {
      vi.useFakeTimers()
      const rule = releaseRuleForShow(showId, ['Apple TV+'])
      expect(new Date(releaseTimestamp('2026-07-14', rule)).toISOString()).toBe('2026-07-14T07:00:00.000Z')
      expect(istStamp(releaseTimestamp('2026-07-14', rule))).toBe('2026-07-14 12:30 IST')
      expect(releaseDateInIST('2026-07-14', rule)).toBe('2026-07-14')

      vi.setSystemTime(new Date('2026-07-14T06:59:59.000Z'))
      expect(hasAired({ air_date: '2026-07-14' }, rule)).toBe(false)
      expect(computeWatchingStatus(
        { 1: [{ episode_number: 10, name: 'Queens', air_date: '2026-07-14' }] },
        new Set(), rule, { next_episode_to_air: { air_date: '2026-07-14', episode_number: 10 } },
      )).toMatchObject({ type: 'countdown', airsSoon: true })

      vi.setSystemTime(new Date('2026-07-14T07:00:00.000Z'))
      expect(hasAired({ air_date: '2026-07-14' }, rule)).toBe(true)
      expect(computeWatchingStatus(
        { 1: [{ episode_number: 10, name: 'Queens', air_date: '2026-07-14' }] },
        new Set(), rule, { next_episode_to_air: { air_date: '2026-07-14', episode_number: 10 } },
      )).toMatchObject({ type: 'nextUp', season_number: 1, episode_number: 10 })
      vi.useRealTimers()
    },
  )

  // FIX 4: Prime library drops at midnight UTC → 5:30 AM IST, and because the
  // anchor is UTC it does not move across daylight-saving boundaries.
  it('releases Prime at midnight UTC → 05:30 IST, year-round (no DST)', () => {
    const rule = releaseRuleForShow(1, ['Prime Video'])
    expect(new Date(releaseTimestamp('2026-07-12', rule)).toISOString()).toBe('2026-07-12T00:00:00.000Z')
    expect(istStamp(releaseTimestamp('2026-07-12', rule))).toBe('2026-07-12 05:30 IST')
    // Six months later, still 05:30 IST — a hardcoded offset would drift here.
    expect(istStamp(releaseTimestamp('2026-01-12', rule))).toBe('2026-01-12 05:30 IST')
    expect(releaseRuleForShow(1, ['Amazon Prime Video'])).toEqual(rule)
  })

  // FIX 3: an entry in SHOW_RELEASE_OVERRIDES wins over the network fallback.
  it('lets a per-show override take precedence over the network rule', () => {
    const netflixRule = releaseRuleForShow(1, ['Netflix'])
    // HOTD (94997) is overridden to HBO 9 PM ET even when Netflix is passed.
    const overridden = releaseRuleForShow(94997, ['Netflix'])
    expect(overridden).not.toEqual(netflixRule)
    expect(overridden).toEqual({ timeZone: 'America/New_York', hour: 21 })
    expect(new Date(releaseTimestamp('2026-07-12', overridden)).toISOString()).toBe('2026-07-13T01:00:00.000Z')
  })

  it('uses a safe noon-UTC fallback for unknown networks', () => {
    const rule = releaseRuleForShow(1, ['Unknown Network'])
    expect(rule.fallback).toBe(true)
    expect(new Date(releaseTimestamp('2026-07-12', rule)).toISOString()).toBe('2026-07-12T12:00:00.000Z')
  })

  // FIX 8: one IST snapshot per rule so a copied-and-tweaked guess can't quietly
  // regress a platform to the wrong schedule. air_date 2026-07-12 (summer).
  describe('per-platform IST snapshot (air_date 2026-07-12)', () => {
    const cases = [
      ['Netflix', 'Netflix', '2026-07-12 12:30 IST'],
      ['Hulu', 'Hulu', '2026-07-12 12:30 IST'],
      ['Disney+', 'Disney+', '2026-07-12 12:30 IST'],
      ['Paramount+', 'Paramount+', '2026-07-12 12:30 IST'],
      ['Peacock', 'Peacock', '2026-07-12 12:30 IST'],
      ['Apple TV+', 'Apple TV+', '2026-07-12 12:30 IST'],
      ['Prime Video', 'Prime Video', '2026-07-12 05:30 IST'],
      ['HBO', 'HBO', '2026-07-13 06:30 IST'],
      ['Max', 'Max', '2026-07-13 06:30 IST'],
      ['AMC', 'AMC', '2026-07-13 06:30 IST'],
      ['AMC+', 'AMC+', '2026-07-13 06:30 IST'],
      ['Showtime', 'Showtime', '2026-07-13 06:30 IST'],
      ['Starz', 'Starz', '2026-07-13 06:30 IST'],
      ['FX', 'FX', '2026-07-13 06:30 IST'],
      ['ABC', 'ABC', '2026-07-13 06:30 IST'],
      ['CBS', 'CBS', '2026-07-13 06:30 IST'],
      ['NBC', 'NBC', '2026-07-13 06:30 IST'],
      ['FOX', 'FOX', '2026-07-13 06:30 IST'],
    ]
    it.each(cases)('%s → %s', (_label, network, expected) => {
      const rule = releaseRuleForShow(1, [network])
      expect(istStamp(releaseTimestamp('2026-07-12', rule))).toBe(expected)
    })
  })

  // FIX 9: the DST axis — must pass in BOTH halves of the year, and the shift
  // must come from IANA zone resolution, never a literal offset.
  describe('DST matrix (IANA-resolved, both halves of the year)', () => {
    it('Netflix 12am PT → 12:30 IST in July (PDT), 13:30 IST in January (PST)', () => {
      const rule = releaseRuleForShow(1, ['Netflix'])
      expect(istStamp(releaseTimestamp('2026-07-12', rule))).toBe('2026-07-12 12:30 IST')
      expect(istStamp(releaseTimestamp('2026-01-12', rule))).toBe('2026-01-12 13:30 IST')
    })

    it('HBO 9pm ET Sun → 6:30 IST Mon in July (EDT), 7:30 IST Mon in January (EST)', () => {
      const rule = releaseRuleForShow(1, ['HBO'])
      expect(istStamp(releaseTimestamp('2026-07-12', rule))).toBe('2026-07-13 06:30 IST') // Sun → Mon
      expect(istStamp(releaseTimestamp('2026-01-11', rule))).toBe('2026-01-12 07:30 IST') // Sun → Mon
    })

    it('automatically changes the New York offset across US daylight saving time', () => {
      const rule = releaseRuleForShow(1, ['HBO'])
      expect(new Date(releaseTimestamp('2026-03-01', rule)).toISOString()).toBe('2026-03-02T02:00:00.000Z')
      expect(new Date(releaseTimestamp('2026-03-15', rule)).toISOString()).toBe('2026-03-16T01:00:00.000Z')
    })
  })

  // FIX 9 guard: the timing code must resolve zones through IANA + Intl only.
  // A literal UTC offset sneaking back in (e.g. a hardcoded +05:30 / UTC-7)
  // would silently break DST — fail loudly if one appears in the source.
  it('contains no hardcoded UTC offsets in the timing source', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./networkReleaseTiming.js', import.meta.url)),
      'utf8',
    )
    expect(src).not.toMatch(/UTC[+-]\d/)
    expect(src).not.toMatch(/[+-]\d\d:\d\d/)
    expect(src).not.toMatch(/GMT[+-]\d/)
  })
})
