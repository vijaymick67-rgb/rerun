import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import WatchingRow from './WatchingRow'

describe('WatchingRow image adoption', () => {
  it('preserves navigation, remove actions, and meaningful poster alt text', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WatchingRow
          show={{
            id: 7,
            tmdb_id: 7,
            name: 'Lucky',
            poster_path: '/lucky.jpg',
            status: { type: 'nextUp', season_number: 1, episode_number: 2 },
          }}
          isRemoving={false}
          isOpen={false}
          onOpenChange={vi.fn()}
          onRemove={vi.fn()}
        />
      </MemoryRouter>,
    )

    expect(html).toContain('href="/watching/7"')
    expect(html).toContain('alt="Lucky"')
    expect(html).toContain('aria-label="Remove Lucky"')
    expect(html).toContain('watching-row')
    expect(html).toContain('Up next: S1E2')
  })

  function renderRow(extraProps = {}) {
    return renderToStaticMarkup(
      <MemoryRouter>
        <WatchingRow
          show={{
            id: 7,
            tmdb_id: 7,
            name: 'Lucky',
            poster_path: '/lucky.jpg',
            status: { type: 'nextUp', season_number: 1, episode_number: 2 },
          }}
          isRemoving={false}
          isOpen={false}
          onOpenChange={vi.fn()}
          onRemove={vi.fn()}
          {...extraProps}
        />
      </MemoryRouter>,
    )
  }

  it('defaults the poster to lazy, non-priority loading', () => {
    const html = renderRow()
    expect(html).toContain('loading="lazy"')
    expect(html).not.toMatch(/fetchpriority/i)
  })

  it('marks the poster eager and high-priority only when priority is set', () => {
    const html = renderRow({ priority: true })
    expect(html).toContain('loading="eager"')
    expect(html).toMatch(/fetchpriority="high"/i)
  })
})
