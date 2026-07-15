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

  it('retains the accessible poster action and its existing behavior hook', () => {
    const stats = source('./Stats.jsx')
    expect(stats).toContain('aria-label={`Actions for ${show.name}`}')
    expect(stats).toContain('toggleStatsActionSheet(openActionId, show.tmdb_id)')
    expect(stats).toContain('h-11 w-11')
    expect(stats).toContain('h-9 w-9')
  })
})
