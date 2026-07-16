// Named HTML character references we decode, beyond the 5 XML-predefined ones
// (amp/lt/gt/quot/apos). This is the standard HTML4/Latin-1 + common-symbol
// entity set used across RSS/Atom feeds and news copy — broad enough to cover
// real-world feed text without becoming an ad-hoc list of the handful of
// entities seen in one bug report.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', iexcl: '¡', cent: '¢', pound: '£', curren: '¤',
  yen: '¥', brvbar: '¦', sect: '§', uml: '¨', copy: '©',
  ordf: 'ª', laquo: '«', not: '¬', shy: '­', reg: '®',
  macr: '¯', deg: '°', plusmn: '±', sup2: '²', sup3: '³',
  acute: '´', micro: 'µ', para: '¶', middot: '·', cedil: '¸',
  sup1: '¹', ordm: 'º', raquo: '»', frac14: '¼', frac12: '½',
  frac34: '¾', iquest: '¿', times: '×', divide: '÷',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä',
  Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É',
  Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î',
  Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó',
  Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù',
  Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ',
  szlig: 'ß', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã',
  auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è',
  eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í',
  icirc: 'î', iuml: 'ï', eth: 'ð', ntilde: 'ñ', ograve: 'ò',
  oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý',
  thorn: 'þ', yuml: 'ÿ',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡',
  hellip: '…', permil: '‰', lsaquo: '‹', rsaquo: '›', euro: '€',
  trade: '™', bull: '•', prime: '′', Prime: '″', oline: '‾',
  frasl: '⁄', minus: '−',
  hearts: '♥', spades: '♠', clubs: '♣', diams: '♦',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
}

// Matches a decimal ref (#123), a hex ref (#x1F or #X1f), or a named ref (amp) —
// one alternation so the whole decode is a single linear scan/replace over the
// input. Doing this in one pass (rather than three sequential .replace calls,
// or numeric-then-named) is what keeps double-escaped input safe: a match's
// *replacement* text is never rescanned, so "&amp;lt;script&amp;gt;" decodes
// its two "&amp;" occurrences to "&" and stops — it does not then notice the
// resulting "&lt;" / "&gt;" and decode those too. Repeated/looped decoding
// would turn that into a real "<script>" tag; a single pass cannot.
// Named references are matched case-sensitively (no /i flag) — "Aacute" (Á)
// and "aacute" (á) are different characters, so casing can't be normalized
// away before the NAMED_ENTITIES lookup the way the hex-marker "x"/"X" can.
const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g

function decodeEntityMatch(whole, body) {
  if (body[0] === '#') {
    const isHex = body[1] === 'x' || body[1] === 'X'
    const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      // Lone surrogate half or similar — leave the original reference untouched
      // rather than crashing the provider on a malformed upstream feed.
      return whole
    }
  }
  const named = NAMED_ENTITIES[body]
  return named !== undefined ? named : whole
}

// Decodes numeric (decimal/hex) and standard named HTML character references in
// a single left-to-right pass. Unknown entities (e.g. "&foo;") are left exactly
// as written rather than guessed at or stripped.
export function decodeHtmlEntities(value) {
  if (typeof value !== 'string' || !value) return value
  return value.replace(ENTITY_PATTERN, decodeEntityMatch)
}

// Feed text is third-party HTML; only plain text is ever wanted out of it, so
// <script>/<style> blocks (and their contents) are removed before any other
// tags are stripped. This must run *after* decodeHtmlEntities, not before —
// otherwise an entity-encoded "&lt;script&gt;...&lt;/script&gt;" would still
// contain literal "<script>" once decoded, without ever having passed through
// this stripping step.
function stripMarkup(value) {
  const withoutBlocks = value.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  return withoutBlocks.replace(/<[^>]+>/g, ' ')
}

// The single shared cleanup pass for any user-facing news text (title or
// description) from any provider: decode entities once, strip markup that
// decoding may have revealed, then collapse whitespace (this also turns a
// decoded &nbsp; into an ordinary space). Returns null for empty/non-string
// input so callers can treat it the same as "field absent".
export function sanitizeNewsText(value) {
  if (typeof value !== 'string') return null
  const decoded = decodeHtmlEntities(value)
  const stripped = stripMarkup(decoded)
  const collapsed = stripped.replace(/\s+/g, ' ').trim()
  return collapsed || null
}
