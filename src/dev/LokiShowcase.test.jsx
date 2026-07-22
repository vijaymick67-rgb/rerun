// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LokiShowcase from './LokiShowcase'
import { isLokiPrototypePath, LOKI_PROTOTYPE_PATH } from './lokiRoute'
import TabBar from '../components/TabBar'
import { MemoryRouter } from 'react-router-dom'

describe('Loki development prototype', () => {
  it('is available only for the exact development route', () => {
    expect(LOKI_PROTOTYPE_PATH).toBe('/dev/loki')
    expect(isLokiPrototypePath('/dev/loki', true)).toBe(true)
    expect(isLokiPrototypePath('/dev/loki/', true)).toBe(true)
    expect(isLokiPrototypePath('/dev/loki', false)).toBe(false)
    expect(isLokiPrototypePath('/dev/loki/anything', true)).toBe(false)
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
