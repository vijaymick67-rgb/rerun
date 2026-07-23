// @vitest-environment jsdom
//
// Above-the-fold artwork priority for the Discover feeds. Only the first
// announcement card and the first trailer card are above the fold, and only
// while the feed is actually visible — when Discover is hidden behind active
// search results, nothing is marked priority so a hidden subtree never races
// the visible route for bandwidth. Rendered through the presentational
// BrowseDiscoverView so visual order and the hidden gate are exercised directly.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BrowseDiscoverView } from './BrowseDiscover.jsx'

function announcement(id) {
  return {
    id: `ann:${id}`,
    showName: `Show ${id}`,
    articleHeadline: `Headline ${id}`,
    sourceName: 'Deadline',
    sourceUrl: 'https://example.com/a',
    publishedAt: '2026-07-23T08:00:00.000Z',
    posterPath: `/ann-${id}.jpg`,
  }
}

function trailer(id) {
  return {
    videoKey: `key-${id}`,
    title: `Trailer ${id}`,
    videoName: 'Official Trailer',
    youtubeUrl: 'https://www.youtube.com/watch?v=x',
    publishedAt: '2026-07-22T08:00:00.000Z',
    posterPath: `/tr-${id}.jpg`,
  }
}

function feed(items) {
  return { items, loading: false, refreshing: false, error: null, lastSuccess: Date.now() }
}

function state() {
  return {
    announcements: feed([announcement(1), announcement(2)]),
    trailers: feed([trailer(1), trailer(2)]),
  }
}

function imgFor(html, path) {
  const match = html.match(new RegExp(`<img\\b[^>]*w342${path.replace('/', '\\/')}[^>]*>`))
  return match ? match[0] : null
}

function render(hidden) {
  return renderToStaticMarkup(<BrowseDiscoverView state={state()} hidden={hidden} />)
}

describe('Discover feed above-the-fold artwork priority', () => {
  it('marks only the first announcement and first trailer eager/high-priority when visible', () => {
    const html = render(false)

    for (const path of ['/ann-1.jpg', '/tr-1.jpg']) {
      const img = imgFor(html, path)
      expect(img).not.toBeNull()
      expect(img).toContain('loading="eager"')
      expect(img).toMatch(/fetchpriority="high"/i)
    }
  })

  it('leaves every later card lazy and non-priority', () => {
    const html = render(false)

    for (const path of ['/ann-2.jpg', '/tr-2.jpg']) {
      const img = imgFor(html, path)
      expect(img).not.toBeNull()
      expect(img).toContain('loading="lazy"')
      expect(img).not.toMatch(/fetchpriority/i)
    }
  })

  it('marks no artwork high-priority while the feed is hidden behind search results', () => {
    const html = render(true)
    expect(html).not.toMatch(/fetchpriority/i)
    for (const path of ['/ann-1.jpg', '/tr-1.jpg']) {
      expect(imgFor(html, path)).toContain('loading="lazy"')
    }
  })
})
