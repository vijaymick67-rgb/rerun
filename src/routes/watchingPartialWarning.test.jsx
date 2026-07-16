import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WatchingPartialWarning } from './Watching.jsx'

describe('Watching partial enrichment warning', () => {
  it('renders a non-blocking warning with Retry', () => {
    const html = renderToStaticMarkup(
      <WatchingPartialWarning error={{ code: 'DATA-TMDB' }} onRetry={vi.fn()} />,
    )
    expect(html).toContain('Some show details couldn’t refresh.')
    expect(html).toContain('DATA-TMDB')
    expect(html).toContain('>Retry</button>')
  })
})
