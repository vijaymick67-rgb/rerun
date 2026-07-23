import { describe, it, expect } from 'vitest'
import {
  planFromShows, computePlanId, normalizedPlan, planTerms, isValidPlanId, PLAN_ID_PATTERN,
} from './announcementPlan.js'

describe('opaque plan id (Blocker 2)', () => {
  it('is a short, constant-length SHA-256-style hex digest — never a title dump', async () => {
    const { planId } = await planFromShows([{ id: 1, title: 'From' }])
    expect(planId).toMatch(PLAN_ID_PATTERN)
    expect(planId).toHaveLength(64)
    expect(isValidPlanId(planId)).toBe(true)
  })

  it('keeps the URL safely short for a 120-show library with aliases (no unbounded growth)', async () => {
    const shows = Array.from({ length: 120 }, (_, i) => ({
      id: i, title: `Canonical Series ${i}`, aliases: [`Series ${i} Alt A`, `Series ${i} Alt B`],
    }))
    const { planId } = await planFromShows(shows)
    const url = `/api/discover/announcements?plan=${encodeURIComponent(planId)}`
    // A self-describing Base64 token of 120 titles + aliases would be thousands of
    // chars and risk URL-length failure; the opaque id is fixed at 64.
    expect(planId).toHaveLength(64)
    expect(url.length).toBeLessThan(200)
  })

  it('the encoded URL contains NO show name or alias (library not exposed)', async () => {
    const shows = Array.from({ length: 120 }, (_, i) => ({
      id: i, title: `Canonical Series ${i}`, aliases: [`Series ${i} Alt A`, `Series ${i} Alt B`],
    }))
    const { planId } = await planFromShows(shows)
    for (let i = 0; i < 120; i += 1) {
      expect(planId).not.toContain(`Canonical Series ${i}`)
      expect(planId).not.toContain(`Series ${i} Alt`)
    }
    expect(planId).not.toContain('Series')
    expect(planId).not.toContain('Canonical')
  })

  it('equivalent plans (same shows in any order) produce the SAME id', async () => {
    const a = await planFromShows([{ id: 1, title: 'From' }, { id: 2, title: 'The Bear' }])
    const b = await planFromShows([{ id: 2, title: 'The Bear' }, { id: 1, title: 'From' }])
    expect(a.planId).toBe(b.planId)
  })

  it('keeps length-limited large plans order-independent', async () => {
    const shows = Array.from({ length: 120 }, (_, index) => ({
      id: index,
      title: `Canonical Series ${index}`,
      aliases: [`Series ${index} Alternate`],
    }))
    const forward = await planFromShows(shows)
    const reversed = await planFromShows([...shows].reverse())
    expect(forward.planId).toBe(reversed.planId)
    expect(forward.queries).toEqual(reversed.queries)
    expect(forward.plan).toEqual(reversed.plan)
  })

  it('a changed plan produces a DIFFERENT id', async () => {
    const a = await planFromShows([{ id: 1, title: 'From' }, { id: 2, title: 'The Bear' }])
    const c = await planFromShows([{ id: 9, title: 'Severance' }])
    expect(a.planId).not.toBe(c.planId)
  })

  it('rejects malformed ids up front (shape validation, not a lookup)', () => {
    expect(isValidPlanId('not-a-token')).toBe(false)
    expect(isValidPlanId('AB'.repeat(32))).toBe(false) // uppercase — not our format
    expect(isValidPlanId('a'.repeat(63))).toBe(false) // wrong length
    expect(isValidPlanId('a'.repeat(64))).toBe(true)
  })

  it('normalizedPlan sorts terms so it is order-independent; planTerms flattens canonical-first', () => {
    const plan = normalizedPlan({ canonicalScheduled: ['Bravo', 'Alpha'], aliasesScheduled: ['Zeta', 'Yankee'] })
    expect(plan.c).toEqual(['Alpha', 'Bravo'])
    expect(plan.a).toEqual(['Yankee', 'Zeta'])
    expect(planTerms(plan)).toEqual(['Alpha', 'Bravo', 'Yankee', 'Zeta'])
  })

  it('computePlanId is deterministic for identical normalized input', async () => {
    const input = { canonicalScheduled: ['A', 'B'], aliasesScheduled: [] }
    expect(await computePlanId(input)).toBe(await computePlanId(input))
  })
})
