// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WatchingRow from './WatchingRow'

function baseShow(overrides = {}) {
  return {
    id: 1,
    tmdb_id: 100,
    name: 'The Sopranos',
    poster_path: null,
    status: { type: 'countdown', daysUntil: 5, air_date: '2026-07-22' },
    ...overrides,
  }
}

function staticHtml(show, props = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WatchingRow
        show={show}
        isRemoving={false}
        isOpen={false}
        onOpenChange={vi.fn()}
        onRemove={vi.fn()}
        onQuickMark={vi.fn()}
        isQuickMarking={false}
        {...props}
      />
    </MemoryRouter>,
  )
}

describe('WatchingRow — chevron permanently removed', () => {
  it('never renders the › chevron, in any status', () => {
    for (const status of [
      { type: 'nextUp', season_number: 2, episode_number: 5, name: 'Ep' },
      { type: 'countdown', daysUntil: 3, air_date: '2026-07-22' },
      { type: 'caughtUp' },
      { type: 'completed' },
    ]) {
      const html = staticHtml(baseShow({ status }))
      expect(html).not.toContain('›')
      expect(html).not.toContain('watching-row-chevron')
    }
  })
})

describe('WatchingRow — released-only progress bar visibility', () => {
  it('shows the bar for a backlog show (released watched < released total)', () => {
    const html = staticHtml(baseShow({
      status: { type: 'nextUp', season_number: 2, episode_number: 5, name: 'Ep 5' },
      releasedEpisodeCount: 20,
      releasedWatchedCount: 10,
      releasedProgress: 50,
      nextReleasedUnwatchedEpisode: { season_number: 2, episode_number: 5, name: 'Ep 5', runtime: 42 },
    }))
    expect(html).toContain('progress-track')
    expect(html).toContain('width:50%')
  })

  it('hides the bar for a caught-up show even if it has future episodes', () => {
    const html = staticHtml(baseShow({
      status: { type: 'countdown', daysUntil: 10, air_date: '2026-08-01' },
      releasedEpisodeCount: 20,
      releasedWatchedCount: 20,
      releasedProgress: 100,
      nextReleasedUnwatchedEpisode: null,
    }))
    expect(html).not.toContain('progress-track')
  })

  it('hides the bar when nothing has released yet', () => {
    const html = staticHtml(baseShow({
      status: { type: 'countdown', daysUntil: 30, air_date: '2026-08-20' },
      releasedEpisodeCount: 0,
      releasedWatchedCount: 0,
      releasedProgress: 0,
      nextReleasedUnwatchedEpisode: null,
    }))
    expect(html).not.toContain('progress-track')
  })

  it('never renders numeric x/y watched text in the row', () => {
    const html = staticHtml(baseShow({
      status: { type: 'nextUp', season_number: 1, episode_number: 2, name: 'Two' },
      releasedEpisodeCount: 23,
      releasedWatchedCount: 22,
      releasedProgress: (22 / 23) * 100,
      nextReleasedUnwatchedEpisode: { season_number: 1, episode_number: 2, name: 'Two', runtime: 40 },
    }))
    expect(html).not.toContain('22/23')
    expect(html).not.toContain('episodes watched')
  })
})

describe('WatchingRow — quick mark control', () => {
  it('renders with an accessible label naming the exact next episode', () => {
    const html = staticHtml(baseShow({
      status: { type: 'nextUp', season_number: 2, episode_number: 5, name: 'Ep 5' },
      nextReleasedUnwatchedEpisode: { season_number: 2, episode_number: 5, name: 'Ep 5', runtime: 42 },
    }))
    expect(html).toContain('aria-label="Mark S2E5 of The Sopranos watched"')
  })

  it('is entirely absent when there is no released unwatched episode (no placeholder)', () => {
    const html = staticHtml(baseShow({
      status: { type: 'caughtUp' },
      nextReleasedUnwatchedEpisode: null,
    }))
    expect(html).not.toContain('watching-quick-mark')
  })

  it('does not render for a countdown-only (unreleased) show', () => {
    const html = staticHtml(baseShow({
      status: { type: 'countdown', daysUntil: 4, air_date: '2026-07-24' },
      nextReleasedUnwatchedEpisode: null,
    }))
    expect(html).not.toContain('watching-quick-mark')
  })
})

describe('WatchingRow — quick mark interaction (mounted DOM)', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let container = null
  let root = null

  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    container?.remove()
    container = null
    root = null
  })

  async function mount(show, props = {}) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const onQuickMark = props.onQuickMark ?? vi.fn()
    const onOpenChange = props.onOpenChange ?? vi.fn()
    await act(async () => {
      root.render(
        <MemoryRouter>
          <WatchingRow
            show={show}
            isRemoving={false}
            isOpen={false}
            onOpenChange={onOpenChange}
            onRemove={vi.fn()}
            onQuickMark={onQuickMark}
            isQuickMarking={props.isQuickMarking ?? false}
          />
        </MemoryRouter>,
      )
    })
    return { onQuickMark, onOpenChange }
  }

  const nextUpShow = baseShow({
    status: { type: 'nextUp', season_number: 2, episode_number: 5, name: 'Ep 5' },
    nextReleasedUnwatchedEpisode: { season_number: 2, episode_number: 5, name: 'Ep 5', runtime: 42 },
  })

  it('a tap marks exactly the current row and does not navigate', async () => {
    const { onQuickMark } = await mount(nextUpShow)
    const button = container.querySelector('.watching-quick-mark')
    expect(button.closest('a')).toBeNull() // sibling of the nav Link, never inside it
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onQuickMark).toHaveBeenCalledTimes(1)
    expect(onQuickMark).toHaveBeenCalledWith(nextUpShow)
    expect(window.location.pathname).not.toContain('/watching/100')
  })

  it('the row body link is unaffected and still points at Show Detail', async () => {
    await mount(nextUpShow)
    const link = container.querySelector('a')
    expect(link.getAttribute('href')).toBe('/watching/100')
  })

  it('disables the control while pending, with no spinner and the same stable chip', async () => {
    const { onQuickMark } = await mount(nextUpShow, { isQuickMarking: true })
    const button = container.querySelector('.watching-quick-mark')
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('.watching-quick-mark__spinner')).toBeNull()
    const chip = container.querySelector('.watching-quick-mark__chip')
    expect(chip).not.toBeNull()
    // Same check glyph as idle — no icon morph, no swap to a loading treatment.
    expect(chip.querySelector('svg path[d="m5 12 4 4L19 6"]')).not.toBeNull()
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('does not imply the newly advanced episode is already being marked while pending', async () => {
    await mount(nextUpShow, { isQuickMarking: true })
    const button = container.querySelector('.watching-quick-mark')
    // The pending label must stay neutral rather than naming
    // nextReleasedUnwatchedEpisode, since that field may already reflect the
    // episode AFTER the one whose mutation is actually in flight.
    expect(button.getAttribute('aria-label')).toBe('Updating watched status for The Sopranos')
    expect(button.getAttribute('aria-label')).not.toContain('Mark S')
  })

  it('idle and pending markup use the identical chip class (no layout shift)', () => {
    const idleHtml = staticHtml(nextUpShow, { isQuickMarking: false })
    const pendingHtml = staticHtml(nextUpShow, { isQuickMarking: true })
    const chipClass = /class="(watching-quick-mark__chip)"/.exec(idleHtml)?.[1]
    expect(chipClass).toBe('watching-quick-mark__chip')
    expect(pendingHtml).toContain('class="watching-quick-mark__chip"')
  })

  it('desktop hover-remove and quick mark are independent, non-overlapping controls', async () => {
    await mount(nextUpShow)
    const remove = container.querySelector('.watching-row-hover-remove')
    const quickMark = container.querySelector('.watching-quick-mark')
    expect(remove).not.toBeNull()
    expect(quickMark).not.toBeNull()
    expect(remove).not.toBe(quickMark)
    // Corner rail (top) vs. centered rail (middle) — distinct vertical bands.
    expect(remove.className).toContain('top-2')
    expect(quickMark.className).toContain('top-1/2')
  })
})
