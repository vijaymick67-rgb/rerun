const TRACKING_PARAMETERS = new Set(['fbclid', 'gclid'])

function isTrackingParameter(name) {
  return name.toLowerCase().startsWith('utm_') || TRACKING_PARAMETERS.has(name.toLowerCase())
}

export function canonicalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null

  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null

    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (isTrackingParameter(key)) url.searchParams.delete(key)
    }
    url.hostname = url.hostname.toLowerCase()
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return null
  }
}

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function cleanDescription(value) {
  const description = cleanText(value)
  return description ? description.slice(0, 320) : null
}

function normalizeTitle(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function stableHash(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function stableArticleId(canonicalUrl) {
  const canonical = canonicalizeUrl(canonicalUrl)
  return canonical ? `gnews-${stableHash(canonical)}` : null
}

export function normalizeArticle(raw, { fetchedAt = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object') return null

  const title = cleanText(raw.title)
  const canonicalUrl = canonicalizeUrl(raw.url)
  const sourceName = cleanText(raw.source?.name)
  const publishedDate = raw.publishedAt ? new Date(raw.publishedAt) : null
  const fetchedDate = new Date(fetchedAt)
  const imageUrl = canonicalizeUrl(raw.image)

  if (!title || !canonicalUrl || !sourceName || !publishedDate || Number.isNaN(publishedDate.getTime())) {
    return null
  }
  if (Number.isNaN(fetchedDate.getTime())) return null

  return {
    id: stableArticleId(canonicalUrl),
    title,
    description: cleanDescription(raw.description),
    url: canonicalUrl,
    canonicalUrl,
    imageUrl,
    sourceName,
    publishedAt: publishedDate.toISOString(),
    fetchedAt: fetchedDate.toISOString(),
    provider: 'gnews',
  }
}

export function normalizedTitleForDeduplication(title) {
  return normalizeTitle(title)
}
