// @vitest-environment jsdom
//
// Above-the-fold poster priority for the Browse search results grid. The grid
// is two columns, so only its first row — the first two posters — is above the
// fold; every later result stays lazy. Driven through the real Browse route: a
// query is typed, the debounce fires, and the rendered grid is inspected.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const RESULTS = [
  { id: 1, name: 'Result 1', poster_path: '/r1.jpg', first_air_date: '2020-01-01' },
  { id: 2, name: 'Result 2', poster_path: '/r2.jpg', first_air_date: '2020-01-01' },
  { id: 3, name: 'Result 3', poster_path: '/r3.jpg', first_air_date: '2020-01-01' },
  { id: 4, name: 'Result 4', poster_path: '/r4.jpg', first_air_date: '2020-01-01' },
]

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }),
  },
}))

vi.mock('../lib/tmdb', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, searchShows: vi.fn(async () => RESULTS) }
})

// Discover is irrelevant to the search grid and would otherwise run its own
// network refresh; stub it out so this test exercises only the results grid.
vi.mock('../components/BrowseDiscover', () => ({ default: () => null }))

import Browse from './Browse'

let container = null
let root = null

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
  vi.clearAllMocks()
})

function imgFor(html, path) {
  const match = html.match(new RegExp(`<img\\b[^>]*w342${path.replace('/', '\\/')}[^>]*>`))
  return match ? match[0] : null
}

async function searchAndRender() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Browse />
      </MemoryRouter>,
    )
  })

  const input = container.querySelector('.browse-search')
  // React tracks the controlled value through the prototype setter, so a plain
  // `input.value = …` is ignored — drive it through the native setter so the
  // onChange handler sees the new query.
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setValue.call(input, 'query')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    vi.advanceTimersByTime(500)
  })
  await flush()
  return container.innerHTML
}

describe('Browse search results poster priority', () => {
  it('marks only the first row (first two posters) eager/high-priority', async () => {
    const html = await searchAndRender()

    for (const path of ['/r1.jpg', '/r2.jpg']) {
      const img = imgFor(html, path)
      expect(img).not.toBeNull()
      expect(img).toContain('loading="eager"')
      expect(img).toMatch(/fetchpriority="high"/i)
    }
  })

  it('keeps every later result lazy and non-priority', async () => {
    const html = await searchAndRender()

    for (const path of ['/r3.jpg', '/r4.jpg']) {
      const img = imgFor(html, path)
      expect(img).not.toBeNull()
      expect(img).toContain('loading="lazy"')
      expect(img).not.toMatch(/fetchpriority/i)
    }
  })
})
