// Source trust model for announcements (Scope G).
//
// A renewal/cancellation/date/casting event is only as trustworthy as the
// outlet reporting it. Rather than maintain an enormous unreliable domain
// blacklist, we keep a compact, maintainable ALLOW/trust model:
//
//   Tier 1 — official network/streamer/studio press. Definitive by nature.
//   Tier 2 — reputable industry trades already supported by the project
//            (Deadline, Variety, THR, TVLine, …).
//   Tier 3 — everything else. Accepted only when event + identity confidence is
//            very high, language is definitive, and no conflict exists. A Tier 3
//            source can never establish an event by itself under a weak signal.
//
// Trust is resolved from the article's source name and/or canonical URL host.
// We match on registrable-domain / known-name tokens, never arbitrary
// substrings, so "notdeadline.example.com" does not inherit Deadline's tier.

export const TRUST_TIER = Object.freeze({
  OFFICIAL: 1,
  TRADE: 2,
  OTHER: 3,
})

// Tier 1: official press domains. Kept deliberately small and high-signal —
// these are press/newsroom hosts, not general fan portals. Documented per entry.
const TIER1_HOSTS = new Set([
  'press.hbo.com',
  'press.wbd.com', // Warner Bros. Discovery press
  'warnermediapressroom.com',
  'about.netflix.com', // Netflix official newsroom (Tudum press lives here)
  'netflixpressroom.com',
  'press.disneyplus.com',
  'thewaltdisneycompany.com',
  'marvel.com',
  'dc.com',
  'press.aboutamazon.com',
  'amazonmgmstudios.com',
  'apple.com', // Apple TV+ press releases live under apple.com/newsroom
  'fxnetworks.com',
  'paramountpressexpress.com',
  'peacocktv.com',
  'sky.com',
  'bbc.co.uk',
])

// Tier 2: reputable trades. Matched by registrable domain OR by source name
// token (RSS feeds report a human name like "Deadline", not a host).
const TIER2_HOSTS = new Set([
  'deadline.com',
  'variety.com',
  'hollywoodreporter.com',
  'tvline.com',
  'ew.com', // Entertainment Weekly
  'thewrap.com',
  'vulture.com',
  'collider.com',
  'ign.com',
])

const TIER2_NAME_TOKENS = new Set([
  'deadline',
  'variety',
  'hollywood reporter',
  'the hollywood reporter',
  'tvline',
  'tv line',
  'entertainment weekly',
  'thewrap',
  'the wrap',
  'vulture',
  'collider',
  'ign',
])

const TIER1_NAME_TOKENS = new Set([
  'hbo',
  'max',
  'netflix',
  'disney',
  'marvel',
  'dc',
  'apple tv',
  'prime video',
  'fx',
  'paramount',
  'peacock',
  'bbc',
])

function hostOf(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

// registrable-domain suffix match: "press.hbo.com" matches TIER1_HOSTS entry
// "press.hbo.com"; "deadline.com" matches TIER2 "deadline.com"; a bare
// "hbo.com" also matches a TIER1 host ending in ".hbo.com" only when the set
// entry is a suffix of it on a dot boundary. Never a raw substring.
function hostMatches(host, set) {
  if (!host) return false
  if (set.has(host)) return true
  for (const entry of set) {
    if (host === entry || host.endsWith(`.${entry}`)) return true
  }
  return false
}

function normalizeName(value) {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().replace(/\s+/g, ' ')
    : ''
}

function nameMatches(name, tokens) {
  if (!name) return false
  if (tokens.has(name)) return true
  // token appears as a bounded word-run inside the source name
  const words = name.split(' ')
  for (const token of tokens) {
    const tw = token.split(' ')
    for (let i = 0; i <= words.length - tw.length; i += 1) {
      if (tw.every((w, o) => words[i + o] === w)) return true
    }
  }
  return false
}

// Resolve the trust tier for an article. Prefers host evidence (harder to
// spoof in an RSS feed than a display name), then falls back to the reported
// source name. Unknown -> Tier 3.
export function resolveSourceTrust(article) {
  const host = hostOf(article?.canonicalUrl ?? article?.url)
  const name = normalizeName(article?.sourceName)

  if (hostMatches(host, TIER1_HOSTS) || nameMatches(name, TIER1_NAME_TOKENS)) return TRUST_TIER.OFFICIAL
  if (hostMatches(host, TIER2_HOSTS) || nameMatches(name, TIER2_NAME_TOKENS)) return TRUST_TIER.TRADE
  return TRUST_TIER.OTHER
}

export function isTrustedTrade(article) {
  return resolveSourceTrust(article) <= TRUST_TIER.TRADE
}
