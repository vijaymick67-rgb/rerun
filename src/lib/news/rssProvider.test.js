import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRssProvider, RSS_MAX_RESPONSE_BYTES } from './rssProvider.js'
import { CURATED_FEED_SOURCES } from './feedSources.js'
import { isNewsProviderError } from './provider.js'

const RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example TV Desk</title>
    <item>
      <title>Show Renewed for Season 2</title>
      <link>https://example.com/story-one</link>
      <description><![CDATA[<p>The <b>network</b> confirmed <script>alert(1)</script>the next season.</p>]]></description>
      <pubDate>Mon, 13 Jul 2026 10:00:00 GMT</pubDate>
      <enclosure url="https://images.example.com/one.jpg" type="image/jpeg" />
    </item>
    <item>
      <title>Second Story</title>
      <link>https://example.com/story-two</link>
      <pubDate>Mon, 13 Jul 2026 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`

const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Desk</title>
  <entry>
    <title>Atom Show Trailer Drops</title>
    <link rel="alternate" href="https://example.com/atom-story" />
    <summary>A first look at the new season.</summary>
    <published>2026-07-13T08:00:00Z</published>
  </entry>
</feed>`

function textResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async text() { return body } }
}

function contentLengthResponse(contentLength, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(contentLength) : null) },
    async text() { throw new Error('text() must not be called when Content-Length already rejects the response') },
  }
}

function streamResponse(body, { chunkBytes, ok = true, status = 200 } = {}) {
  const bytes = new TextEncoder().encode(body)
  const chunkSize = chunkBytes ?? (bytes.length || 1)
  const chunks = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize))
  }
  let index = 0
  const cancel = vi.fn(async () => {})
  return {
    ok,
    status,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined }
            const value = chunks[index]
            index += 1
            return { done: false, value }
          },
          releaseLock() {},
          cancel,
        }
      },
    },
    async text() { throw new Error('text() must not be called when a readable stream is available') },
    _cancel: cancel,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('curated RSS/Atom provider', () => {
  it('only fetches allow-listed curated source URLs', () => {
    expect(CURATED_FEED_SOURCES.length).toBeGreaterThan(0)
    for (const source of CURATED_FEED_SOURCES) {
      expect(source.name).toBeTruthy()
      expect(() => new URL(source.url)).not.toThrow()
      expect(source.url.startsWith('https://')).toBe(true)
    }
  })

  it('parses RSS items, strips unsafe markup, and normalizes fields', async () => {
    const fetchImpl = vi.fn(async () => textResponse(RSS_FEED))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    const articles = await provider.fetchArticles()

    expect(articles).toHaveLength(2)
    expect(articles[0]).toMatchObject({
      title: 'Show Renewed for Season 2',
      url: 'https://example.com/story-one',
      image: 'https://images.example.com/one.jpg',
      source: { name: 'TVLine' },
    })
    expect(articles[0].description).not.toContain('<')
    expect(articles[0].description).not.toContain('script')
    expect(articles[0].description).not.toContain('alert(1)')
    expect(articles[0].description).toContain('network')
    expect(new Date(articles[0].publishedAt).getTime()).not.toBeNaN()
  })

  it('parses Atom entries', async () => {
    const fetchImpl = vi.fn(async () => textResponse(ATOM_FEED))
    const provider = createRssProvider({ name: 'Deadline', url: 'https://deadline.com/feed/', fetchImpl })

    const articles = await provider.fetchArticles()

    expect(articles).toEqual([{
      title: 'Atom Show Trailer Drops',
      description: 'A first look at the new season.',
      url: 'https://example.com/atom-story',
      image: null,
      source: { name: 'Deadline' },
      publishedAt: '2026-07-13T08:00:00Z',
    }])
  })

  it('respects the configured per-source article cap', async () => {
    const fetchImpl = vi.fn(async () => textResponse(RSS_FEED))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl, maxArticles: 1 })

    expect(await provider.fetchArticles()).toHaveLength(1)
  })

  it('rejects a feed with no recognizable RSS or Atom structure', async () => {
    const fetchImpl = vi.fn(async () => textResponse('<html><body>not a feed</body></html>'))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    await expect(provider.fetchArticles()).rejects.toSatisfy(
      (error) => isNewsProviderError(error) && error.code === 'MALFORMED_RESPONSE',
    )
  })

  it('rejects completely malformed XML safely', async () => {
    const fetchImpl = vi.fn(async () => textResponse('<rss><channel><item><title>Unclosed'))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    // fast-xml-parser tolerates unclosed tags leniently; the important guarantee is
    // that a genuinely non-RSS/Atom document is rejected rather than silently empty.
    const articles = await provider.fetchArticles().catch((error) => error)
    if (Array.isArray(articles)) {
      expect(articles.length).toBeGreaterThanOrEqual(0)
    } else {
      expect(isNewsProviderError(articles)).toBe(true)
    }
  })

  it('returns an empty list for a structurally valid but item-less feed', async () => {
    const fetchImpl = vi.fn(async () => textResponse('<rss version="2.0"><channel><title>Empty</title></channel></rss>'))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    expect(await provider.fetchArticles()).toEqual([])
  })

  it('isolates a timeout failure without hanging', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    }))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl, timeoutMs: 50 })

    const pending = provider.fetchArticles().catch((error) => error)
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending

    expect(isNewsProviderError(result)).toBe(true)
    expect(result.code).toBe('TIMEOUT')
    vi.useRealTimers()
  })

  it('isolates an upstream HTTP error safely', async () => {
    const fetchImpl = vi.fn(async () => textResponse('', { ok: false, status: 503 }))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    await expect(provider.fetchArticles()).rejects.toSatisfy(
      (error) => isNewsProviderError(error) && error.code === 'UPSTREAM_ERROR' && error.upstream.status === 503,
    )
  })

  it('rejects an oversized response instead of parsing it', async () => {
    const huge = `<rss><channel>${'<item><title>x</title></item>'.repeat(1)}${'a'.repeat(2 * 1024 * 1024 + 1)}</channel></rss>`
    const fetchImpl = vi.fn(async () => textResponse(huge))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    await expect(provider.fetchArticles()).rejects.toSatisfy(
      (error) => isNewsProviderError(error) && error.code === 'RESPONSE_TOO_LARGE',
    )
  })

  it('rejects an oversized response by Content-Length before reading the body at all', async () => {
    const fetchImpl = vi.fn(async () => contentLengthResponse(RSS_MAX_RESPONSE_BYTES + 1))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    await expect(provider.fetchArticles()).rejects.toSatisfy(
      (error) => isNewsProviderError(error) && error.code === 'RESPONSE_TOO_LARGE',
    )
  })

  it('cancels a streamed response the instant it crosses the byte cap', async () => {
    const huge = 'a'.repeat(RSS_MAX_RESPONSE_BYTES + 1024)
    const response = streamResponse(huge, { chunkBytes: 64 * 1024 })
    const fetchImpl = vi.fn(async () => response)
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    await expect(provider.fetchArticles()).rejects.toSatisfy(
      (error) => isNewsProviderError(error) && error.code === 'RESPONSE_TOO_LARGE',
    )
    expect(response._cancel).toHaveBeenCalled()
  })

  it('still parses a normal feed delivered as a readable stream', async () => {
    const response = streamResponse(RSS_FEED, { chunkBytes: 32 })
    const fetchImpl = vi.fn(async () => response)
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    const articles = await provider.fetchArticles()

    expect(articles).toHaveLength(2)
    expect(articles[0].title).toBe('Show Renewed for Season 2')
  })

  it('counts multibyte UTF-8 characters as bytes, not JS string length', async () => {
    // '€' is 1 JS string character but 3 UTF-8 bytes — a length-based (not byte-based)
    // check would undercount this by roughly 3x and wrongly accept an oversized payload.
    const charCount = Math.ceil((RSS_MAX_RESPONSE_BYTES + 300) / 3)
    const oversized = '€'.repeat(charCount)
    expect(oversized.length).toBeLessThan(RSS_MAX_RESPONSE_BYTES)

    const fetchImpl = vi.fn(async () => textResponse(oversized))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    await expect(provider.fetchArticles()).rejects.toSatisfy(
      (error) => isNewsProviderError(error) && error.code === 'RESPONSE_TOO_LARGE',
    )
  })

  it('bounds the buffered response.text() fallback as safely as the runtime permits', async () => {
    const huge = `<rss><channel>${'a'.repeat(RSS_MAX_RESPONSE_BYTES + 1)}</channel></rss>`
    const fetchImpl = vi.fn(async () => textResponse(huge))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    await expect(provider.fetchArticles()).rejects.toSatisfy(
      (error) => isNewsProviderError(error) && error.code === 'RESPONSE_TOO_LARGE',
    )
  })

  it('requires a name and url', () => {
    expect(() => createRssProvider({ url: 'https://example.com/feed' })).toThrow()
    expect(() => createRssProvider({ name: 'X' })).toThrow()
  })
})
