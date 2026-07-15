import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import WatchedCircle from './WatchedCircle'

describe('WatchedCircle', () => {
  it('renders a checked accessible control with a generous touch target', () => {
    const html = renderToStaticMarkup(
      <WatchedCircle checked label="Mark episode 3 unwatched" onClick={vi.fn()} />,
    )
    expect(html).toContain('aria-label="Mark episode 3 unwatched"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('min-h-11')
    expect(html).toContain('<svg')
  })

  it('keeps an unaired episode control visible but disabled', () => {
    const html = renderToStaticMarkup(
      <WatchedCircle checked={false} disabled label="Mark episode 4 watched" onClick={vi.fn()} />,
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-label="Mark episode 4 watched"')
  })
})
