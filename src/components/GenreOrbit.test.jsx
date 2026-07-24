// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildGenreDistribution } from '../lib/insights/genreDistribution.js'
import GenreOrbit from './GenreOrbit'

function show(id, genres, runtimes) {
  return { tmdb_id: id, genres, watchedEpisodeRuntimes: runtimes }
}

function render(shows) {
  return renderToStaticMarkup(
    <GenreOrbit distribution={buildGenreDistribution(shows)} />,
  )
}

describe('Genre Orbit', () => {
  it('renders a semantic heading, accessible chart summary, and exact ranked list', () => {
    const html = render([
      show(1, ['Drama'], [60, 60]),
      show(2, ['Comedy'], [30]),
    ])
    expect(html).toContain('<h2')
    expect(html).toContain('Genre orbit')
    expect(html).toContain('role="img"')
    expect(html).toContain('Genre distribution based on watched episode runtime.')
    expect(html).toContain('aria-label="Genre percentages"')
    expect(html).toContain('Drama')
    expect(html).toContain('80%')
    expect(html).toContain('Comedy')
    expect(html).toContain('20%')
  })

  it('renders a complete single-genre orbit gracefully', () => {
    const html = render([show(1, ['Comedy'], [25, 25])])
    expect(html).toContain('Comedy')
    expect((html.match(/100%/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('stroke-dasharray="100 0"')
    expect((html.match(/genre-orbit__item/g) ?? []).length).toBe(1)
  })

  it('renders many genres as five primary entries plus an exact Other row', () => {
    const html = render(
      ['Drama', 'Comedy', 'Mystery', 'Crime', 'Family', 'Animation', 'Western']
        .map((genre, index) => show(index + 1, [genre], [70 - index * 5])),
    )
    expect(html).toContain('Other')
    expect((html.match(/genre-orbit__item/g) ?? []).length).toBe(6)
    const percentages = [...html.matchAll(/genre-orbit__percent">(\d+)%/g)]
      .map((match) => Number(match[1]))
    expect(percentages.reduce((sum, value) => sum + value, 0)).toBe(100)
  })

  it('renders nothing when there is no watched runtime', () => {
    expect(render([])).toBe('')
  })

  it('uses fluid, overflow-safe mobile geometry and no chart animation', () => {
    const css = readFileSync(new NodeURL('../index.css', import.meta.url), 'utf8')
    const orbitCss = css.slice(
      css.indexOf('.genre-orbit {'),
      css.indexOf('.stats-loading {'),
    )
    expect(orbitCss).toContain('min-width: 0;')
    expect(orbitCss).toContain('grid-template-columns: minmax(')
    expect(orbitCss).toContain('text-overflow: ellipsis;')
    expect(orbitCss).not.toContain('width: 375px')
    expect(orbitCss).not.toContain('width: 390px')
    expect(orbitCss).not.toContain('overflow-x:')
    expect(orbitCss).not.toContain('animation:')
  })
})
