import { describe, it, expect } from 'vitest'
import {
  FRANCHISE, FRANCHISE_COMPANY_SEEDS, REJECTED_BROAD_COMPANY_IDS,
  MAX_NARROW_SAMPLE, verifySeed, enabledSeeds, seedCompanyIds, verifiedCompanyIdsFor,
  isRejectedBroadCompany, seedVerificationStatus,
} from './franchiseSeeds.js'

// A fake TMDB (path, params) fetcher for company + discover verification.
function fakeTmdb({ companies = {}, discover = {} } = {}) {
  return async (path, params = {}) => {
    const company = path.match(/^\/company\/(\d+)$/)
    if (company) return companies[company[1]] ?? null
    if (/^\/discover\/(movie|tv)$/.test(path)) {
      const id = params.with_companies
      return discover[id] ?? { total_results: 0, results: [] }
    }
    return null
  }
}

describe('candidate seeds ship disabled + unverified (honest, keyless sandbox)', () => {
  it('every shipped seed is a narrow franchise candidate, verified:false, enabled:false', () => {
    for (const seed of FRANCHISE_COMPANY_SEEDS) {
      expect([FRANCHISE.MARVEL, FRANCHISE.DC]).toContain(seed.franchise)
      expect(typeof seed.companyId).toBe('number')
      expect(seed.verified).toBe(false)
      expect(seed.enabled).toBe(false)
      expect(isRejectedBroadCompany(seed.companyId)).toBe(false) // never a parent slate
    }
  })

  it('reports an honest verification status (nothing verified/enabled here)', () => {
    const status = seedVerificationStatus()
    expect(status.total).toBe(FRANCHISE_COMPANY_SEEDS.length)
    expect(status.verified).toBe(0)
    expect(status.enabled).toBe(0)
    expect(status.pending).toBe(status.total)
  })

  it('an unverified seed is NEVER queried in production mode', () => {
    // enabledSeeds is the ONLY runtime seed source; a verified:false seed is absent.
    expect(enabledSeeds()).toEqual([])
    expect(seedCompanyIds()).toEqual([])
  })
})

describe('enabledSeeds — only verified + enabled + narrow seeds run', () => {
  const marvel = { franchise: FRANCHISE.MARVEL, companyId: 420, candidateName: 'Marvel Studios', verified: true, enabled: true }
  const dc = { franchise: FRANCHISE.DC, companyId: 128064, candidateName: 'DC Studios', verified: true, enabled: true }

  it('includes a verified + enabled seed', () => {
    expect(enabledSeeds([marvel]).map((s) => s.companyId)).toEqual([420])
  })

  it('excludes a verified-but-disabled seed', () => {
    expect(enabledSeeds([{ ...marvel, enabled: false }])).toEqual([])
  })

  it('excludes an enabled-but-unverified seed (never set verified:false, enabled:true)', () => {
    expect(enabledSeeds([{ ...marvel, verified: false }])).toEqual([])
  })

  it('excludes a broad-company id even if mis-flagged verified + enabled', () => {
    const broad = { franchise: FRANCHISE.DC, companyId: 429, candidateName: 'DC Comics', verified: true, enabled: true }
    expect(enabledSeeds([broad])).toEqual([])
  })

  it('verifiedCompanyIdsFor groups by franchise', () => {
    const ids = verifiedCompanyIdsFor(FRANCHISE.MARVEL, [marvel, dc])
    expect([...ids]).toEqual([420])
  })
})

describe('verifySeed — live company verification (Part 3)', () => {
  it('accepts a narrow verified Marvel company', async () => {
    const fetchJson = fakeTmdb({
      companies: { 420: { id: 420, name: 'Marvel Studios' } },
      discover: { 420: { total_results: 55, results: [] } },
    })
    const seed = { franchise: FRANCHISE.MARVEL, companyId: 420, candidateName: 'Marvel Studios' }
    const result = await verifySeed(seed, { fetchJson })
    expect(result.ok).toBe(true)
    expect(result.nameMatch).toBe(true)
    expect(result.narrow).toBe(true)
  })

  it('accepts a narrow verified DC company', async () => {
    const fetchJson = fakeTmdb({
      companies: { 128064: { id: 128064, name: 'DC Studios' } },
      discover: { 128064: { total_results: 12, results: [] } },
    })
    const seed = { franchise: FRANCHISE.DC, companyId: 128064, candidateName: 'DC Studios' }
    expect((await verifySeed(seed, { fetchJson })).ok).toBe(true)
  })

  it('rejects a broad Disney company id outright', async () => {
    const seed = { franchise: FRANCHISE.MARVEL, companyId: 2, candidateName: 'Walt Disney Pictures' }
    const result = await verifySeed(seed, { fetchJson: fakeTmdb() })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('rejected_broad_company')
  })

  it('rejects a broad Warner company id outright', async () => {
    const seed = { franchise: FRANCHISE.DC, companyId: 174, candidateName: 'Warner Bros. Pictures' }
    expect((await verifySeed(seed, { fetchJson: fakeTmdb() })).reason).toBe('rejected_broad_company')
  })

  it('fails a seed whose live company name does not match (identity check)', async () => {
    const fetchJson = fakeTmdb({
      companies: { 9999: { id: 9999, name: 'Some Other Studio' } },
      discover: { 9999: { total_results: 10, results: [] } },
    })
    const seed = { franchise: FRANCHISE.MARVEL, companyId: 9999, candidateName: 'Marvel Studios' }
    const result = await verifySeed(seed, { fetchJson })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('name_mismatch')
  })

  it('fails a seed whose discover sample is too broad (a parent-studio slate)', async () => {
    const fetchJson = fakeTmdb({
      companies: { 420: { id: 420, name: 'Marvel Studios' } },
      discover: { 420: { total_results: MAX_NARROW_SAMPLE + 1000, results: [] } },
    })
    const seed = { franchise: FRANCHISE.MARVEL, companyId: 420, candidateName: 'Marvel Studios' }
    const result = await verifySeed(seed, { fetchJson })
    expect(result.ok).toBe(false)
    expect(result.narrow).toBe(false)
  })

  it('fails when the company cannot be resolved live', async () => {
    const seed = { franchise: FRANCHISE.MARVEL, companyId: 420, candidateName: 'Marvel Studios' }
    const result = await verifySeed(seed, { fetchJson: async () => null })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('company_unresolved')
  })
})

describe('rejected broad company ids are documented, never seeds', () => {
  it('lists the dangerous parent-studio ids with a reason', () => {
    const ids = REJECTED_BROAD_COMPANY_IDS.map((e) => e.id)
    expect(ids).toContain(429) // DC Comics
    expect(ids).toContain(174) // Warner Bros. Pictures
    expect(ids).toContain(2) // Walt Disney Pictures
    for (const entry of REJECTED_BROAD_COMPANY_IDS) expect(entry.why.length).toBeGreaterThan(0)
  })

  it('no shipped seed is a rejected broad company', () => {
    const broad = new Set(REJECTED_BROAD_COMPANY_IDS.map((e) => e.id))
    for (const seed of FRANCHISE_COMPANY_SEEDS) expect(broad.has(seed.companyId)).toBe(false)
  })
})
