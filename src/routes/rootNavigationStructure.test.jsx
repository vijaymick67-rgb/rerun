import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import TabBar from '../components/TabBar'

vi.mock('../components/ReloadPrompt', () => ({ default: () => null }))
vi.mock('../lib/AuthContext', () => ({
  useAuth: () => ({ session: { user: { email: 'owner@example.com' } }, signOut: vi.fn() }),
}))

import App from '../App.jsx'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

function renderApp(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}
// Settings is intentionally excluded here (Phase 3B): with the bottom bar
// now icon-only, /settings needs its own visible page heading rather than
// relying on a redundant nav label the bar no longer shows. Browse,
// Watching and Stats still identify themselves via their tab icon plus
// content, so their redundant root <h1> stays removed.
const rootPages = [
  ['./Browse.jsx', 'Browse'],
  ['./Watching.jsx', 'Watching'],
  ['./Stats.jsx', 'Stats'],
]

describe('root navigation polish', () => {
  it('renders the new labels at the existing destinations', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/browse']}>
        <TabBar />
      </MemoryRouter>,
    )

    expect(html).toContain('href="/browse"')
    expect(html).toMatch(/<a[^>]*(?:href="\/browse"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/browse")/)
    expect((html.match(/aria-current="page"/g) ?? [])).toHaveLength(1)
    // Labels are no longer rendered as visible text — the tab bar is
    // icon-only — but each destination keeps its accessible name.
    expect(html).toContain('aria-label="Discover"')
    expect(html).toContain('href="/watching"')
    expect(html).toContain('aria-label="Watching"')
    expect(html).toContain('href="/stats"')
    expect(html).toContain('aria-label="Insights"')
    expect(html).toContain('href="/settings"')
    expect(html).toContain('aria-label="Settings"')
    expect(html).not.toContain('>Discover<')
    expect(html).not.toContain('>Watching<')
    expect(html).not.toContain('>Insights<')
    expect(html).not.toContain('>Settings<')
  })

  it('keeps the Insights tab active while on the nested /stats/all route', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/stats/all']}>
        <TabBar />
      </MemoryRouter>,
    )

    expect((html.match(/aria-current="page"/g) ?? [])).toHaveLength(1)
    expect(html).toMatch(/<a[^>]*(?:href="\/stats"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/stats")/)
  })

  it.each(rootPages)('removes the redundant %s root heading', (path, heading) => {
    expect(source(path)).not.toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`))
  })

  it('gives /settings its own visible "Settings" page heading (Phase 3B), with no extra eyebrow line', () => {
    const settingsSource = source('./Settings.jsx')
    expect(settingsSource).toMatch(/<h1[^>]*>Settings<\/h1>/)
    // No invented eyebrow/kicker copy above the heading.
    for (const forbidden of ['Preferences', 'Control room', 'System', 'Personal setup']) {
      expect(settingsSource).not.toContain(forbidden)
    }
  })

  it('keeps detail headings unchanged', () => {
    expect(source('./ShowDetail.jsx')).toContain('<h1')
    expect(source('./SeasonDetail.jsx')).toContain('<h1')
  })

  it('resolves every route destination (rendered, not source-grepped)', () => {
    // The Watching list moved out of the top-level <Routes> into a persistent
    // sibling, so route wiring is verified by what each path actually renders
    // rather than by grepping App.jsx for `path="…"` literals.
    expect(renderApp('/browse')).toContain('placeholder="Find a show…"') // Browse search
    expect(renderApp('/stats')).toContain('route-content route-content--tab')
    expect(renderApp('/settings')).toContain('route-content route-content--tab')
    // Watching list route and its default `/` alias render the app-page list.
    expect(renderApp('/watching')).toContain('app-page')
    expect(renderApp('/')).toContain('app-page')
    // Nested detail depths still render their detail overlay.
    expect(renderApp('/watching/123')).toContain('nested-page')
    expect(renderApp('/watching/123/season/1')).toContain('nested-page')
    // Unknown paths still fall through to NotFound.
    expect(renderApp('/no-such-page')).toContain('Page not found')
    // The nested Stats child route renders directly (no NotFound) and stays
    // on the Insights tab layout even before any data has loaded.
    expect(renderApp('/stats/all')).toContain('All Shows')
    expect(renderApp('/stats/all')).toContain('route-content route-content--tab')
  })

  it('keeps the poster action accessible, visible, and behaviorally unchanged', () => {
    // The show-card poster + three-dot action control was extracted from
    // Stats.jsx into its own component so the main preview and the
    // /stats/all grid can share exactly one rendering path.
    const card = source('../components/StatsShowCard.jsx')
    const actionLabel = 'aria-label={`Actions for ${show.name}`}'
    const actionLabelIndex = card.indexOf(actionLabel)
    const actionStart = card.lastIndexOf('<button', actionLabelIndex)
    const actionEnd = card.indexOf('</button>', actionLabelIndex) + '</button>'.length
    const actionControl = card.slice(actionStart, actionEnd)

    expect(actionLabelIndex).toBeGreaterThan(-1)
    expect(actionStart).toBeGreaterThan(-1)
    expect(actionEnd).toBeGreaterThan('</button>'.length - 1)
    expect(actionControl).toContain('aria-expanded={actionsOpen}')
    expect(actionControl).toContain('aria-controls="stats-actions-sheet"')
    // Repositioned to the poster's upper-left, keeping the full 44x44 hit
    // target (h-11 w-11) even though the visible glyph is compact.
    expect(actionControl).toContain(
      'className="motion-press absolute left-0 top-0 z-10 flex h-11 w-11',
    )
    expect(actionControl).not.toContain('right-0.5 top-0.5')
    expect(actionControl).toContain('h-11 w-11')
    expect(actionControl).toContain('onOpenActions(show.tmdb_id)')
    expect(card).toContain('to={`/watching/${show.tmdb_id}`}')
    expect(actionControl).toContain('viewBox="0 0 14 4"')
    expect(actionControl).toContain('className="h-2 w-3.5"')
    // Three plain dots — no black stroke tile any more; contrast now comes
    // from the ivory fill + drop-shadow halo defined in CSS.
    expect((actionControl.match(/<circle/g) ?? []).length).toBe(3)
    expect(actionControl).not.toContain('fill="white"')
    expect(actionControl).not.toContain('stroke="rgba(0, 0, 0, 0.85)"')
    expect(actionControl).not.toMatch(/\bbg-/)
    expect(actionControl).not.toContain('h-7 w-7')
    expect(actionControl).not.toContain('h-1 w-3.5')
    expect(actionControl).not.toContain('h-9 w-9')

    // The toggle call itself now lives one level up, in Stats.jsx, shared by
    // both the card's onOpenActions callback and the action sheet it opens.
    const stats = source('./Stats.jsx')
    expect(stats).toContain('toggleStatsActionSheet(openActionId, tmdbId)')
  })
})
