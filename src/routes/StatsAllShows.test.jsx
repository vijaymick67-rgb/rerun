// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StatsAllShows from './StatsAllShows'

function show(tmdbId, name, extra = {}) {
  return { tmdb_id: tmdbId, name, poster_path: null, finished_at: null, hidden_at: null, ...extra }
}

let container = null
let root = null

async function flush() {
  await act(async () => { await Promise.resolve() })
}

function baseProps(overrides = {}) {
  return {
    loading: false,
    error: null,
    shows: [show(1, 'Alpha'), show(2, 'Beta')],
    busyIds: new Set(),
    openActionId: null,
    actionError: null,
    actionSuccess: null,
    confirmingShow: null,
    onOpenActions: vi.fn(),
    onCloseActions: vi.fn(),
    onRestore: vi.fn(),
    onRequestRemove: vi.fn(),
    onConfirmRemove: vi.fn(),
    onCancelRemove: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  }
}

async function mount(props, initialEntries = ['/stats/all']) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/stats" element={<div data-testid="main-page">Main Insights</div>} />
          <Route path="/stats/all" element={<StatsAllShows {...props} />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flush()
}

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
})

describe('StatsAllShows — expanded page header', () => {
  it('shows only a back chevron + "All Shows", no count anywhere', async () => {
    await mount(baseProps())
    const heading = container.querySelector('h1')
    expect(heading.textContent).toBe('All Shows')
    expect(container.querySelector('.nested-header__back')).not.toBeNull()
    expect(container.querySelector('.nested-header__back').getAttribute('aria-label')).toBe('Back to Insights')
    expect(container.textContent).not.toContain('2 shows')
    expect(container.textContent).not.toMatch(/All Shows\s*\(\d+\)/)
    expect(heading.textContent).not.toContain('(')
  })

  it('is a real h1 heading', async () => {
    await mount(baseProps())
    expect(container.querySelectorAll('h1')).toHaveLength(1)
  })

  it('back link points at /stats and returns there on click', async () => {
    await mount(baseProps())
    const back = container.querySelector('.nested-header__back')
    expect(back.getAttribute('href')).toBe('/stats')
    await act(async () => {
      back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(container.querySelector('[data-testid="main-page"]')).not.toBeNull()
  })
})

describe('StatsAllShows — grid', () => {
  it('renders every represented show, in the given order, at exactly 3 columns on mobile', async () => {
    await mount(baseProps({ shows: [show(1, 'Alpha'), show(2, 'Beta'), show(3, 'Gamma')] }))
    const grid = container.querySelector('.grid.grid-cols-3')
    expect(grid).not.toBeNull()
    const titles = [...grid.querySelectorAll('.type-show-title')].map((el) => el.textContent)
    expect(titles).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('each show card links to its detail route', async () => {
    await mount(baseProps())
    const links = [...container.querySelectorAll('a[href^="/watching/"]')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/watching/1', '/watching/2'])
  })

  it('shows a bounded skeleton grid while loading with no cached data yet — never a blank screen', async () => {
    await mount(baseProps({ loading: true, shows: [] }))
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(container.querySelectorAll('.skeleton-block').length).toBeGreaterThan(0)
    expect(container.querySelector('h1').textContent).toBe('All Shows')
  })

  it('paints the real grid immediately when data is already loaded, even mid stale-while-revalidate refresh', async () => {
    await mount(baseProps({ loading: true, shows: [show(1, 'Alpha')] }))
    expect(container.querySelectorAll('.skeleton-block').length).toBe(0)
    expect(container.textContent).toContain('Alpha')
  })
})

describe('StatsAllShows — actions', () => {
  it('the three-dot control opens the action sheet for that show', async () => {
    const onOpenActions = vi.fn()
    await mount(baseProps({ onOpenActions }))
    const actionButton = container.querySelector('[aria-label="Actions for Alpha"]')
    expect(actionButton).not.toBeNull()
    await act(async () => { actionButton.click() })
    expect(onOpenActions).toHaveBeenCalledWith(1)
  })

  it('renders the action sheet for the open show with restore/remove wired to the parent handlers', async () => {
    const onRestore = vi.fn()
    const onRequestRemove = vi.fn()
    await mount(baseProps({
      openActionId: 2,
      shows: [show(1, 'Alpha'), show(2, 'Beta', { finished_at: '2026-01-01T00:00:00Z' })],
      onRestore,
      onRequestRemove,
    }))
    expect(container.querySelector('#stats-actions-sheet')).not.toBeNull()
    expect(container.textContent).toContain('Actions for Beta')

    const restoreButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Restore to Watching')
    await act(async () => { restoreButton.click() })
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ tmdb_id: 2 }))

    const removeButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove from Insights')
    await act(async () => { removeButton.click() })
    expect(onRequestRemove).toHaveBeenCalledWith(expect.objectContaining({ tmdb_id: 2 }))
  })

  it('renders the confirm dialog when a show is pending removal, wired to onConfirmRemove/onCancelRemove', async () => {
    const onConfirmRemove = vi.fn()
    const onCancelRemove = vi.fn()
    await mount(baseProps({ confirmingShow: show(1, 'Alpha'), onConfirmRemove, onCancelRemove }))
    expect(container.textContent).toContain('Remove Alpha from Rerun?')

    const cancelButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')
    await act(async () => { cancelButton.click() })
    expect(onCancelRemove).toHaveBeenCalledOnce()

    const confirmButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove from Insights')
    await act(async () => { confirmButton.click() })
    expect(onConfirmRemove).toHaveBeenCalledOnce()
  })

  it('surfaces actionError/actionSuccess banners', async () => {
    await mount(baseProps({ actionSuccess: 'Alpha is active in Watching again.' }))
    expect(container.querySelector('[role="status"].status-banner--success')).not.toBeNull()
    expect(container.textContent).toContain('Alpha is active in Watching again.')
  })
})

describe('StatsAllShows — empty result handling', () => {
  it('redirects back to /stats instead of leaving a stale, empty /stats/all screen', async () => {
    await mount(baseProps({ shows: [] }))
    expect(container.querySelector('[data-testid="main-page"]')).not.toBeNull()
    expect(container.textContent).not.toContain('All Shows')
  })

  it('does not redirect while a cold direct load is still in flight', async () => {
    await mount(baseProps({ shows: [], loading: true }))
    expect(container.querySelector('h1')?.textContent).toBe('All Shows')
  })

  it('shows the error banner (not a redirect) when a cold load fails with no data', async () => {
    await mount(baseProps({ shows: [], loading: false, error: { message: 'Failed to load your stats.', code: 'DATA-SUPABASE' } }))
    expect(container.querySelector('h1')?.textContent).toBe('All Shows')
    expect(container.textContent).toContain('Failed to load your stats.')
    expect(container.querySelector('button')?.textContent).toBe('Retry')
  })
})
