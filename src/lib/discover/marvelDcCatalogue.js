// Marvel / DC catalogue strategy (Scope J — the ONLY catalogue exception beyond
// tracked shows).
//
// Requirement: in addition to tracked shows, the Trailers feed includes official
// trailers/teasers for Marvel TV, Marvel movies, DC TV, and DC movies — and
// NOTHING broader (not all of Disney, not all of Warner Bros., not "superhero
// media" by keyword).
//
// ---------------------------------------------------------------------------
// WHY AN EXPLICIT MEDIA-ID ALLOWLIST, NOT A COMPANY DISCOVER QUERY
// ---------------------------------------------------------------------------
// A /discover?with_companies=<id> query is only as safe as the company id is
// narrow. The obvious ids are dangerously broad:
//   * 429  "DC Comics" is a source-material credit attached to a huge, messy set
//          of titles (unrelated licensed media, decades of TV, etc.).
//   * 174 / 2 (Warner Bros. Pictures / Walt Disney Pictures) are entire studio
//          slates.
// Getting a single company id wrong (or TMDB attributing it loosely) floods the
// feed with unrelated media. That is the failure the reviewer specifically
// called out.
//
// So membership here is an EXPLICIT ALLOWLIST OF SPECIFIC TMDB MEDIA IDS. This is
// safe by construction: a wrong or stale entry can only add/miss ONE title's
// trailers — it can never pull an unrelated catalogue. Each entry names the
// media type, the TMDB id, the human title, the franchise, its release status
// and a poll tier. Trailers for these ids go through the exact same strict
// trailerFilter + trailerRank pipeline as tracked shows (see
// discoverClient.franchiseTrailers).
//
// ---------------------------------------------------------------------------
// POLL CADENCE & RETIREMENT (why the catalogue is not just "old released films")
// ---------------------------------------------------------------------------
// New trailers come from UPCOMING and RECENT projects; a film released years ago
// will not publish a new trailer. Each entry therefore carries a `pollTier`:
//   * 'active'  — upcoming or currently-releasing; polled every refresh (fast).
//   * 'legacy'  — released within the maintenance window; still polled (slow),
//                 in case of a late featurette/anniversary trailer.
//   * 'retired' — long-released and done; EXCLUDED from polling to save requests,
//                 but still a MEMBER for classification (so a stray franchise
//                 video is still tagged correctly, never mislabelled).
// `catalogueTargets()` returns only the non-retired, enabled entries — the real
// polling set — while `isFranchiseMediaId()` matches the full allowlist so
// membership/classification is independent of cadence.
//
// ---------------------------------------------------------------------------
// HONEST LIVE-VERIFICATION STATUS (exact live checks performed)
// ---------------------------------------------------------------------------
// The exact live checks performed in this build: NONE. The build/CI sandbox has
// no TMDB API key and cannot reach api.themoviedb.org (outbound TMDB calls
// require the server-side key held only in Vercel; see api/tmdb.js). Every entry
// is therefore flagged `liveVerified: false`. The ids below are the well-known,
// widely-documented TMDB media ids for these titles, curated from TMDB's public
// catalogue.
//
// `scripts/verify-marvel-dc.mjs` performs the live check through the same
// server-side key when run in an environment that has it: it fetches each id,
// compares the resolved title, and reports OK/FAIL per entry. The maintenance
// workflow (documented in docs/discover-engine.md) is: run the script, flip
// `liveVerified: true` on entries that resolve, and set `enabled: false` on any
// id that fails — disabling ONE entry never affects the others. Because
// membership is an explicit allowlist, the feature is safe to run while
// verification is pending: the worst case is a single wrong/missing title, not a
// catalogue flood.

export const FRANCHISE = Object.freeze({ MARVEL: 'marvel', DC: 'dc' })
export const MEDIA_TYPE = Object.freeze({ TV: 'tv', MOVIE: 'movie' })
export const STATUS = Object.freeze({ UPCOMING: 'upcoming', RELEASED: 'released' })
export const POLL_TIER = Object.freeze({ ACTIVE: 'active', LEGACY: 'legacy', RETIRED: 'retired' })

// Poll cadence per tier — consumed by the client to decide how often to fetch.
export const POLL_CADENCE = Object.freeze({ active: 'fast', legacy: 'slow', retired: 'none' })

function entry(mediaType, id, title, franchise, status, releaseDate, pollTier) {
  return Object.freeze({
    mediaType, id, title, franchise, status, releaseDate, pollTier,
    liveVerified: false, // no TMDB key in the build sandbox; see header + verify script
    enabled: true, // per-entry gate; a maintainer sets false for any id the verify script fails
  })
}

// Explicit allowlist of specific TMDB media ids. Curated from TMDB's public
// catalogue; `liveVerified` is flipped by the maintainer after
// scripts/verify-marvel-dc.mjs confirms id -> title live. `pollTier` reflects how
// current the project is (see cadence/retirement note above) and MUST be updated
// as upcoming projects release and old ones wind down.
export const MARVEL_DC_CATALOGUE = Object.freeze([
  // --- Marvel TV (Disney+ MCU series) ---
  entry('tv', 84958, 'Loki', FRANCHISE.MARVEL, STATUS.RELEASED, '2021-06-09', POLL_TIER.RETIRED),
  entry('tv', 85271, 'WandaVision', FRANCHISE.MARVEL, STATUS.RELEASED, '2021-01-15', POLL_TIER.RETIRED),
  entry('tv', 88396, 'The Falcon and the Winter Soldier', FRANCHISE.MARVEL, STATUS.RELEASED, '2021-03-19', POLL_TIER.RETIRED),
  entry('tv', 88329, 'Hawkeye', FRANCHISE.MARVEL, STATUS.RELEASED, '2021-11-24', POLL_TIER.RETIRED),
  entry('tv', 92749, 'Moon Knight', FRANCHISE.MARVEL, STATUS.RELEASED, '2022-03-30', POLL_TIER.RETIRED),
  entry('tv', 92782, 'Ms. Marvel', FRANCHISE.MARVEL, STATUS.RELEASED, '2022-06-08', POLL_TIER.RETIRED),
  entry('tv', 92783, 'She-Hulk: Attorney at Law', FRANCHISE.MARVEL, STATUS.RELEASED, '2022-08-18', POLL_TIER.RETIRED),
  entry('tv', 114472, 'Secret Invasion', FRANCHISE.MARVEL, STATUS.RELEASED, '2023-06-21', POLL_TIER.RETIRED),
  entry('tv', 138501, 'Agatha All Along', FRANCHISE.MARVEL, STATUS.RELEASED, '2024-09-18', POLL_TIER.LEGACY),
  entry('tv', 202555, 'Daredevil: Born Again', FRANCHISE.MARVEL, STATUS.RELEASED, '2025-03-04', POLL_TIER.ACTIVE),

  // --- Marvel movies (MCU) ---
  entry('movie', 453395, 'Doctor Strange in the Multiverse of Madness', FRANCHISE.MARVEL, STATUS.RELEASED, '2022-05-04', POLL_TIER.RETIRED),
  entry('movie', 616037, 'Thor: Love and Thunder', FRANCHISE.MARVEL, STATUS.RELEASED, '2022-07-06', POLL_TIER.RETIRED),
  entry('movie', 505642, 'Black Panther: Wakanda Forever', FRANCHISE.MARVEL, STATUS.RELEASED, '2022-11-09', POLL_TIER.RETIRED),
  entry('movie', 640146, 'Ant-Man and the Wasp: Quantumania', FRANCHISE.MARVEL, STATUS.RELEASED, '2023-02-15', POLL_TIER.RETIRED),
  entry('movie', 447365, 'Guardians of the Galaxy Vol. 3', FRANCHISE.MARVEL, STATUS.RELEASED, '2023-05-03', POLL_TIER.RETIRED),
  entry('movie', 609681, 'The Marvels', FRANCHISE.MARVEL, STATUS.RELEASED, '2023-11-08', POLL_TIER.RETIRED),
  entry('movie', 533535, 'Deadpool & Wolverine', FRANCHISE.MARVEL, STATUS.RELEASED, '2024-07-24', POLL_TIER.LEGACY),
  entry('movie', 822119, 'Captain America: Brave New World', FRANCHISE.MARVEL, STATUS.RELEASED, '2025-02-12', POLL_TIER.ACTIVE),
  entry('movie', 986056, 'Thunderbolts*', FRANCHISE.MARVEL, STATUS.RELEASED, '2025-04-30', POLL_TIER.ACTIVE),
  entry('movie', 617126, 'The Fantastic Four: First Steps', FRANCHISE.MARVEL, STATUS.UPCOMING, '2025-07-23', POLL_TIER.ACTIVE),

  // --- DC TV ---
  entry('tv', 110492, 'Peacemaker', FRANCHISE.DC, STATUS.RELEASED, '2022-01-13', POLL_TIER.ACTIVE), // S2 (2025) still publishing trailers
  entry('tv', 80564, 'Titans', FRANCHISE.DC, STATUS.RELEASED, '2018-10-12', POLL_TIER.RETIRED),

  // --- DC movies ---
  entry('movie', 414906, 'The Batman', FRANCHISE.DC, STATUS.RELEASED, '2022-03-01', POLL_TIER.RETIRED),
  entry('movie', 475557, 'Joker', FRANCHISE.DC, STATUS.RELEASED, '2019-10-01', POLL_TIER.RETIRED),
  entry('movie', 436270, 'Black Adam', FRANCHISE.DC, STATUS.RELEASED, '2022-10-19', POLL_TIER.RETIRED),
  entry('movie', 298618, 'The Flash', FRANCHISE.DC, STATUS.RELEASED, '2023-06-13', POLL_TIER.RETIRED),
  entry('movie', 572802, 'Aquaman and the Lost Kingdom', FRANCHISE.DC, STATUS.RELEASED, '2023-12-20', POLL_TIER.RETIRED),
  entry('movie', 889737, 'Joker: Folie à Deux', FRANCHISE.DC, STATUS.RELEASED, '2024-10-02', POLL_TIER.LEGACY),
  entry('movie', 1061474, 'Superman', FRANCHISE.DC, STATUS.UPCOMING, '2025-07-09', POLL_TIER.ACTIVE),
])

// Documented so a future maintainer does not "helpfully" reintroduce a broad
// company discover query. Each of these pulls a vast unrelated catalogue and is
// exactly why the allowlist approach exists.
export const REJECTED_BROAD_COMPANY_IDS = Object.freeze([
  { id: 429, label: 'DC Comics', why: 'loose source-material credit on a huge, unrelated set' },
  { id: 174, label: 'Warner Bros. Pictures', why: 'entire Warner film slate' },
  { id: 2, label: 'Walt Disney Pictures', why: 'entire Disney film slate' },
  { id: 128, label: 'Warner Bros. Television', why: 'all WB TV output' },
  { id: 6704, label: 'The Walt Disney Company (broad)', why: 'entire Disney conglomerate' },
])

function normalizeType(mediaType) {
  return mediaType === 'movie' ? 'movie' : mediaType === 'tv' ? 'tv' : null
}

// Pure, testable selector over an arbitrary catalogue list. Extracted so the
// per-entry `enabled` gate and cadence/retirement filtering can be verified in
// isolation (e.g. proving one disabled/invalid id removes only itself).
export function filterCatalogue(entries, {
  franchise = null, mediaType = null, includeRetired = false, includeDisabled = false,
} = {}) {
  const type = mediaType == null ? null : normalizeType(mediaType)
  return (Array.isArray(entries) ? entries : []).filter((e) => (
    (includeDisabled || e.enabled)
    && (includeRetired || e.pollTier !== POLL_TIER.RETIRED)
    && (franchise == null || e.franchise === franchise)
    && (type == null || e.mediaType === type)
  ))
}

// The real polling set: enabled, non-retired catalogue targets, each annotated
// with its poll cadence so the client can schedule fast vs slow refreshes.
export function catalogueTargets(options = {}) {
  return filterCatalogue(MARVEL_DC_CATALOGUE, options)
    .map((e) => ({ ...e, cadence: POLL_CADENCE[e.pollTier] ?? 'slow' }))
}

// Membership test — the ONLY way a title is treated as franchise media. Matches
// the FULL allowlist (including retired entries) so classification is independent
// of poll cadence; a disabled entry is NOT a member. Returns the franchise
// string, or null. Never inspects title/synopsis text.
export function isFranchiseMediaId(id, mediaType) {
  const type = normalizeType(mediaType)
  if (type == null || id == null) return null
  const match = MARVEL_DC_CATALOGUE.find((e) => e.enabled && e.id === id && e.mediaType === type)
  return match ? match.franchise : null
}

// Honest status for docs / PR / logging.
export function verificationStatus() {
  const total = MARVEL_DC_CATALOGUE.length
  const enabled = MARVEL_DC_CATALOGUE.filter((e) => e.enabled).length
  const liveVerified = MARVEL_DC_CATALOGUE.filter((e) => e.liveVerified).length
  const active = MARVEL_DC_CATALOGUE.filter((e) => e.pollTier === POLL_TIER.ACTIVE).length
  const legacy = MARVEL_DC_CATALOGUE.filter((e) => e.pollTier === POLL_TIER.LEGACY).length
  const retired = MARVEL_DC_CATALOGUE.filter((e) => e.pollTier === POLL_TIER.RETIRED).length
  return { total, enabled, liveVerified, pending: total - liveVerified, active, legacy, retired }
}

// The feature is ENABLED: an explicit media-id allowlist is safe by
// construction (it cannot pull unrelated media), so it does not gate on live
// verification the way a broad company query would have to. Enabled iff there is
// at least one non-retired, enabled target to poll.
export function isMarvelDcEnabled() {
  return catalogueTargets().length > 0
}
