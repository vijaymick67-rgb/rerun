import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import ShowDetail from './ShowDetail.jsx'
import SeasonDetail from './SeasonDetail.jsx'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

function renderRoute(path, element) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={element} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('nested route safe-area layout', () => {
  it.each([
    ['Show Detail', '/watching/123', 'show'],
    ['Season Detail', '/watching/123/season/1', 'season'],
  ])('%s uses the shared nested-page safe-area layout', (_, path, kind) => {
    const element = kind === 'show' ? <ShowDetail /> : <SeasonDetail />
    const html = renderRoute(path, element)
    expect(html).toContain('nested-page px-4 pb-4')
    expect(html).toContain('min-h-11 min-w-11')
    expect(html).not.toContain('global-top-scrim')
  })

  it('defines one additive top inset without changing the main app-page pattern', () => {
    expect(css.match(/\.nested-page\s*\{/g)).toHaveLength(1)
    expect(css).toContain('padding-top: calc(var(--safe-area-inset-top) + 1rem)')
    expect(css).toContain('padding-top: max(1rem, var(--safe-area-inset-top))')
  })

  it('keeps all main tab pages on the existing app-page layout', () => {
    for (const route of ['Browse.jsx', 'Watching.jsx', 'Stats.jsx', 'Settings.jsx']) {
      const source = readFileSync(new URL(`./${route}`, import.meta.url), 'utf8')
      expect(source).toContain('app-page')
      expect(source).not.toContain('nested-page')
    }
  })
})
