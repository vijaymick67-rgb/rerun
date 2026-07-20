import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const main = read('./main.jsx')
const fonts = read('./fonts.css')
const css = read('./index.css')
const seasonDetail = read('./routes/SeasonDetail.jsx')
const showDetail = read('./routes/ShowDetail.jsx')
const settings = read('./routes/Settings.jsx')
const notFound = read('./components/NotFound.jsx')

describe('premium typography foundation', () => {
  it('uses one bundled Fontsource variable family with no runtime font URL', () => {
    expect(packageJson.dependencies['@fontsource-variable/manrope']).toBe('5.3.0')
    expect((main.match(/import ['"]\.\/fonts\.css['"]/g) ?? [])).toHaveLength(1)
    expect((fonts.match(/@fontsource-variable\/manrope/g) ?? [])).toHaveLength(1)
    expect((fonts.match(/@font-face/g) ?? [])).toHaveLength(1)
    expect(fonts).toContain("font-family: 'Manrope Variable';")
    expect(fonts).toContain('font-weight: 200 800;')
    expect(fonts).not.toMatch(/https?:\/\//)
    expect(fonts).not.toContain('fonts.googleapis.com')
    expect(fonts).not.toContain('fonts.gstatic.com')
  })

  it('defines a controlled type hierarchy and spacing rhythm', () => {
    for (const token of [
      '--space-micro', '--space-compact', '--space-related', '--space-standard',
      '--space-section', '--space-major', '--space-large', '--type-display-size',
      '--type-nested-title-size', '--weight-display', '--weight-heading',
      '--weight-show', '--weight-body', '--weight-metadata', '--weight-navigation',
    ]) {
      expect(css).toContain(`${token}:`)
    }
    for (const className of [
      '.type-display', '.type-page-title', '.type-nested-title', '.type-section-title',
      '.type-show-title', '.type-episode-title', '.type-body', '.type-metadata',
      '.type-caption', '.type-navigation', '.type-badge', '.type-numeric',
    ]) {
      expect(css).toContain(`${className} {`)
    }
    expect(css).toContain('--font-sans: "Manrope Variable", system-ui')
    expect(css).toContain('-apple-system')
    expect(css).toContain('BlinkMacSystemFont')
  })
})

describe('Season Detail typography and spacing refinement', () => {
  it('keeps the nested header accessible, wrappable, and behaviorally unchanged', () => {
    expect(seasonDetail).toContain('to={`/watching/${numericTmdbId}`}')
    expect(seasonDetail).toContain('aria-label="Back to show"')
    expect(seasonDetail).toContain('className="nested-header__back motion-press min-h-11 min-w-11"')
    expect(seasonDetail).toContain('className="nested-header__title type-nested-title text-(--color-text)"')
    expect(seasonDetail).toContain('className="nested-header__subtitle"')
    expect(seasonDetail).not.toContain('truncate text-xl font-semibold')
    expect(seasonDetail).toContain('<svg viewBox="0 0 24 24"')
  })

  it('keeps episode titles, release semantics, future disabling, and touch targets', () => {
    expect(seasonDetail).toContain('className="season-episode-title type-episode-title"')
    expect(seasonDetail).toContain('className="season-episode-meta type-metadata"')
    expect(seasonDetail).toContain('episodeReleaseInfo(ep)')
    expect(seasonDetail).toContain(': `Airs ${releaseLabel}`')
    expect(seasonDetail).toContain('disabled={!episodeHasAired}')
    expect(seasonDetail).not.toContain('truncate text-sm text-(--color-text)')
    expect(seasonDetail).toContain('onClick={() => toggleEpisode(ep)}')
    expect(css).toContain('.season-episode-row--future {')
    expect(css).toContain('overflow-wrap: anywhere;')
    expect(read('./components/WatchedCircle.jsx')).toContain('min-h-11 min-w-11')
  })

  it('keeps Show Detail nested typography and parent navigation intact', () => {
    expect(showDetail).toContain('to="/watching"')
    expect(showDetail).toContain('aria-label="Back to Watching"')
    expect(showDetail).toContain('className="nested-header__back motion-press min-h-11 min-w-11"')
    expect(showDetail).toContain('className="nested-header__copy nested-header__title type-nested-title text-(--color-text)"')
    expect(showDetail).toContain('toggleSeasonOptimistically({')
  })

  it('uses the semantic hierarchy in calm system routes', () => {
    expect(settings).toContain('className="type-body"')
    expect(settings).toContain('className="type-caption text-(--color-text-muted)"')
    expect(settings).toContain('className="type-metadata text-(--color-text-secondary)"')
    expect(notFound).toContain('className="type-body mt-2')
  })
})
