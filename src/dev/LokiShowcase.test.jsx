// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LokiShowcase from './LokiShowcase'
import { isLokiPrototypePath, LOKI_PROTOTYPE_PATH } from './lokiRoute'
import TabBar from '../components/TabBar'
import { MemoryRouter } from 'react-router-dom'
import { lokiPreviewEntryPlugin, shouldUseLokiPreviewEntry } from '../../vite/loki-preview'

describe('Loki development prototype', () => {
  it('keeps the production boot tree synchronous', () => {
    const main = readFileSync('src/main.jsx', 'utf8')

    expect(main).toContain("import { BrowserRouter } from 'react-router-dom'")
    expect(main).toContain("import AuthGate from './AuthGate.jsx'")
    expect(main).toContain("import { AuthProvider } from './lib/AuthContext'")
    expect(main).toContain('root.render(')
    expect(main).not.toContain('LokiShowcase')
    expect(main).not.toContain("import('./ProductionRoot.jsx')")
  })

  it('selects the isolated entry in development and Vercel Preview only', () => {
    expect(shouldUseLokiPreviewEntry({ command: 'serve' })).toBe(true)
    expect(shouldUseLokiPreviewEntry({ command: 'build', vercelEnv: 'preview' })).toBe(true)
    expect(shouldUseLokiPreviewEntry({ command: 'build', vercelEnv: 'production' })).toBe(false)
    expect(shouldUseLokiPreviewEntry({ command: 'build' })).toBe(false)

    const html = '<script type="module" src="/src/main.jsx"></script>'
    const previewPlugin = lokiPreviewEntryPlugin(true)
    const productionPlugin = lokiPreviewEntryPlugin(false)

    expect(previewPlugin.transformIndexHtml.order).toBe('pre')
    expect(previewPlugin.transformIndexHtml.handler(html)).toContain('/src/dev/lokiEntry.jsx')
    expect(productionPlugin.transformIndexHtml.handler(html)).toBe(html)
  })

  it('matches only the exact prototype route inside an enabled review build', () => {
    expect(LOKI_PROTOTYPE_PATH).toBe('/dev/loki')
    expect(isLokiPrototypePath('/dev/loki')).toBe(true)
    expect(isLokiPrototypePath('/dev/loki/')).toBe(true)
    expect(isLokiPrototypePath('/dev/loki/anything')).toBe(false)
  })

  it('renders static fixtures and critical accessible state semantics', () => {
    window.history.replaceState({}, '', '/dev/loki?view=showcase&dialog=open')
    const html = renderToStaticMarkup(<LokiShowcase />)

    expect(html).toContain('Development only · static fixtures · no product data')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-label="Episode not ready"')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('image.tmdb.org')
    expect(html).not.toContain('supabase')
  })

  it('does not expose the prototype in normal navigation', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/watching']}>
        <TabBar />
      </MemoryRouter>,
    )
    expect(html).not.toContain('/dev/loki')
    expect(html).toContain('Watching')
  })
})
