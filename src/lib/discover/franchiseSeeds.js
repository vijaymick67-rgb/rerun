// Verified narrow franchise company seeds (Scope J — dynamic replacement for the
// old static Marvel/DC title list).
//
// ---------------------------------------------------------------------------
// WHY COMPANY SEEDS, NOT A STATIC TITLE LIST
// ---------------------------------------------------------------------------
// The previous implementation hard-coded every individual Marvel/DC movie and TV
// id in source. That list goes stale the moment Marvel Studios or DC Studios
// announces a new project, and it required a code change per title. It is
// deleted. Franchise membership is now DISCOVERED dynamically from TMDB
// structured metadata: a small set of NARROW, franchise-specific production
// companies. When TMDB attributes a brand-new project to one of these companies,
// it enters the catalogue automatically — no source-code title addition.
//
// ---------------------------------------------------------------------------
// NARROW vs BROAD — the whole safety argument
// ---------------------------------------------------------------------------
// A /discover?with_companies=<id> query is only as safe as the company id is
// NARROW. Parent-studio ids pull vast unrelated catalogues:
//   * 429  "DC Comics"            — loose source-material credit on decades of
//                                    unrelated licensed media.
//   * 174  "Warner Bros. Pictures"— the entire Warner film slate.
//   * 2    "Walt Disney Pictures" — the entire Disney film slate.
//   * 128  "Warner Bros. Television", 6704 "The Walt Disney Company".
// These are REJECTED (never queried). Only franchise-specific production
// entities (Marvel Studios, Marvel Television, DC Studios, and the like) are
// eligible seeds — and even those are confirmed again at the DETAIL level before
// a discovered title is admitted (see franchiseCatalogue.confirmMembership).
//
// ---------------------------------------------------------------------------
// HONEST LIVE-VERIFICATION STATUS
// ---------------------------------------------------------------------------
// Every seed below is a CANDIDATE shipped `verified: false, enabled: false`. A
// seed is NEVER queried at runtime until it has been live-verified against the
// real TMDB API (company name confirmed + discover sample inspected for
// narrowness). The build/CI sandbox has no TMDB key and cannot reach
// api.themoviedb.org, so NO seed could be live-verified here and the dynamic
// catalogue is therefore empty in this environment — a safe disabled seed is
// strictly preferable to an enabled guessed one. `scripts/verify-franchise-seeds.mjs`
// performs the live checks through the server-side key; the maintenance workflow
// (docs/discover-engine.md) is: run it, confirm each company's name + narrowness,
// then flip `verified`/`enabled` on the seeds that pass. We never set
// `verified: false, enabled: true`.

export const FRANCHISE = Object.freeze({ MARVEL: 'marvel', DC: 'dc' })
export const MEDIA_TYPE = Object.freeze({ MOVIE: 'movie', TV: 'tv' })

// A discover sample larger than this means the company is too broad to be a
// franchise seed (it behaves like a parent-studio slate). The verify script
// rejects a candidate whose sample exceeds it.
export const MAX_NARROW_SAMPLE = 400

function seed(franchise, companyId, candidateName, note) {
  return Object.freeze({
    franchise,
    companyId,
    // The name we EXPECT live TMDB to return for this id. The verify script
    // compares the live company name against this; a mismatch fails the seed.
    candidateName,
    note,
    verified: false, // flipped true only after live company-details confirmation
    enabled: false, // a seed is NEVER queried in production until verified
  })
}

// Compact configuration of candidate narrow, franchise-specific company ids.
// These are STARTING POINTS for live verification, not asserted facts — the ids
// are widely documented but must be confirmed live before use. All ship
// disabled. A maintainer with a key resolves each one, confirms it is narrow
// (franchise-only, not a parent slate), and enables the ones that pass.
export const FRANCHISE_COMPANY_SEEDS = Object.freeze([
  seed(FRANCHISE.MARVEL, 420, 'Marvel Studios', 'MCU feature films + Disney+ MCU series. Confirm name + narrowness live.'),
  seed(FRANCHISE.MARVEL, 7505, 'Marvel Television', 'Marvel TV output (or its current TMDB equivalent). Confirm live — TMDB has reorganised Marvel TV entities.'),
  seed(FRANCHISE.DC, 128064, 'DC Studios', 'The current DC Studios entity (formed 2022). Confirm the exact id + name live — DC production entities on TMDB are in flux.'),
  seed(FRANCHISE.DC, 9993, 'DC Entertainment', 'Franchise-specific DC production credit (distinct from broad "DC Comics" 429). Confirm narrowness live before enabling.'),
])

// Parent/broad company ids that must NEVER be used as seeds. Documented so a
// future maintainer does not "helpfully" widen a seed into a studio slate.
export const REJECTED_BROAD_COMPANY_IDS = Object.freeze([
  { id: 429, label: 'DC Comics', why: 'loose source-material credit on a huge, unrelated set of licensed media' },
  { id: 174, label: 'Warner Bros. Pictures', why: 'the entire Warner Bros. film slate' },
  { id: 2, label: 'Walt Disney Pictures', why: 'the entire Walt Disney Pictures film slate' },
  { id: 128, label: 'Warner Bros. Television', why: 'all Warner Bros. TV output' },
  { id: 6704, label: 'The Walt Disney Company', why: 'the entire Disney conglomerate' },
])

const REJECTED_IDS = new Set(REJECTED_BROAD_COMPANY_IDS.map((e) => e.id))

export function isRejectedBroadCompany(companyId) {
  return REJECTED_IDS.has(companyId)
}

// The runtime seed set: only seeds that are BOTH live-verified AND enabled. A
// broad-company id can never leak in even if mis-flagged. In the keyless sandbox
// this is empty, so the dynamic catalogue is empty (feature safely inert).
export function enabledSeeds(seeds = FRANCHISE_COMPANY_SEEDS) {
  return (Array.isArray(seeds) ? seeds : []).filter(
    (s) => s.verified === true && s.enabled === true && !isRejectedBroadCompany(s.companyId),
  )
}

export function seedCompanyIds(seeds) {
  return enabledSeeds(seeds).map((s) => s.companyId)
}

// The set of verified company ids for a franchise (used at the detail-confirm
// step to prove a discovered title really belongs to a configured franchise).
export function verifiedCompanyIdsFor(franchise, seeds = FRANCHISE_COMPANY_SEEDS) {
  return new Set(enabledSeeds(seeds).filter((s) => s.franchise === franchise).map((s) => s.companyId))
}

// Live-verify a single candidate seed against the real TMDB API (via an injected
// fetchJson that hits /company/{id} and /discover). A seed passes only when:
//   1. it is not a rejected broad-company id;
//   2. the live company name matches the candidate name;
//   3. a discover sample is NARROW (total_results <= MAX_NARROW_SAMPLE) — proving
//      it is a franchise entity, not a whole parent-studio slate.
// Returns evidence; it NEVER enables anything itself — a maintainer reviews the
// evidence and edits the seed flags. This keeps verification honest and auditable.
export async function verifySeed(seed, { fetchJson, sampleMediaType = MEDIA_TYPE.MOVIE } = {}) {
  if (!seed || typeof fetchJson !== 'function') {
    return { companyId: seed?.companyId ?? null, ok: false, reason: 'no_fetch_impl' }
  }
  if (isRejectedBroadCompany(seed.companyId)) {
    return { companyId: seed.companyId, ok: false, reason: 'rejected_broad_company' }
  }
  const company = await fetchJson(`/company/${seed.companyId}`)
  if (!company || typeof company.name !== 'string') {
    return { companyId: seed.companyId, ok: false, reason: 'company_unresolved' }
  }
  const nameMatch = normalizeName(company.name) === normalizeName(seed.candidateName)
  const type = sampleMediaType === MEDIA_TYPE.TV ? 'tv' : 'movie'
  const sample = await fetchJson(`/discover/${type}`, { with_companies: String(seed.companyId), page: '1' })
  const totalResults = Number(sample?.total_results)
  const narrow = Number.isFinite(totalResults) && totalResults > 0 && totalResults <= MAX_NARROW_SAMPLE
  return {
    companyId: seed.companyId,
    resolvedName: company.name,
    nameMatch,
    totalResults: Number.isFinite(totalResults) ? totalResults : null,
    narrow,
    ok: Boolean(nameMatch && narrow),
    reason: !nameMatch ? 'name_mismatch' : !narrow ? 'too_broad_or_empty' : 'ok',
  }
}

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// Honest status for docs / PR / logging.
export function seedVerificationStatus(seeds = FRANCHISE_COMPANY_SEEDS) {
  const list = Array.isArray(seeds) ? seeds : []
  return {
    total: list.length,
    verified: list.filter((s) => s.verified).length,
    enabled: enabledSeeds(list).length,
    pending: list.filter((s) => !s.verified).length,
  }
}
