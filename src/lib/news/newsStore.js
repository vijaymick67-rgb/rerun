import { canonicalizeUrl, stableArticleId } from './normalizeArticle.js'
import { matchArticleToTrackedShow } from './matchTrackedShows.js'

export const NEWS_CACHE_KEY = 'rerun_news_cache:v1'
export const NEWS_CACHE_VERSION = 1
export const MY_SHOWS_VISIBLE_LIMIT = 10
export const MY_SHOWS_POOL_LIMIT = 50
export const GENERAL_VISIBLE_LIMIT = 6

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
  const visibleIds = current.visibleIds.filter((id) => articles[id] && !dismissed.has(id))
  const existing = new Set(visibleIds)
  const queuedIds = current.queuedIds.filter((id) => articles[id] && !dismissed.has(id) && !existing.has(id))
  queuedIds.forEach((id) => existing.add(id))
  for (const id of incomingIds) {
    if (dismissed.has(id) || existing.has(id)) continue
    const match = matchArticleToTrackedShow(articles[id], trackedShows)
    if (!match.matched) continue
    articles[id] = { ...articles[id], matchedShowId: match.showId, matchedShowName: match.showName }
    queuedIds.push(id)
    existing.add(id)
  }
  while (visibleIds.length < MY_SHOWS_VISIBLE_LIMIT && queuedIds.length) visibleIds.push(queuedIds.shift())
  const cappedQueue = queuedIds.slice(0, Math.max(0, MY_SHOWS_POOL_LIMIT - visibleIds.length))
  const pool = new Set([...visibleIds, ...cappedQueue])
  const generalIds = Object.values(articles)
    .filter((article) => !pool.has(article.id) && !dismissed.has(article.id))
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

export function visibleMyShowsArticles(state) {
  const current = sanitizeNewsState(state)
  return current.visibleIds.map((id) => current.articles[id]).filter(Boolean)
}

export function selectGeneralNews(state, trackedShows) {
  const current = sanitizeNewsState(state)
  const myShowsIds = new Set([...current.visibleIds, ...current.queuedIds, ...current.dismissedIds])
  return Object.values(current.articles)
    .filter((article) => !myShowsIds.has(article.id) && !matchArticleToTrackedShow(article, trackedShows).matched)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id))
    .slice(0, GENERAL_VISIBLE_LIMIT)
}
