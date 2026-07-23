// @vitest-environment jsdom
//
// Above-the-fold poster priority ownership for the Watching list — the opening
// tab on cold launch. Priority is owned by the route (it knows visual order and
// its own on-screen/active state), never guessed inside ProgressiveImage.
//
// Rendered through the real Watching route with a seeded cache: renderToStaticMarkup
// runs the lazy useState initializers (which hydrate from loadWatchingCache) but
// never the load effect, so the rows are exactly the cached library with no
// network — the real sortWatchingShows/isVisibleInWatching still run unmodified.
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { saveWatchingCache } from '../lib/watchingCache'
import Watching from './Watching'

// nextUp rows are left untouched by advanceCachedWatchingRows (only 'countdown'
// rows advance) and are always visible in isVisibleInWatching, so they render
// deterministically from the cache. Distinct air_dates pin the sorted order
// (nextUp sorts by air_date ascending).
function nextUpShow(id, letter, airDate) {
  return {
    id,
    tmdb_id: id,
    name: `Show ${letter}`,
    poster_path: `/${letter}.jpg`,
    added_at: '2026-01-01T00:00:00Z',
    finished_at: null,
    hidden_at: null,
    status: {
      type: 'nextUp',
      season_number: 1,
      episode_number: 2,
      air_date: airDate,
    },
  }
}

function imgFor(html, letter) {
  const match = html.match(new RegExp(`<img\\b[^>]*w342/${letter}\\.jpg[^>]*>`))
  return match ? match[0] : null
}

function render(active) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Watching active={active} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  saveWatchingCache([
    nextUpShow(1, 'a', '2020-01-01'),
    nextUpShow(2, 'b', '2020-01-02'),
    nextUpShow(3, 'c', '2020-01-03'),
  ])
})

describe('Watching above-the-fold poster priority', () => {
  it('marks only the first two visible rows eager/high-priority while the list is active', () => {
    const html = render(true)

    for (const letter of ['a', 'b']) {
      const img = imgFor(html, letter)
      expect(img).not.toBeNull()
      expect(img).toContain('loading="eager"')
      expect(img).toMatch(/fetchpriority="high"/i)
    }
  })

  it('keeps the third and later rows lazy and non-priority', () => {
    const html = render(true)
    const img = imgFor(html, 'c')
    expect(img).not.toBeNull()
    expect(img).toContain('loading="lazy"')
    expect(img).not.toMatch(/fetchpriority/i)
  })

  it('marks no poster high-priority when the list is hidden (another tab or detail overlay active)', () => {
    const html = render(false)
    expect(html).not.toMatch(/fetchpriority/i)
    for (const letter of ['a', 'b', 'c']) {
      expect(imgFor(html, letter)).toContain('loading="lazy"')
    }
  })
})
