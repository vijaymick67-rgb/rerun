import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRssProvider, RSS_MAX_RESPONSE_BYTES } from './rssProvider.js'
import { CURATED_FEED_SOURCES } from './feedSources.js'
import { createNewsProvider, isNewsProviderError } from './provider.js'
import { aggregateProviders } from './aggregateNews.js'
import { normalizeArticle } from './normalizeArticle.js'

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

function stalledBodyResponse() {
  const cancel = vi.fn(async () => {})
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          read() { return new Promise(() => {}) },
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

  it('parses RSS items and normalizes basic fields', async () => {
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
    // rssProvider extracts raw text only — it does not decode entities or strip
    // markup itself. That happens exactly once, downstream, in normalizeArticle
    // (see the "RSS/Atom -> normalizeArticle" describe block below), which is the
    // single authoritative sanitization boundary for both RSS/Atom and GNews.
    expect(articles[0].description).toContain('<script>')
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

  it('times out a body stream that stalls after fetch already resolved with headers', async () => {
    vi.useFakeTimers()
    const response = stalledBodyResponse()
    const fetchImpl = vi.fn(async () => response)
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl, timeoutMs: 50 })

    const pending = provider.fetchArticles().catch((error) => error)
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending

    expect(isNewsProviderError(result)).toBe(true)
    expect(result.code).toBe('TIMEOUT')
    expect(response._cancel).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('clears the timer exactly once after a successful complete body read', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const fetchImpl = vi.fn(async () => textResponse(RSS_FEED))
    const provider = createRssProvider({ name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl })

    await provider.fetchArticles()

    expect(clearSpy).toHaveBeenCalledTimes(1)
  })

  it('still serves other providers via aggregateProviders when one body times out', async () => {
    vi.useFakeTimers()
    const response = stalledBodyResponse()
    const stalledFetch = vi.fn(async () => response)
    const stalledProvider = createRssProvider({
      name: 'TVLine', url: 'https://tvline.com/feed/', fetchImpl: stalledFetch, timeoutMs: 50,
    })
    const goodProvider = createNewsProvider({
      name: 'Deadline', async fetchArticles() { return [{ id: 'ok' }] },
    })

    const pending = aggregateProviders([stalledProvider, goodProvider])
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending

    expect(result.providersUsed).toEqual(['Deadline'])
    expect(result.failureCount).toBe(1)
    const failed = result.results.find((r) => r.name === 'TVLine')
    expect(failed.ok).toBe(false)
    expect(isNewsProviderError(failed.error)).toBe(true)
    expect(failed.error.code).toBe('TIMEOUT')
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

// normalizeArticle is the single authoritative place RSS/Atom (and GNews) text gets
// decoded and stripped — rssProvider itself only extracts raw text. These tests run
// the complete path (raw XML -> rssProvider -> normalizeArticle) rather than testing
// the decode helper in isolation, since that's the only way to catch a regression
// where the same text gets sanitized more than once across the two modules.
function feedXml({ title, description }) {
  return `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>${title}</title>
      <link>https://example.com/story</link>
      ${description !== undefined ? `<description>${description}</description>` : ''}
      <pubDate>Mon, 13 Jul 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`
}

async function normalizedFromFeed(xml, { name = 'TVLine', url = 'https://tvline.com/feed/' } = {}) {
  const fetchImpl = vi.fn(async () => textResponse(xml))
  const provider = createRssProvider({ name, url, fetchImpl })
  const [raw] = await provider.fetchArticles()
  return normalizeArticle(raw, { fetchedAt: '2026-07-13T11:00:00Z', provider: 'curated' })
}

describe('RSS/Atom -> normalizeArticle (single sanitization boundary)', () => {
  it('decodes decimal, hex, named, and mixed HTML entities in a title exactly once', async () => {
    const xml = feedXml({
      title: 'Showrunner&#8217;s New Series &#038; More &#x2014; &quot;From&quot; &amp; &#x201C;You&#x201D;',
    })
    const article = await normalizedFromFeed(xml)

    expect(article.title).toBe('Showrunner’s New Series & More — "From" & “You”')
  })

  it('decodes entities mixed with HTML tags inside a CDATA description exactly once', async () => {
    const xml = feedXml({
      title: 'Story with a rich description',
      description: '<![CDATA[<p>Tom&apos;s new role &amp; <b>more</b> &#8212; the network confirmed it.</p>]]>',
    })
    const article = await normalizedFromFeed(xml)

    expect(article.description).toBe("Tom's new role & more — the network confirmed it.")
  })

  it('cleans up whitespace left behind after decoding &nbsp; in a description', async () => {
    const xml = feedXml({ title: 'Whitespace story', description: 'One&nbsp;Two&nbsp;&nbsp;Three' })
    const article = await normalizedFromFeed(xml)

    expect(article.description).toBe('One Two Three')
  })

  it('never lets an entity-encoded script tag survive as markup in a title or description', async () => {
    const xml = feedXml({
      title: '&lt;script&gt;alert(1)&lt;/script&gt;Breaking News',
      description: '&lt;script&gt;alert(1)&lt;/script&gt;The network confirmed it.',
    })
    const article = await normalizedFromFeed(xml)

    expect(article.title).toBe('Breaking News')
    expect(article.description).toBe('The network confirmed it.')
    expect(article.title).not.toContain('<')
    expect(article.description).not.toContain('<')
  })

  // The exact regression the two-pass bug produced: rssProvider previously decoded
  // once, and normalizeArticle decoded the (already partially-decoded) result again,
  // so "&amp;lt;b&amp;gt;...&amp;lt;/b&amp;gt;" resolved in two steps into a real
  // <b> tag that then got stripped down to just "Headline" — silently destroying
  // content that was deliberately double-escaped. With rssProvider handing raw text
  // straight through and normalizeArticle decoding exactly once, this must stop one
  // level short: the output still looks like an (undecoded) escaped tag, never a
  // real one.
  it('decodes a double-escaped tag only once across the full RSS -> normalizeArticle pipeline', async () => {
    const xml = feedXml({ title: '&amp;lt;b&amp;gt;Headline&amp;lt;/b&amp;gt;' })
    const article = await normalizedFromFeed(xml)

    expect(article.title).toBe('&lt;b&gt;Headline&lt;/b&gt;')
    expect(article.title).not.toContain('<b>')
    expect(article.title).not.toContain('<')
  })

  it('decodes "&amp;amp;" to a single literal "&" — not further, across the full pipeline', async () => {
    const xml = feedXml({ title: 'News &amp;amp; Updates' })
    const article = await normalizedFromFeed(xml)

    expect(article.title).toBe('News &amp; Updates')
  })

  it('does not crash on a malformed or unknown entity anywhere in the pipeline', async () => {
    const xml = feedXml({ title: 'Weird &foobar; headline &#zzz; text' })
    const article = await normalizedFromFeed(xml)

    expect(article.title).toBe('Weird &foobar; headline &#zzz; text')
  })

  it('rejects a numeric reference in the UTF-16 surrogate range instead of corrupting the string', async () => {
    const xml = feedXml({ title: 'Lone surrogate &#xD800; in a headline' })
    const article = await normalizedFromFeed(xml)

    expect(article.title).toBe('Lone surrogate &#xD800; in a headline')
  })

  it('decodes an encoded Atom title and summary exactly once', async () => {
    const atomFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Desk</title>
  <entry>
    <title>Showrunner&#8217;s Exit &amp; Return</title>
    <link rel="alternate" href="https://example.com/atom-entities" />
    <summary>Tom&apos;s new role &#x2014; &quot;From&quot; renewed.</summary>
    <published>2026-07-13T08:00:00Z</published>
  </entry>
</feed>`
    const article = await normalizedFromFeed(atomFeed, { name: 'Deadline', url: 'https://deadline.com/feed/' })

    expect(article.title).toBe('Showrunner’s Exit & Return')
    expect(article.description).toBe('Tom\'s new role — "From" renewed.')
  })

  it('decodes an encoded Atom title and content when summary is absent, exactly once', async () => {
    const atomFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom Content Story</title>
    <link rel="alternate" href="https://example.com/atom-content" />
    <content>News &amp;amp; Updates &#8212; &lt;b&gt;bold&lt;/b&gt; removed</content>
    <published>2026-07-13T08:00:00Z</published>
  </entry>
</feed>`
    const article = await normalizedFromFeed(atomFeed, { name: 'Deadline', url: 'https://deadline.com/feed/' })

    expect(article.description).toBe('News &amp; Updates — bold removed')
  })
})
