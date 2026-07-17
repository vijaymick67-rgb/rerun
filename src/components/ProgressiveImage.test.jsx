import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ProgressiveImage from './ProgressiveImage'
import { getImageStatus, reduceImageStatus } from '../lib/progressiveImage'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

describe('ProgressiveImage', () => {
  it('renders a stable placeholder before an unloaded image finishes', () => {
    const html = renderToStaticMarkup(
      <ProgressiveImage
        src="https://image.tmdb.org/t/p/w342/poster.jpg"
        alt="Lucky"
        className="h-24 w-16"
      />,
    )

    expect(html).toContain('progressive-image progressive-image--loading h-24 w-16')
    expect(html).toContain('progressive-image__placeholder')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).toContain('alt="Lucky"')
  })

  it('supports eager above-the-fold loading without changing the shared lifecycle', () => {
    const html = renderToStaticMarkup(
      <ProgressiveImage
        src="https://image.tmdb.org/t/p/w342/hero.jpg"
        alt="Hero"
        loading="eager"
        fetchPriority="high"
      />,
    )

    expect(html).toContain('loading="eager"')
    expect(html).toMatch(/fetchpriority="high"|fetchPriority="high"/)
    expect(html).toContain('decoding="async"')
  })

  it('treats cached-complete images as loaded and invalid complete images as failed', () => {
    expect(getImageStatus({
      src: '/cached.jpg',
      complete: true,
      naturalWidth: 342,
    })).toBe('loaded')
    expect(getImageStatus({
      src: '/broken.jpg',
      complete: true,
      naturalWidth: 0,
    })).toBe('error')
  })

  it('reveals successful loads and activates the fallback on errors', () => {
    expect(reduceImageStatus('load', 342)).toBe('loaded')
    expect(reduceImageStatus('error')).toBe('error')
  })

  it('uses an accessible deliberate fallback without rendering a broken request', () => {
    const html = renderToStaticMarkup(
      <ProgressiveImage
        src={null}
        alt="Lucky"
        fallbackLabel="No poster"
        className="aspect-2/3 w-full"
      />,
    )

    expect(html).toContain('progressive-image progressive-image--error aspect-2/3 w-full')
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Lucky"')
    expect(html).toContain('progressive-image__fallback')
    expect(html).toContain('No poster')
    expect(html).not.toContain('<img')
  })

  it('keeps the reveal restrained and disables it for reduced motion', () => {
    expect(css).toContain('transition: opacity 160ms var(--ease-standard)')
    expect(css).toContain('.progressive-image--loaded .progressive-image__img')
    expect(css).toContain('.progressive-image__img {\n    transition: none;')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
