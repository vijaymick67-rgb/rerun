import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import TabBar from '../components/TabBar'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const rootPages = [
  ['./Browse.jsx', 'Browse'],
  ['./Watching.jsx', 'Watching'],
  ['./Stats.jsx', 'Stats'],
  ['./Settings.jsx', 'Settings'],
]

describe('root navigation polish', () => {
  it('renders the new labels at the existing destinations', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/browse']}>
        <TabBar />
      </MemoryRouter>,
    )

    expect(html).toContain('href="/browse"')
    expect(html).toContain('>Discover</a>')
    expect(html).toContain('href="/watching"')
    expect(html).toContain('>Watching</a>')
    expect(html).toContain('href="/stats"')
    expect(html).toContain('>Insights</a>')
    expect(html).toContain('href="/settings"')
    expect(html).toContain('>Settings</a>')
  })

  it.each(rootPages)('removes the redundant %s root heading', (path, heading) => {
    expect(source(path)).not.toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`))
  })

  it('keeps detail headings and all route paths unchanged', () => {
    expect(source('./ShowDetail.jsx')).toContain('<h1')
    expect(source('./SeasonDetail.jsx')).toContain('<h1')

    const app = source('../App.jsx')
    for (const path of ['/browse', '/watching', '/stats', '/settings']) {
      expect(app).toContain(`path="${path}"`)
    }
    expect(app).toContain('path="/watching/:tmdbId"')
    expect(app).toContain('path="/watching/:tmdbId/season/:seasonNumber"')
  })

  it('keeps the poster action accessible, visible, and behaviorally unchanged', () => {
    const stats = source('./Stats.jsx')
    const actionLabel = 'aria-label={`Actions for ${show.name}`}'
    const actionLabelIndex = stats.indexOf(actionLabel)
    const actionStart = stats.lastIndexOf('<button', actionLabelIndex)
    const actionEnd = stats.indexOf('</button>', actionLabelIndex) + '</button>'.length
    const actionControl = stats.slice(actionStart, actionEnd)

    expect(actionLabelIndex).toBeGreaterThan(-1)
    expect(actionStart).toBeGreaterThan(-1)
    expect(actionEnd).toBeGreaterThan('</button>'.length - 1)
    expect(actionControl).toContain('aria-expanded={actionsOpen}')
    expect(actionControl).toContain('aria-controls="stats-actions-sheet"')
    expect(actionControl).toContain(
      'className="motion-press absolute right-0.5 top-0.5 z-10 flex h-11 w-11',
    )
    expect(actionControl).toContain('toggleStatsActionSheet(openActionId, show.tmdb_id)')
    expect(stats).toContain('to={`/watching/${show.tmdb_id}`}')
    expect(actionControl).toContain('viewBox="0 0 14 4"')
    expect(actionControl).toContain('className="h-2 w-3.5"')
    expect((actionControl.match(/fill="white"/g) ?? []).length).toBe(3)
    expect((actionControl.match(/stroke="rgba\(0, 0, 0, 0\.85\)"/g) ?? []).length).toBe(3)
    expect((actionControl.match(/strokeWidth="0\.75"/g) ?? []).length).toBe(3)
    expect((actionControl.match(/paintOrder="stroke fill"/g) ?? []).length).toBe(3)
    expect(actionControl).not.toMatch(/\bbg-/)
    expect(actionControl).not.toContain('h-7 w-7')
    expect(actionControl).not.toContain('h-1 w-3.5')
    expect(actionControl).not.toContain('h-9 w-9')
  })
})
