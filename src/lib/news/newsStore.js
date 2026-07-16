import { canonicalizeUrl, stableArticleId } from './normalizeArticle.js'
import { matchArticleToTrackedShow } from './matchTrackedShows.js'
import { isTvNewsArticle } from './tvNewsFilter.js'

export const NEWS_CACHE_KEY = 'rerun_news_cache:v1'
export const NEWS_CACHE_VERSION = 1
export const MY_SHOWS_VISIBLE_LIMIT = 10
export const MY_SHOWS_POOL_LIMIT = 50
export const GENERAL_VISIBLE_LIMIT = 6
// Freshness intent (Phase 8): prefer the last 7 days, but don't hide a sparse
// personal match just for being a little older; never resurface anything past 30 days.
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_ARTICLE_AGE_MS = 30 * 24 * 60 * 60 * 1000

function articleAgeMs(article, now) {
  const published = Date.parse(article.publishedAt)
  return Number.isFinite(published) ? now - published : Infinity
}

function isWithinMaxAge(article, now) {
  return articleAgeMs(article, now) <= MAX_ARTICLE_AGE_MS
}

function isRecent(article, now) {
  return articleAgeMs(article, now) <= RECENT_WINDOW_MS
}

function curatedBonus(article) {
  return article.provider && article.provider !== 'gnews' ? 1 : 0
}

function completenessScore(article) {
  return (article.imageUrl ? 1 : 0) + (article.description ? 1 : 0)
}

export function emptyNewsState() {
  return { version: NEWS_CACHE_VERSION, articles: {}, visibleIds: [], queuedIds: [], dismissedIds: [], lastSuccess: null }
}

function validArticle(article) {
  if (!article || typeof article !== 'object' || !article.title || !article.publishedAt) return null
  const canonicalUrl = canonicalizeUrl(article.canonicalUrl ?? article.url)
  const id = article.id ?? stableArticleId(canonicalUrl)
  return canonicalUrl && id ? { ...article, id, url: canonicalUrl, canonicalUrl } : null
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

export function sanitizeNewsState(value) {
  if (!value || value.version !== NEWS_CACHE_VERSION || !value.articles || typeof value.articles !== 'object') return emptyNewsState()
  const articles = {}
  for (const article of Object.values(value.articles)) {
    const valid = validArticle(article)
    if (valid) articles[valid.id] = valid
  }
  const dismissedIds = unique(Array.isArray(value.dismissedIds) ? value.dismissedIds : [])
  const dismissed = new Set(dismissedIds)
  const visibleIds = unique(Array.isArray(value.visibleIds) ? value.visibleIds : [])
    .filter((id) => articles[id] && !dismissed.has(id)).slice(0, MY_SHOWS_VISIBLE_LIMIT)
  const visible = new Set(visibleIds)
  const queuedIds = unique(Array.isArray(value.queuedIds) ? value.queuedIds : [])
    .filter((id) => articles[id] && !dismissed.has(id) && !visible.has(id))
    .slice(0, MY_SHOWS_POOL_LIMIT - visibleIds.length)
  return { version: NEWS_CACHE_VERSION, articles, visibleIds, queuedIds, dismissedIds,
    lastSuccess: Number.isFinite(value.lastSuccess) ? value.lastSuccess : null }
}

export function readNewsCache(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(NEWS_CACHE_KEY)
    return raw ? sanitizeNewsState(JSON.parse(raw)) : emptyNewsState()
  } catch { return emptyNewsState() }
}

export function writeNewsCache(state, storage = globalThis.localStorage) {
  const safe = sanitizeNewsState(state)
  try { storage?.setItem(NEWS_CACHE_KEY, JSON.stringify(safe)) } catch { /* storage is best effort */ }
  return safe
}

export function mergeNews(state, incoming, trackedShows, now = Date.now()) {
  const current = sanitizeNewsState(state)
  const articles = { ...current.articles }
  const dismissed = new Set(current.dismissedIds)
  const incomingIds = []
  const incomingUrls = new Set()
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const article = validArticle(raw)
    if (!article || incomingIds.includes(article.id) || incomingUrls.has(article.canonicalUrl)) continue
    articles[article.id] = article
    incomingIds.push(article.id)
    incomingUrls.add(article.canonicalUrl)
  }
  // A tracked show can be untracked, hidden, or renamed since an article was last
  // classified. Re-validating already-personal (visible/queued) articles against the
  // CURRENT trackedShows on every merge — not just newly-incoming ones — is what keeps
  // stored matchedShowId/matchedShowName authoritative, so selectors can trust it instead
  // of re-running the matcher themselves. This only touches the small personal pool
  // (at most MY_SHOWS_POOL_LIMIT articles), not the full cached article set.
  function reclassifyPersonal(id) {
    const match = matchArticleToTrackedShow(articles[id], trackedShows)
    if (match.matched) {
      articles[id] = { ...articles[id], matchedShowId: match.showId, matchedShowName: match.showName }
      return true
    }
    const { matchedShowId: _matchedShowId, matchedShowName: _matchedShowName, ...rest } = articles[id]
    articles[id] = rest
    return false
  }
  // Existing visible/queued personal matches age out too — a story pinned when fresh
  // must not stay visible or queued forever just because it was already promoted.
  const visibleIds = current.visibleIds.filter((id) =>
    articles[id] && !dismissed.has(id) && isWithinMaxAge(articles[id], now) && reclassifyPersonal(id))
  const existing = new Set(visibleIds)
  const queuedIds = current.queuedIds.filter((id) =>
    articles[id] && !dismissed.has(id) && !existing.has(id) && isWithinMaxAge(articles[id], now) && reclassifyPersonal(id))
  queuedIds.forEach((id) => existing.add(id))
  const newlyMatched = []
  for (const id of incomingIds) {
    if (dismissed.has(id) || existing.has(id)) continue
    const match = matchArticleToTrackedShow(articles[id], trackedShows)
    if (!match.matched) continue
    if (!isWithinMaxAge(articles[id], now)) continue
    articles[id] = { ...articles[id], matchedShowId: match.showId, matchedShowName: match.showName }
    newlyMatched.push(id)
    existing.add(id)
  }
  // Recent matches lead the queue; a sparse pool can still surface an older
  // (but never past MAX_ARTICLE_AGE_MS) personal match rather than showing nothing.
  newlyMatched.sort((a, b) => {
    const articleA = articles[a]
    const articleB = articles[b]
    const recentDelta = (isRecent(articleB, now) ? 1 : 0) - (isRecent(articleA, now) ? 1 : 0)
    if (recentDelta) return recentDelta
    const dateDelta = Date.parse(articleB.publishedAt) - Date.parse(articleA.publishedAt)
    if (dateDelta) return dateDelta
    return curatedBonus(articleB) - curatedBonus(articleA)
  })
  queuedIds.push(...newlyMatched)
  while (visibleIds.length < MY_SHOWS_VISIBLE_LIMIT && queuedIds.length) visibleIds.push(queuedIds.shift())
  const cappedQueue = queuedIds.slice(0, Math.max(0, MY_SHOWS_POOL_LIMIT - visibleIds.length))
  const pool = new Set([...visibleIds, ...cappedQueue])
  const generalIds = Object.values(articles)
    .filter((article) => !pool.has(article.id) && !dismissed.has(article.id) && isWithinMaxAge(article, now))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 30).map((article) => article.id)
  const retained = new Set([...pool, ...generalIds])
  const compactArticles = Object.fromEntries(Object.entries(articles).filter(([id]) => retained.has(id)))
  return sanitizeNewsState({ ...current, articles: compactArticles, visibleIds,
    queuedIds: cappedQueue, lastSuccess: now })
}

export function dismissMyShowsArticle(state, id) {
  const current = sanitizeNewsState(state)
  const visibleIds = current.visibleIds.filter((value) => value !== id)
  const queuedIds = current.queuedIds.filter((value) => value !== id)
  if (visibleIds.length < MY_SHOWS_VISIBLE_LIMIT && queuedIds.length) visibleIds.push(queuedIds.shift())
  return sanitizeNewsState({ ...current, visibleIds, queuedIds,
    dismissedIds: unique([...current.dismissedIds, id]) })
}

export function visibleMyShowsArticles(state, now = Date.now()) {
  const current = sanitizeNewsState(state)
  return current.visibleIds.map((id) => current.articles[id])
    .filter((article) => article && isWithinMaxAge(article, now))
}

// trackedShows is intentionally unused here: mergeNews's reclassifyPersonal keeps every
// visible/queued article's matchedShowId authoritative for the current tracked-show set
// on every merge (including the trackedShows-change re-merge triggered from BrowseNews),
// so a general-pool article's stored matchedShowId can be trusted directly instead of
// re-running the matcher for every article on every render. The parameter stays so
// callers don't need to change, and so a future caller that hasn't just re-merged still
// has an explicit reminder that freshness here depends on that invariant.
export function selectGeneralNews(state, trackedShows, now = Date.now()) {
  const current = sanitizeNewsState(state)
  const myShowsIds = new Set([...current.visibleIds, ...current.queuedIds, ...current.dismissedIds])
  return Object.values(current.articles)
    .filter((article) => !myShowsIds.has(article.id) && !article.matchedShowId)
    .filter(isTvNewsArticle)
    .filter((article) => isWithinMaxAge(article, now))
    .sort((a, b) => curatedBonus(b) - curatedBonus(a)
      || Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
      || completenessScore(b) - completenessScore(a)
      || a.id.localeCompare(b.id))
    .slice(0, GENERAL_VISIBLE_LIMIT)
}
