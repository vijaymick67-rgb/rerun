const STRONG_TV_FORMATS = [
  /\b(?:television|tv|streaming|limited|drama|comedy) series\b/i,
  /\bmini-?series\b|\bsitcom\b/i,
  /\bseries premiere\b|\btelevision adaptation\b|\btv adaptation\b/i,
  /\bstreaming (?:service|platform)\b|\bstreamer\b/i,
]

const PROGRAMMING_ACTIONS = /\b(?:renew(?:s|ed|al)?|cancel(?:s|led|ed|lation)?|premiere(?:s|d)?|episode|showrunner|trailer|casting|casts?|release date|sets? (?:a )?premiere date|production|schedule|adaptation)\b/i
const SERIES_CONTEXT = /\b(?:television|tv|streaming|limited|drama|comedy|scripted|upcoming|new) series\b|\bseason\s*\d+\b|\bmini-?series\b|\bsitcom\b|\btelevision (?:show|programme|program)\b/i
const TV_BRANDS = /\b(?:hbo|max|netflix|apple tv\+?|prime video|disney\+|hulu|peacock|paramount\+|fx|amc|showtime)\b/i

const CRIME_OR_GEOPOLITICS = /\b(?:crime|murder|killed|execution|executes?|terror(?:ism|ist)?|islamic state|armed rebellion|war|military|geopolitic|election|politician|president|parliament|government|court|judge)\b/i
const SPORTS = /\b(?:mlb|nfl|nba|nhl|football|baseball|basketball|hockey|soccer|tennis|derby|dingers?|match|tournament|league|home run)\b/i
const MUSIC = /\b(?:k-?pop|concert|album|song|singer|music video|music chart|band|rapper)\b/i
const PRESENTER_CONTROVERSY = /\b(?:tv |television )?(?:presenter|anchor|broadcaster|host)\b.*\b(?:apology|apologises?|apologizes?|controversy|slammed|remark)\b/i
const HARDWARE_OR_TELECOM = /\b(?:smart tv|television set|tv hardware|display panel|oled|qled|telecom|5g network|broadband|router|antenna|set-top box)\b/i
const MOVIE_ONLY = /\b(?:movie|film|cinema|theatrical|filmmaker|box office)\b/i
const SCRIPTED_TV = /\bscripted (?:television|tv|streaming)?\s*series\b|\b(?:limited|drama|comedy) series\b|\bmini-?series\b|\bsitcom\b/i
const CORPORATE = /\b(?:merger|acquisition|deal|lawsuit|legal battle|earnings|shares?|stock|financial)\b/i
const CORPORATE_TV_CONTEXT = /\b(?:streaming|television programming|tv programming|studio|broadcast network|cable network|viewer access|subscribers?)\b/i
const PERSONALITY_SIDELIGHT = /\b(?:star|presenter|host|anchor|broadcaster|reality star)\b.*\b(?:owner|house|home|property|apology|controversy|remark)\b/i

function hasStrongTvSignal(text) {
  return STRONG_TV_FORMATS.some((pattern) => pattern.test(text)) ||
    (PROGRAMMING_ACTIONS.test(text) && (SERIES_CONTEXT.test(text) || TV_BRANDS.test(text))) ||
    (CORPORATE.test(text) && CORPORATE_TV_CONTEXT.test(text))
}

export function isTvNewsArticle(article) {
  if (!article?.title) return false
  const title = article.title
  const text = `${title} ${article.description ?? ''}`
  const strongTv = hasStrongTvSignal(text)
  if (!strongTv) return false
  if (CRIME_OR_GEOPOLITICS.test(text)) return false
  if (SPORTS.test(text)) return false
  if (MUSIC.test(text) && !SCRIPTED_TV.test(text)) return false
  if (PRESENTER_CONTROVERSY.test(title) && !SERIES_CONTEXT.test(text)) return false
  if (PERSONALITY_SIDELIGHT.test(title) && !(PROGRAMMING_ACTIONS.test(text) && SERIES_CONTEXT.test(text))) return false
  if (HARDWARE_OR_TELECOM.test(text)) return false
  if (MOVIE_ONLY.test(text) && !/\b(?:television|tv) adaptation\b|\btelevision series\b|\btv series\b/i.test(text)) return false
  if (CORPORATE.test(text) && !CORPORATE_TV_CONTEXT.test(text)) return false
  return true
}

export function filterTvNews(articles) {
  return articles.filter(isTvNewsArticle)
}
