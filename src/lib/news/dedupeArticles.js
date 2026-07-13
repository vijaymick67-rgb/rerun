import { normalizedTitleForDeduplication } from './normalizeArticle.js'

const RECOGNIZED_SOURCES = [
  'bbc',
  'deadline',
  'entertainment weekly',
  'hollywood reporter',
  'the guardian',
  'the wrap',
  'tvline',
  'variety',
]

function sourceScore(sourceName) {
  const source = sourceName.toLowerCase()
  return RECOGNIZED_SOURCES.some((name) => source.includes(name)) ? 4 : 0
}

function articleScore(article) {
  return [
    sourceScore(article.sourceName),
    article.imageUrl ? 2 : 0,
    article.description ? 1 : 0,
    new Date(article.publishedAt).getTime() / 1e13,
  ].reduce((total, value) => total + value, 0)
}

function preferredArticle(first, second) {
  return articleScore(second) > articleScore(first) ? second : first
}

export function dedupeArticles(articles) {
  const byUrl = new Map()
  for (const article of articles) {
    const existing = byUrl.get(article.canonicalUrl)
    byUrl.set(article.canonicalUrl, existing ? preferredArticle(existing, article) : article)
  }

  const byTitle = new Map()
  for (const article of byUrl.values()) {
    const titleKey = normalizedTitleForDeduplication(article.title)
    const existing = byTitle.get(titleKey)
    byTitle.set(titleKey, existing ? preferredArticle(existing, article) : article)
  }

  return [...byTitle.values()].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  )
}
