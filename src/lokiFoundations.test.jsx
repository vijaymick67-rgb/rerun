// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import TabBar from './components/TabBar'
import { isLokiPrototypePath } from './dev/lokiRoute'
import { shouldUseLokiPreviewEntry } from '../vite/loki-preview'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = source('./index.css')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? ''
}

describe('Loki Armour production foundations', () => {
  it('separates navigation selection, progress, completion, and focus roles', () => {
    expect(css).toContain('--color-selection: var(--color-gold-accent-strong)')
    expect(css).toContain('--color-progress: var(--color-emerald)')
    expect(css).toContain('--color-completion: var(--color-emerald-strong)')
    expect(css).toContain('--color-focus-ring: #e0c77d')

    const selectedTab = rule(".app-tab-bar__link[aria-current='page']")
    const selectedMarker = rule(".app-tab-bar__link[aria-current='page']::after")
    const progressFill = rule('.progress-fill')
    const watched = rule('.watched-circle--checked')

    expect(selectedTab).toContain('var(--color-selection)')
    expect(selectedMarker).toContain('var(--color-selection)')
    expect(progressFill).toContain('var(--color-progress)')
    expect(progressFill).not.toContain('var(--color-selection)')
    expect(progressFill).not.toContain('var(--color-accent)')
    expect(watched).toContain('var(--color-completion)')
  })

  it('keeps tab destinations and active navigation semantics unchanged', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/watching/123/season/2']}>
        <TabBar />
      </MemoryRouter>,
    )

    for (const destination of ['/browse', '/watching', '/stats', '/settings']) {
      expect(html).toContain(`href="${destination}"`)
    }
    expect((html.match(/aria-current="page"/g) ?? [])).toHaveLength(1)
    expect(html).toMatch(/href="\/watching"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/watching"/)
  })

  it('keeps production startup synchronous and outside the prototype bundle path', () => {
    const main = source('./main.jsx')
    expect(main).toContain("import AuthGate from './AuthGate.jsx'")
    expect(main).toContain('root.render(')
    expect(main).not.toContain('LokiShowcase')
    expect(main).not.toMatch(/import\s*\(/)
  })

  it('preserves prototype preview/production gating', () => {
    expect(shouldUseLokiPreviewEntry({ command: 'serve' })).toBe(true)
    expect(shouldUseLokiPreviewEntry({ command: 'build', vercelEnv: 'preview' })).toBe(true)
    expect(shouldUseLokiPreviewEntry({ command: 'build', vercelEnv: 'production' })).toBe(false)
    expect(isLokiPrototypePath('/dev/loki')).toBe(true)
    expect(isLokiPrototypePath('/dev/loki/extra')).toBe(false)
  })

  it('retains the protected Insights continuation structure', () => {
    const preview = source('./components/StatsAllPreview.jsx')
    expect(preview).toContain('const PREVIEW_LIMIT = 6')
    expect(preview).toContain('shows.slice(0, PREVIEW_LIMIT)')
    expect(preview).toContain('to="/stats/all"')
    expect(preview).toContain("{'>>'}")
    expect(rule('.stats-all-preview__continuation')).toContain('width: 3.25rem')
    expect(rule('.stats-all-preview__more-link')).toContain('width: 2.75rem')
    expect(rule('.stats-all-preview__more-link')).toContain('height: 2.75rem')
  })

  it('keeps product-data and mutation logic outside the persistent shell', () => {
    const tabBar = source('./components/TabBar.jsx')
    const app = source('./App.jsx')
    expect(tabBar).not.toMatch(/supabase|tmdb|tvmaze|mutation|notification/i)
    expect(app).toContain('<PersistentWatching hidden={!isWatchingRoute} />')
    expect(app).toContain('<ScrollRestorationManager />')
    expect(app).toContain('<ReloadPrompt />')
  })
})
