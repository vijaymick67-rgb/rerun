import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const stats = read('./Stats.jsx')
const statsAllShows = read('./StatsAllShows.jsx')
const statsShowCard = read('../components/StatsShowCard.jsx')
const statsAllPreview = read('../components/StatsAllPreview.jsx')
const settings = read('./Settings.jsx')
const confirmDialog = read('../components/ConfirmDialog.jsx')
const reloadPrompt = read('../components/ReloadPrompt.jsx')
const notFound = read('../components/NotFound.jsx')
const css = read('../index.css')
const indexHtml = read('../../index.html')

describe('cinematic secondary surfaces', () => {
  it('keeps Stats behavior while simplifying the Insights presentation', () => {
    expect(stats).toContain('<h1 className="type-page-title text-(--color-text)">Insights</h1>')
    expect(stats).not.toContain('<h1 className="sr-only">Insights</h1>')
    // The decorative "Personal archive" eyebrow was removed — Insights only.
    expect(stats).not.toContain('Personal archive')
    expect(stats).toContain('Time with your shows')
    expect(stats).not.toContain('Total time watched')
    expect(stats).toContain('{formatWatchTime(totalMinutes)}')
    expect(stats).toContain('aria-label="Personal insight"')
    expect(stats).not.toContain('Daily insight')
    // The long open "Show history" grid was collapsed into the compact
    // All(n) preview — it must not linger on the main page alongside it.
    expect(stats).not.toContain('Show history')
    expect(stats).toContain('<StatsAllPreview shows={shows} />')
    expect(stats).toContain('className="stats-summary content-surface')
    expect(stats).toContain('className="stats-insight content-surface')

    // Poster + three-dot action control now lives in the shared StatsShowCard,
    // used by the /stats/all grid.
    expect(statsShowCard).toContain('to={`/watching/${show.tmdb_id}`}')
    expect(statsShowCard).toContain('className="motion-press block"')
    expect(statsShowCard).toContain('aria-label={`Actions for ${show.name}`}')
    expect(statsShowCard).not.toContain('className="type-caption">{show.watched} of {show.total}')
    expect(statsShowCard).not.toContain('>Complete</span>')
    expect(statsShowCard).not.toContain('aria-label={`${show.watched} of ${show.total} episodes watched`}')
    expect(statsShowCard).not.toContain('bg-black/60')
    expect(statsShowCard).not.toContain('text-red-400')

    // The action sheet + confirm dialog now live on the expanded page, the
    // only place the three-dot control appears.
    expect(statsAllShows).toContain('role="dialog"')
    expect(statsAllShows).toContain('aria-modal="true"')
    expect(statsAllShows).toContain("if (event.key === 'Escape') onClose()")
    expect(statsAllShows).toContain('onClick={(event) => event.stopPropagation()}')
    expect(statsAllShows).toContain('onRestore')
    expect(statsAllShows).toContain('onRemove')
    expect(statsAllShows).not.toContain('bg-black/60')
    expect(statsAllShows).not.toContain('text-red-400')

    // The compact preview link carries the accessible collection name and
    // never duplicates the "42 shows" count as a separate visible label.
    expect(statsAllPreview).toContain('to="/stats/all"')
    expect(statsAllPreview).toContain('aria-label={`View all ${shows.length} show')
    expect(statsAllPreview).not.toContain('bg-black/60')
    expect(statsAllPreview).not.toContain('text-red-400')
  })

  it('keeps the global atmosphere static, layered, and input-transparent', () => {
    const atmosphere = css.slice(css.indexOf('--canvas-atmosphere:'), css.indexOf('.app-page'))
    expect(css).toContain('--canvas-atmosphere:')
    expect(css).toContain('radial-gradient(ellipse 82% 52% at 76% -8%')
    expect(css).toContain('radial-gradient(ellipse 58% 46% at 2% 42%')
    expect(css).toContain('linear-gradient(155deg, var(--color-canvas-deep)')
    expect(atmosphere).not.toContain('animation:')
    expect(atmosphere).not.toContain('filter: blur(')
    expect(css).not.toContain('background-attachment: fixed')
    expect((css.match(/background:\s*var\(--canvas-atmosphere\);/g) ?? []).length).toBe(1)
    expect(css).toContain('body {')
    expect(css).toContain('background-size: 100% 100%;')
    expect(css).toContain('#root {\n  min-height: 100%;\n}')
    expect(css).toContain('.app-shell {')
    expect(css.slice(css.indexOf('.app-shell {'), css.indexOf('.app-page'))).not.toContain('background:')
    expect(css).toContain('pointer-events: none')
    expect(css).toContain('prefers-reduced-transparency: reduce')
  })

  it('keeps deferred launch identity intact and shields boot from a blue/green flash', () => {
    expect(indexHtml).toContain('meta name="theme-color" content="#080b14"')
    expect(indexHtml).toContain('--canvas-atmosphere:')
    expect(indexHtml).toContain(':root {\n        background: #080b14;\n      }')
    expect(indexHtml).toContain('body {\n        background: var(--canvas-atmosphere);')
    expect(indexHtml).toContain('background-size: 100% 100%;')
    expect(indexHtml).toContain('class="app-loading-shell"')
    expect(css).toContain('--launch-canvas-atmosphere-legacy:')
    expect(css).toContain('.auth-boot-shell,\n.app-loading-shell {')
    expect(css).toContain('background: var(--launch-canvas-atmosphere-legacy);')
    expect(css).toContain('background: var(--canvas-atmosphere);')
    expect(css).toContain('html {\n  min-height: 100%;\n  background-color: var(--color-canvas);\n}')
    expect(css).toContain('.app-shell {')
    expect(css).toContain('max-width: 42rem;')
  })

  it('keeps Settings controls and backup workflows while using grouped semantic roles', () => {
    expect(settings).toContain('className="settings-group surface-group')
    expect(settings).toContain('surface-interactive')
    expect(settings).toContain('type="file"')
    expect(settings).toContain('className="hidden"')
    expect(settings).toContain('<select')
    expect(settings).toContain('PREFERRED_HOUR_OPTIONS')
    expect(settings).toContain('status-banner--destructive')
    expect(settings).toContain('aria-live={live ? \'polite\' : undefined}')
    expect(settings).not.toContain('border-red-400')
    expect(settings).not.toContain('bg-red-400')
  })

  it('keeps system UI semantics and recovery actions intact', () => {
    expect(confirmDialog).toContain('role="alertdialog"')
    expect(confirmDialog).toContain('aria-modal="true"')
    expect(confirmDialog).toContain('onClick={onConfirm}')
    expect(confirmDialog).toContain("if (e.key === 'Escape') onCancel()")
    expect(reloadPrompt).toContain('role="status" aria-live="polite"')
    expect(reloadPrompt).toContain('onClick={onUpdate}')
    expect(reloadPrompt).toContain('onClick={onDismiss}')
    expect(notFound).toContain('to="/"')
    expect(css).toContain('background: var(--color-overlay);')
    expect(css).toContain('border-radius: var(--radius-overlay);')
    expect(css).toContain('box-shadow: var(--elevation-overlay);')
  })
})
