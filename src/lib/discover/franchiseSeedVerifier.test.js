import { describe, it, expect, vi } from 'vitest'
import { resolveVerifiedSeeds, createSeedVerificationCache, SEED_VERIFICATION_TTL_MS } from './franchiseSeedVerifier.js'
import { FRANCHISE } from './franchiseSeeds.js'

// A fake TMDB JSON fetcher: resolves /company/{id}, /discover/movie, /discover/tv.
function tmdb({ companies = {}, movie = {}, tv = {} } = {}) {
  return async (path, params = {}) => {
    const c = path.match(/^\/company\/(\d+)$/)
    if (c) return companies[c[1]] ?? null
    if (path === '/discover/movie') return movie[params.with_companies] ?? { total_results: 0 }
    if (path === '/discover/tv') return tv[params.with_companies] ?? { total_results: 0 }
    return null
  }
}

const MARVEL = { franchise: FRANCHISE.MARVEL, companyId: 420, candidateName: 'Marvel Studios' }
const MARVEL_TV = { franchise: FRANCHISE.MARVEL, companyId: 7505, candidateName: 'Marvel Television' }
const DC = { franchise: FRANCHISE.DC, companyId: 128064, candidateName: 'DC Studios' }

const NARROW = tmdb({
  companies: { 420: { id: 420, name: 'Marvel Studios' }, 128064: { id: 128064, name: 'DC Studios' } },
  movie: { 420: { total_results: 40 }, 128064: { total_results: 8 } },
  tv: { 420: { total_results: 15 }, 128064: { total_results: 3 } },
})

describe('resolveVerifiedSeeds — automatic runtime verification (Blocker 1)', () => {
  it('verifies candidate seeds live and enables ONLY the ones that pass — no source edit', async () => {
    const { activeSeeds, evidence, summary } = await resolveVerifiedSeeds({
      seeds: [MARVEL, DC], fetchJson: NARROW, cache: createSeedVerificationCache(),
    })
    expect(activeSeeds.map((s) => s.companyId)).toEqual([420, 128064])
    // The shipped seeds are verified:false; the runtime flips them in memory only.
    expect(activeSeeds.every((s) => s.verified === true && s.enabled === true)).toBe(true)
    expect(summary.verified).toBe(2)
    expect(summary.failed).toBe(0)
    // Honest per-seed evidence with samples.
    const marvel = evidence.find((e) => e.companyId === 420)
    expect(marvel.ok).toBe(true)
    expect(marvel.movieResults).toBe(40)
    expect(marvel.tvResults).toBe(15)
    expect(marvel.reason).toBe('ok')
  })

  it('caches successful verification evidence for a long TTL (no repeat live calls)', async () => {
    const cache = createSeedVerificationCache()
    const fetchJson = vi.fn(NARROW)
    await resolveVerifiedSeeds({ seeds: [MARVEL, DC], fetchJson, cache })
    const callsAfterFirst = fetchJson.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    // Second resolve within TTL is served entirely from cache — zero live calls.
    const second = await resolveVerifiedSeeds({ seeds: [MARVEL, DC], fetchJson, cache })
    expect(fetchJson.mock.calls.length).toBe(callsAfterFirst)
    expect(second.activeSeeds.map((s) => s.companyId)).toEqual([420, 128064])
    expect(second.evidence.every((e) => e.cached)).toBe(true)
    expect(second.summary.fromCache).toBe(2)

    // Past the TTL the cache no longer answers and live verification runs again.
    const later = await resolveVerifiedSeeds({ seeds: [MARVEL, DC], fetchJson, cache, now: Date.now() + SEED_VERIFICATION_TTL_MS + 1 })
    expect(fetchJson.mock.calls.length).toBeGreaterThan(callsAfterFirst)
    expect(later.activeSeeds.map((s) => s.companyId)).toEqual([420, 128064])
  })

  it('isolates one failing seed — the others still verify (company_unresolved)', async () => {
    // 420 resolves narrow; 7505 does not resolve at all (company missing).
    const fetchJson = tmdb({
      companies: { 420: { id: 420, name: 'Marvel Studios' } },
      movie: { 420: { total_results: 40 } }, tv: { 420: { total_results: 10 } },
    })
    const { activeSeeds, evidence, summary } = await resolveVerifiedSeeds({
      seeds: [MARVEL, MARVEL_TV], fetchJson, cache: createSeedVerificationCache(),
    })
    expect(activeSeeds.map((s) => s.companyId)).toEqual([420])
    expect(evidence.find((e) => e.companyId === 7505).ok).toBe(false)
    expect(evidence.find((e) => e.companyId === 7505).reason).toBe('company_unresolved')
    expect(summary.verified).toBe(1)
    expect(summary.failed).toBe(1)
  })

  it('isolates a seed whose live verification THROWS (verification_error), not the rest', async () => {
    const fetchJson = async (path, params) => {
      if (path === '/company/7505') throw new Error('network down')
      return NARROW(path, params)
    }
    const { activeSeeds, evidence } = await resolveVerifiedSeeds({
      seeds: [MARVEL, MARVEL_TV], fetchJson, cache: createSeedVerificationCache(),
    })
    expect(activeSeeds.map((s) => s.companyId)).toEqual([420])
    expect(evidence.find((e) => e.companyId === 7505).reason).toBe('verification_error')
  })

  it('rejects a broad parent-studio id up front — never verified, never queried', async () => {
    const BROAD = { franchise: FRANCHISE.DC, companyId: 429, candidateName: 'DC Comics' }
    // Even a fetchJson that WOULD "confirm" 429 cannot enable it — it is rejected
    // before any live call.
    const fetchJson = vi.fn(tmdb({
      companies: { 429: { id: 429, name: 'DC Comics' }, 420: { id: 420, name: 'Marvel Studios' } },
      movie: { 429: { total_results: 5 }, 420: { total_results: 40 } },
      tv: { 429: { total_results: 5 }, 420: { total_results: 10 } },
    }))
    const { activeSeeds, evidence } = await resolveVerifiedSeeds({
      seeds: [BROAD, MARVEL], fetchJson, cache: createSeedVerificationCache(),
    })
    expect(activeSeeds.map((s) => s.companyId)).toEqual([420])
    expect(evidence.find((e) => e.companyId === 429).reason).toBe('rejected_broad_company')
    // No live /company/429 call was ever made.
    expect(fetchJson.mock.calls.some((call) => call[0] === '/company/429')).toBe(false)
  })

  it('rejects a company that is too broad in ONE media type even if narrow in the other', async () => {
    const fetchJson = tmdb({
      companies: { 420: { id: 420, name: 'Marvel Studios' } },
      movie: { 420: { total_results: 40 } }, // narrow film
      tv: { 420: { total_results: 5000 } }, // broad tv slate -> reject
    })
    const { activeSeeds, evidence } = await resolveVerifiedSeeds({
      seeds: [MARVEL], fetchJson, cache: createSeedVerificationCache(),
    })
    expect(activeSeeds).toEqual([])
    expect(evidence[0].reason).toBe('too_broad_or_empty')
  })
})
