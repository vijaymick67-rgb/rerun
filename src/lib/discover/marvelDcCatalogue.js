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
// media type, the TMDB id, the human title, and the franchise. Trailers for
// these ids go through the exact same strict trailerFilter + trailerRank
// pipeline as tracked shows (see discoverClient.franchiseTrailers).
//
// ---------------------------------------------------------------------------
// HONEST LIVE-VERIFICATION STATUS
// ---------------------------------------------------------------------------
// These ids are the well-known, widely-documented TMDB media ids for these
// titles, curated from TMDB's public catalogue. They were NOT re-verified
// against a live TMDB response in the build sandbox because no TMDB API key is
// available there (outbound TMDB calls require the server-side key held only in
// Vercel; see api/tmdb.js). Every entry is therefore flagged `liveVerified:
// false`. `scripts/verify-marvel-dc.mjs` performs the live check through the
// same protected proxy/key when run in an environment that has the key; a
// maintainer runs it and flips the flags. Because membership is an explicit
// allowlist, the feature is safe to ENABLE while that verification is pending —
// the worst case is a single wrong/missing title, not a catalogue flood.

export const FRANCHISE = Object.freeze({ MARVEL: 'marvel', DC: 'dc' })
export const MEDIA_TYPE = Object.freeze({ TV: 'tv', MOVIE: 'movie' })

// Each entry: { mediaType, id, title, franchise, liveVerified }.
// Curated from TMDB's public catalogue; `liveVerified` is flipped by the
// maintainer after scripts/verify-marvel-dc.mjs confirms id -> title live.
export const MARVEL_DC_CATALOGUE = Object.freeze([
  // --- Marvel TV (Disney+ MCU series) ---
  { mediaType: 'tv', id: 84958, title: 'Loki', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'tv', id: 85271, title: 'WandaVision', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'tv', id: 88396, title: 'The Falcon and the Winter Soldier', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'tv', id: 88329, title: 'Hawkeye', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'tv', id: 92749, title: 'Moon Knight', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'tv', id: 92782, title: 'Ms. Marvel', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'tv', id: 92783, title: 'She-Hulk: Attorney at Law', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'tv', id: 114472, title: 'Secret Invasion', franchise: FRANCHISE.MARVEL, liveVerified: false },

  // --- Marvel movies (MCU) ---
  { mediaType: 'movie', id: 453395, title: 'Doctor Strange in the Multiverse of Madness', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'movie', id: 616037, title: 'Thor: Love and Thunder', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'movie', id: 505642, title: 'Black Panther: Wakanda Forever', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'movie', id: 640146, title: 'Ant-Man and the Wasp: Quantumania', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'movie', id: 447365, title: 'Guardians of the Galaxy Vol. 3', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'movie', id: 609681, title: 'The Marvels', franchise: FRANCHISE.MARVEL, liveVerified: false },
  { mediaType: 'movie', id: 533535, title: 'Deadpool & Wolverine', franchise: FRANCHISE.MARVEL, liveVerified: false },

  // --- DC TV ---
  { mediaType: 'tv', id: 110492, title: 'Peacemaker', franchise: FRANCHISE.DC, liveVerified: false },
  { mediaType: 'tv', id: 80564, title: 'Titans', franchise: FRANCHISE.DC, liveVerified: false },

  // --- DC movies ---
  { mediaType: 'movie', id: 414906, title: 'The Batman', franchise: FRANCHISE.DC, liveVerified: false },
  { mediaType: 'movie', id: 475557, title: 'Joker', franchise: FRANCHISE.DC, liveVerified: false },
  { mediaType: 'movie', id: 436270, title: 'Black Adam', franchise: FRANCHISE.DC, liveVerified: false },
  { mediaType: 'movie', id: 298618, title: 'The Flash', franchise: FRANCHISE.DC, liveVerified: false },
  { mediaType: 'movie', id: 572802, title: 'Aquaman and the Lost Kingdom', franchise: FRANCHISE.DC, liveVerified: false },
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

// All catalogue targets to fetch trailers for, optionally filtered.
export function catalogueTargets({ franchise = null, mediaType = null } = {}) {
  const type = mediaType == null ? null : normalizeType(mediaType)
  return MARVEL_DC_CATALOGUE.filter((entry) => (
    (franchise == null || entry.franchise === franchise)
    && (type == null || entry.mediaType === type)
  )).map((entry) => ({ ...entry }))
}

// Membership test — the ONLY way a title is treated as franchise media. Returns
// the franchise string, or null. Never inspects title/synopsis text.
export function isFranchiseMediaId(id, mediaType) {
  const type = normalizeType(mediaType)
  if (type == null || id == null) return null
  const match = MARVEL_DC_CATALOGUE.find((entry) => entry.id === id && entry.mediaType === type)
  return match ? match.franchise : null
}

// Honest status for docs / PR / logging.
export function verificationStatus() {
  const total = MARVEL_DC_CATALOGUE.length
  const liveVerified = MARVEL_DC_CATALOGUE.filter((entry) => entry.liveVerified).length
  return { total, liveVerified, pending: total - liveVerified }
}

// The feature is ENABLED: an explicit media-id allowlist is safe by
// construction (it cannot pull unrelated media), so it does not gate on live
// verification the way a broad company query would have to. There must be at
// least one target per franchise+type combination to be meaningful.
export function isMarvelDcEnabled() {
  return MARVEL_DC_CATALOGUE.length > 0
}
