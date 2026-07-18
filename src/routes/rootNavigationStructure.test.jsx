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
    const actionButtonAttributes = stats.match(
      /aria-label=\{`Actions for \$\{show\.name\}`\}[\s\S]*?className="[^"]*"/,
    )?.[0]

    expect(actionButtonAttributes).toBeDefined()
    expect(actionButtonAttributes).toContain('aria-expanded={actionsOpen}')
    expect(actionButtonAttributes).toContain('aria-controls="stats-actions-sheet"')
    expect(actionButtonAttributes).toContain(
      'className="motion-press absolute right-0.5 top-0.5 z-10 flex h-11 w-11',
    )
    expect(stats).toContain('toggleStatsActionSheet(openActionId, show.tmdb_id)')
    expect(stats).toContain('to={`/watching/${show.tmdb_id}`}')
    expect(stats).toContain('viewBox="0 0 14 4"')
    expect(stats).toContain('h-7 w-7')
    expect(stats).toContain('bg-black/55 text-white')
    expect(stats).toContain('h-2 w-3.5')
    expect(stats).not.toContain('h-1 w-3.5')
    expect(stats).not.toContain('h-9 w-9')
  })
})
