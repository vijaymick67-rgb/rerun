// Deterministic event-language patterns for the announcement classifier.
//
// Split out from the classifier itself so the acceptance/rejection vocabulary is
// reviewable in one place. Everything here operates on NORMALIZED text (lower
// case, accent-free, punctuation collapsed to spaces) unless a name says "raw".
//
// Precision-first: a bare noun like "cancellation" or "renewal" is deliberately
// NOT a positive signal on its own — those nouns appear constantly in
// speculation ("renewal chances", "reacts to cancellation"). Positive detection
// requires the definitive verb/idiom forms below.

// ---------------------------------------------------------------------------
// Speculation / hedging. If any of these applies to an event clause, the event
// is not definitive and must be rejected (Scope F).
// ---------------------------------------------------------------------------
export const SPECULATION_TERMS = [
  /\bcould\b/, /\bmay\b/, /\bmight\b/, /\bwould\b/, /\bmaybe\b/, /\bperhaps\b/,
  /\blikely\b/, /\bunlikely\b/, /\bexpected to\b/, /\bexpect(?:s|ed)?\b/,
  /\breportedly\b/, /\brumou?r(?:s|ed|ing)?\b/, /\bspeculat(?:e|es|ed|ion|ing)\b/,
  /\bpredict(?:s|ed|ion|ions|ing)?\b/, /\bchances?\b/, /\bodds\b/,
  /\bdeserves?\b/, /\bhopes?\b/, /\bhoping\b/, /\bwants?\b/, /\bwish(?:es|list)?\b/,
  /\bfans? (?:think|hope|want|demand|fear)\b/, /\bdemand(?:s|ed|ing)?\b/,
  /\bin talks\b/, /\bey(?:e|ed|eing)? (?:for|to)\b/, /\bconsidering\b/, /\bin negotiations?\b/,
  /\bat risk\b/, /\bfears?\b/, /\bworried?\b/, /\bconcerns?\b/, /\brenewal watch\b/,
  /\bpotential(?:ly)?\b/, /\bpossible\b/, /\bteas(?:e|es|ed|ing)\b/,
]

// ---------------------------------------------------------------------------
// Negation of a specific event (Scope F). These flip a positive to a rejection.
// ---------------------------------------------------------------------------
export const RENEWAL_NEGATION = [
  /\bnot (?:yet |been |yet been )?renewed\b/, /\b(?:has|have|hasn t|haven t) not been renewed\b/,
  /\bno renewal\b/, /\bnot yet renewed\b/, /\byet to (?:be )?renew(?:ed)?\b/,
  /\bwon t be renewed\b/, /\bwill not be renewed\b/, /\bawaiting renewal\b/,
  /\bno (?:word|news) on (?:a )?renewal\b/, /\bno renewal (?:is )?confirmed\b/,
]
export const CANCELLATION_NEGATION = [
  /\bnot (?:been )?cancel(?:led|ed)\b/, /\bnot (?:been )?axed\b/,
  /\bavoids? cancellation\b/, /\bsaved from cancellation\b/, /\bescapes? cancellation\b/,
  /\bwon t be cancel(?:led|ed)\b/, /\bwill not be cancel(?:led|ed)\b/,
]

// ---------------------------------------------------------------------------
// RENEWAL positives (Scope A). Definitive language only.
// ---------------------------------------------------------------------------
export const RENEWAL_POSITIVE = [
  /\brenewed for\b/, /\brenewed\b/, /\brenews\b/,
  /\bordered (?:a )?(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/,
  /\bseason \d+ order(?:ed)?\b/, /\border(?:ed|s)? season \d+\b/,
  /\bpicked up for\b/, /\bpicked up (?:a|for a) (?:second|third|fourth|fifth|new|another)\b/,
  /\bgreen ?li(?:t|ght(?:ed)?) for\b/, /\bgreen ?li(?:t|ghted)\b/,
  /\bgets? (?:a )?(?:second|third|fourth|fifth|sixth|new|another) season\b/,
  /\breturning for (?:a )?(?:second|third|fourth|fifth|sixth|seventh|new|another)? ?season\b/,
  /\bgets (?:a )?season \d+\b/, /\bhanded (?:a )?(?:second|third|fourth|new|another) season\b/,
  /\bhanded (?:a )?season \d+ (?:order|renewal)\b/,
]

// ---------------------------------------------------------------------------
// CANCELLATION positives (Scope A). Explicit end only — never a bare noun, never
// a "planned final season" (that is a conclusion, handled by the guard below).
// ---------------------------------------------------------------------------
export const CANCELLATION_POSITIVE = [
  /\bcancel(?:led|ed)\b/, /\baxed\b/, /\bscrapped\b/,
  /\bnot returning\b/, /\bwon t return\b/, /\bwill not return\b/,
  /\bno season \d+\b/, /\bno (?:second|third|fourth|fifth|sixth) season\b/,
  /\bended (?:by|at) (?:the )?(?:network|hbo|netflix|max|fx|amc|apple|disney|hulu|paramount|peacock)\b/,
  /\bpulls the plug\b/, /\bcut short\b/, /\bwrapped for good\b/,
]

// A "planned final season" or a limited/anthology series naturally concluding is
// NOT a cancellation. If one of these applies and no explicit cancel verb is
// present, cancellation is rejected.
export const PLANNED_CONCLUSION = [
  /\bfinal season\b/, /\blast season\b/, /\bplanned (?:ending|conclusion|final)\b/,
  /\bwill (?:end|conclude|wrap up)\b/, /\bto (?:end|conclude|wrap up)\b/,
  /\bset to end\b/, /\bcoming to an end\b/, /\bconcludes? with\b/, /\bfinal chapter\b/,
]

// ---------------------------------------------------------------------------
// SEASON DATE positives (Scope A). Requires a CONCRETE date or window. Episode /
// finale / filming dates are rejected by guards in the classifier.
// ---------------------------------------------------------------------------
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december'

export const SEASON_DATE_POSITIVE = [
  new RegExp(`\\bpremieres? (?:on )?(?:${MONTHS})\\b`),
  new RegExp(`\\breturns? (?:on |in )?(?:${MONTHS})\\b`),
  new RegExp(`\\barrives? (?:on |in )?(?:${MONTHS})\\b`),
  new RegExp(`\\bdebuts? (?:on |in )?(?:${MONTHS})\\b`),
  new RegExp(`\\blands? (?:on |in )?(?:${MONTHS})\\b`),
  /\bpremieres? (?:on )?\w+ \d{1,2}\b/,
  /\bsets? (?:a )?(?:premiere|release) date\b/,
  /\b(?:premiere|release) date (?:set|revealed|confirmed|announced)\b/,
  new RegExp(`\\breturns? (?:this|next) (?:spring|summer|fall|autumn|winter)\\b`),
  new RegExp(`\\barrives? (?:this|next) (?:spring|summer|fall|autumn|winter)\\b`),
  new RegExp(`\\bpremieres? (?:this|next) (?:spring|summer|fall|autumn|winter)\\b`),
  new RegExp(`\\b(?:${MONTHS}) \\d{4}\\b`),
  /\b(?:q[1-4]) \d{4}\b/,
  /\b(?:spring|summer|fall|autumn|winter) \d{4}\b/,
  /\bearly \d{4}\b/, /\blate \d{4}\b/,
]

// Date-shaped phrases that must NOT be treated as a season premiere window.
export const DATE_REJECTION = [
  /\bepisode \d+\b/, /\bfinale\b/, /\bseries finale\b/, /\bseason finale\b/,
  /\bfilming (?:begins|starts|starting|underway|wraps)\b/,
  /\bproduction (?:begins|starts|starting|underway|wraps)\b/,
  /\bbegins? (?:filming|production|shooting)\b/,
  /\bcoming soon\b/, /\brelease date speculation\b/, /\bweekly (?:schedule|release)\b/,
]

// ---------------------------------------------------------------------------
// CAST ADDITION positives (Scope A). Requires a newly-confirmed meaningful
// addition; the classifier separately requires an actual named person.
// ---------------------------------------------------------------------------
// Positive cast-addition verbs. Generic "joins"/"boards"/"tapped" are allowed
// here but the classifier additionally requires a CAST-context word in the same
// clause AND an actual named person, so a bare "joins the conversation" cannot
// slip through.
export const CAST_ADDITION_POSITIVE = [
  /\bjoins\b/, /\bboards?\b/, /\btapped\b/,
  /\bcast as\b/, /\bcast in\b/,
  /\badded as (?:a )?(?:series regular|recurring)\b/,
  /\bset as (?:a )?series regular\b/, /\bnew series regular\b/,
  /\bconfirmed (?:for|as) (?:a )?(?:recurring|series regular)\b/,
  /\bsigns? on (?:to|for)\b/,
]

// Cast-addition disqualifiers: someone leaving, a one-episode guest, a wishlist.
export const CAST_REJECTION = [
  /\bexits?\b/, /\bexit(?:s|ed|ing)?\b/, /\bleav(?:e|es|ing)\b/, /\bdepart(?:s|ed|ing|ure)?\b/,
  /\bquits?\b/, /\bfired\b/, /\brecast(?:ing)?\b/, /\bwrites? out\b/, /\bwritten out\b/,
  /\bguest star(?:s|ring)?\b/, /\bone (?:off|episode)\b/, /\bsingle episode\b/, /\bcameo\b/,
  /\bwish ?list\b/, /\bfan cast(?:ing)?\b/, /\bwants to cast\b/, /\bdream cast\b/,
]

// ---------------------------------------------------------------------------
// Disallowed article categories (Scope E). Rejected before expensive
// extraction. Matched against the normalized headline (+ description for a few).
// ---------------------------------------------------------------------------
export const DISALLOWED_CATEGORY = [
  /\breview\b/, /\brecap\b/, /\bexplained\b/, /\bending explained\b/,
  /\binterview\b/, /\bq and a\b/, /\bsits? down with\b/, /\bopens? up about\b/,
  /\btalks? (?:about|to)\b/, /\bdiscuss(?:es|ing|ed)?\b/, /\bweighs? in\b/, /\breacts?\b/,
  /\brank(?:s|ed|ing|ings)?\b/, /\bbest (?:episodes?|shows?|series)\b/, /\bshows? like\b/,
  /\bwhat to watch\b/, /\bwhere to watch\b/, /\bhow to watch\b/,
  /\bawards?\b/, /\bemmy\b/, /\bgolden globe\b/, /\bratings? (?:report|analysis)\b/,
  /\bviewership\b/, /\bbox office\b/, /\bopinion\b/, /\btheory\b/, /\btheories\b/,
  /\brumou?r(?:s)?\b/, /\bspeculation\b/, /\bpredict(?:ions?)?\b/,
  /\btrailer\b/, /\bteaser\b/, /\bfirst look\b/, /\bpreview\b/, /\bsneak peek\b/, /\bclip\b/,
  /\bbehind the scenes\b/, /\bfeaturette\b/, /\bset photos?\b/, /\bset visit\b/,
  /\bretrospective\b/, /\banniversary\b/, /\breunion\b/, /\blessons? from\b/,
  /\bevery(?:thing)? (?:episode|season) ranked\b/, /\bpower ranking\b/,
  /\bthings you (?:missed|didn t notice)\b/, /\beaster eggs?\b/, /\bwatch order\b/,
]

// Listicle / roundup shapes: reject by default (Scope C multi-title).
export const LISTICLE_SHAPE = [
  /^\d+\b/, // "10 shows that..."
  /\b\d+ (?:shows?|series|reasons?|things?|moments?|episodes?|characters?)\b/,
  /\bround ?up\b/, /\bthe best\b/, /\btop \d+\b/,
]

export const SEASON_ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10,
}
