import { describe, expect, it, vi } from 'vitest'
import { dayShiftForNetworks, shiftAirDate } from './networkReleaseTiming'

describe('shiftAirDate', () => {
  it('shifts forward one IST calendar day for dayShift 1', () => {
    expect(shiftAirDate('2026-07-09', 1)).toBe('2026-07-10')
  })

  it('leaves the date unchanged for dayShift 0', () => {
    expect(shiftAirDate('2026-07-09', 0)).toBe('2026-07-09')
  })
})

describe('dayShiftForNetworks', () => {
  it('matches network names regardless of case or surrounding whitespace', () => {
    expect(dayShiftForNetworks([' hbo '])).toBe(1)
    expect(dayShiftForNetworks(['NETFLIX'])).toBe(0)
    expect(dayShiftForNetworks(['Apple tv+'])).toBe(1)
  })

  it('warns and defaults to 0 when no network matches', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(dayShiftForNetworks(['Some Unknown Network'])).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      'networkReleaseTiming: no day-shift match for networks',
      ['Some Unknown Network']
    )
    warn.mockRestore()
  })

  it('does not warn for an empty/undefined network list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(dayShiftForNetworks(undefined)).toBe(0)
    expect(dayShiftForNetworks([])).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
