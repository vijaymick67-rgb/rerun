import { XMLParser } from 'fast-xml-parser'
import { createNewsProvider, isNewsProviderError, NewsProviderError } from './provider.js'
import { sanitizeNewsText } from './sanitizeNewsText.js'

const DEFAULT_TIMEOUT_MS = 6000
const DEFAULT_MAX_ARTICLES = 8
// Curated feeds are third-party text we don't control — cap the bytes we'll accept
// before parsing. A trustworthy Content-Length is rejected up front with no body read
// at all. Where the runtime exposes a readable stream (real fetch, Vercel/Node), the
// response is read incrementally and cancelled the moment it crosses this cap, so a
// misbehaving or compromised host can't force a full unbounded buffer/parse. Runtimes
// or test doubles without a readable stream fall back to a post-hoc size check on the
// buffered text — that path only catches an oversized payload after the fact, it does
// not prevent the buffering itself.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

// fast-xml-parser never resolves external entities/DTDs, so there is no XXE surface
// here — it only ever reads the tags/text present in the response body itself.
//
// processEntities is explicitly disabled: fast-xml-parser's own entity decoding only
// covers the 5 XML-predefined entities (amp/lt/gt/quot/apos), only on plain text nodes,
// and — critically — never inside CDATA sections (correct per the XML spec, since CDATA
// suppresses entity parsing, but most RSS descriptions arrive as CDATA-wrapped HTML
// specifically expecting entities like "&#8217;" or "&amp;" to be decoded for display).
// Decoding numeric refs and named HTML entities here as well as in sanitizeNewsText
// below would mean the same text gets two independent decode passes (once inside the
// parser, once in our own step) with different rules for text nodes vs CDATA — an
// inconsistency that is also how a double-escaped string could end up decoded twice.
// Leaving raw entity text untouched at this layer means sanitizeNewsText's single pass
// is the only decode step, applied identically regardless of node type.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '#cdata',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  allowBooleanAttributes: true,
  processEntities: false,
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
  const title = sanitizeNewsText(textOf(item?.title))
  const link = typeof item?.link === 'string' ? item.link : textOf(item?.link) ?? item?.link?.['@_href']
  const description = sanitizeNewsText(textOf(item?.description) ?? textOf(item?.['content:encoded']))
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
  const title = sanitizeNewsText(textOf(entry?.title))
  const link = atomLink(entry)
  const description = sanitizeNewsText(textOf(entry?.summary) ?? textOf(entry?.content))
  const publishedAt = textOf(entry?.published) ?? textOf(entry?.updated)
  if (!title || !link || !publishedAt) return null
  return { title, description, url: link, image: null, source: { name: sourceName }, publishedAt }
}

function contentLengthOf(response) {
  const raw = typeof response.headers?.get === 'function' ? response.headers.get('content-length') : null
  if (raw === null || raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function abortError() {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

// Races a promise against an abort signal so a stalled body read (fetch already
// resolved with headers, but the stream never delivers a chunk) still rejects the
// instant the caller's timeout fires — rather than waiting on a promise that may
// never settle on its own.
function raceWithAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

// Reads the response body up to `maxBytes`, counting actual bytes (not JS string
// characters, which undercount multi-byte UTF-8 text). Cancels the stream the instant
// the cap is crossed rather than finishing the download first. `signal` is the same
// AbortSignal used for the initial fetch — headers can arrive quickly while the body
// stalls indefinitely, so the timeout has to keep covering this read, not just the
// fetch call that returned headers.
async function readBoundedText(response, maxBytes, signal) {
  const contentLength = contentLengthOf(response)
  if (contentLength !== null && contentLength > maxBytes) {
    throw new NewsProviderError('RESPONSE_TOO_LARGE', 'The feed response was too large')
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let received = 0
    let text = ''
    try {
      for (;;) {
        let result
        try {
          result = await raceWithAbort(reader.read(), signal)
        } catch (error) {
          await reader.cancel().catch(() => {})
          throw error
        }
        const { done, value } = result
        if (done) break
        received += value?.byteLength ?? 0
        if (received > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new NewsProviderError('RESPONSE_TOO_LARGE', 'The feed response was too large')
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } finally {
      reader.releaseLock?.()
    }
    return text
  }

  const text = await raceWithAbort(response.text(), signal)
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new NewsProviderError('RESPONSE_TOO_LARGE', 'The feed response was too large')
  }
  return text
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

      // This timer has to stay live through the connection, the headers, and the
      // full bounded body read — fetch resolves as soon as headers arrive, so a feed
      // that stalls its streaming body would otherwise run past the timeout with
      // nothing left watching it. It is cleared exactly once, in the outer `finally`.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
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
        }

        if (!response.ok) {
          throw new NewsProviderError('UPSTREAM_ERROR', 'The feed provider returned an error', null, {
            status: Number.isInteger(response.status) ? response.status : null, code: null, message: null,
          })
        }

        let xml
        try {
          xml = await readBoundedText(response, MAX_RESPONSE_BYTES, controller.signal)
        } catch (error) {
          if (isNewsProviderError(error)) throw error
          if (error?.name === 'AbortError') {
            throw new NewsProviderError('TIMEOUT', 'The feed provider timed out', error)
          }
          throw new NewsProviderError('NETWORK_ERROR', 'The feed body could not be read', error)
        }

        return parseFeed(xml, name, maxArticles)
      } finally {
        clearTimeout(timer)
      }
    },
  })
}

export { DEFAULT_TIMEOUT_MS as RSS_DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES as RSS_MAX_RESPONSE_BYTES }
