import { XMLParser } from 'fast-xml-parser'
import { createNewsProvider, NewsProviderError } from './provider.js'

const DEFAULT_TIMEOUT_MS = 6000
const DEFAULT_MAX_ARTICLES = 8
// Curated feeds are third-party text we don't control — cap the response we'll
// even attempt to parse so a misbehaving or compromised host can't force us to
// buffer/parse an unbounded payload.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

// fast-xml-parser never resolves external entities/DTDs, so there is no XXE surface
// here — it only ever reads the tags/text present in the response body itself.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '#cdata',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  allowBooleanAttributes: true,
})

function toArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function textOf(node) {
  if (node === undefined || node === null) return null
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (typeof node === 'object') {
    if (typeof node['#text'] === 'string') return node['#text']
    if (typeof node['#cdata'] === 'string') return node['#cdata']
  }
  return null
}

// Feed descriptions are HTML from a third party; we only ever want plain text out
// of them, so tags (and their script/style contents) are stripped rather than kept
// for any kind of rendering.
function stripHtml(value) {
  if (typeof value !== 'string') return null
  const withoutBlocks = value.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, ' ')
  const collapsed = withoutTags.replace(/\s+/g, ' ').trim()
  return collapsed || null
}

function rssImage(item) {
  const enclosure = toArray(item?.enclosure).find((entry) => {
    const type = entry?.['@_type']
    return typeof type === 'string' ? type.startsWith('image/') : Boolean(entry?.['@_url'])
  })
  if (enclosure?.['@_url']) return enclosure['@_url']
  const media = item?.['media:content'] ?? item?.['media:thumbnail']
  const mediaEntry = Array.isArray(media) ? media[0] : media
  return mediaEntry?.['@_url'] ?? null
}

function rssItemToRaw(item, sourceName) {
  const title = textOf(item?.title)
  const link = typeof item?.link === 'string' ? item.link : textOf(item?.link) ?? item?.link?.['@_href']
  const description = stripHtml(textOf(item?.description) ?? textOf(item?.['content:encoded']))
  const publishedAt = textOf(item?.pubDate) ?? textOf(item?.['dc:date'])
  if (!title || !link || !publishedAt) return null
  return { title, description, url: link, image: rssImage(item), source: { name: sourceName }, publishedAt }
}

function atomLink(entry) {
  const links = toArray(entry?.link)
  const alternate = links.find((link) => !link?.['@_rel'] || link['@_rel'] === 'alternate')
  return alternate?.['@_href'] ?? links[0]?.['@_href'] ?? null
}

function atomEntryToRaw(entry, sourceName) {
  const title = textOf(entry?.title)
  const link = atomLink(entry)
  const description = stripHtml(textOf(entry?.summary) ?? textOf(entry?.content))
  const publishedAt = textOf(entry?.published) ?? textOf(entry?.updated)
  if (!title || !link || !publishedAt) return null
  return { title, description, url: link, image: null, source: { name: sourceName }, publishedAt }
}

function parseFeed(xml, sourceName, maxArticles) {
  let parsed
  try {
    parsed = parser.parse(xml)
  } catch (error) {
    throw new NewsProviderError('MALFORMED_RESPONSE', 'The feed could not be parsed', error)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new NewsProviderError('MALFORMED_RESPONSE', 'The feed did not match RSS or Atom structure')
  }

  const rssItems = toArray(parsed.rss?.channel?.item)
  if (rssItems.length) {
    return rssItems.slice(0, maxArticles).map((item) => rssItemToRaw(item, sourceName)).filter(Boolean)
  }
  const atomEntries = toArray(parsed.feed?.entry)
  if (atomEntries.length) {
    return atomEntries.slice(0, maxArticles).map((entry) => atomEntryToRaw(entry, sourceName)).filter(Boolean)
  }
  // A feed with a recognizable channel/feed root but zero items is valid — just empty.
  if (parsed.rss?.channel || parsed.feed) return []
  throw new NewsProviderError('MALFORMED_RESPONSE', 'The feed did not match RSS or Atom structure')
}

// A curated source is fetched only from the exact allow-listed URL passed in here —
// this provider never accepts a caller-supplied feed URL.
export function createRssProvider({
  name,
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxArticles = DEFAULT_MAX_ARTICLES,
} = {}) {
  if (!name || !url) throw new TypeError('A curated feed requires a name and url')

  return createNewsProvider({
    name,
    async fetchArticles() {
      if (typeof fetchImpl !== 'function') {
        throw new NewsProviderError('FETCH_UNAVAILABLE', 'The feed provider is unavailable')
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
          signal: controller.signal,
        })
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new NewsProviderError('TIMEOUT', 'The feed provider timed out', error)
        }
        throw new NewsProviderError('NETWORK_ERROR', 'The feed provider could not be reached', error)
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        throw new NewsProviderError('UPSTREAM_ERROR', 'The feed provider returned an error', null, {
          status: Number.isInteger(response.status) ? response.status : null, code: null, message: null,
        })
      }

      const xml = await response.text()
      if (xml.length > MAX_RESPONSE_BYTES) {
        throw new NewsProviderError('RESPONSE_TOO_LARGE', 'The feed response was too large')
      }

      return parseFeed(xml, name, maxArticles)
    },
  })
}

export { DEFAULT_TIMEOUT_MS as RSS_DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES as RSS_MAX_RESPONSE_BYTES }
