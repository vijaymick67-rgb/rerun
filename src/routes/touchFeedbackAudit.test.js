import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const watchingRow = src('../components/WatchingRow.jsx')
const showDetail = src('./ShowDetail.jsx')
const seasonDetail = src('./SeasonDetail.jsx')
const stats = src('./Stats.jsx')
const browse = src('./Browse.jsx')
const confirmDialog = src('../components/ConfirmDialog.jsx')
const indexCss = src('../index.css')

describe('touch feedback: interactive elements use the shared motion-press contract', () => {
  it('WatchingRow navigation link presses immediately', () => {
    expect(watchingRow).toContain(
      'className="motion-press flex flex-1 items-center gap-3 text-left"',
    )
  })

  it('ShowDetail season-row link presses immediately', () => {
    expect(showDetail).toContain(
      'className="motion-press flex min-w-0 flex-1 items-center justify-between py-3 pr-2"',
    )
  })

  it('Stats poster link presses immediately', () => {
    expect(stats).toContain('className="motion-press block"')
  })

  it('Browse retry and dismiss actions press immediately', () => {
    expect(browse).toContain('className="motion-press underline">Retry</button></p>}')
    expect(
      (browse.match(/className="motion-press underline">Retry<\/button>/g) ?? []).length,
    ).toBe(2)
  })
})

describe('touch feedback: navigation destinations are unchanged', () => {
  it('WatchingRow still links to /watching/:tmdb_id', () => {
    expect(watchingRow).toContain('to={`/watching/${show.tmdb_id}`}')
  })

  it('ShowDetail season row still links to the same season route', () => {
    expect(showDetail).toContain(
      'to={`/watching/${numericTmdbId}/season/${season.season_number}`}',
    )
  })

  it('Stats poster still links to /watching/:tmdb_id', () => {
    expect(stats).toContain('to={`/watching/${show.tmdb_id}`}')
  })
})

describe('touch feedback: swipeable Watching row keeps its existing transform/gesture contract', () => {
  it('preserves the reveal width and drag threshold constants', () => {
    expect(watchingRow).toContain('const REVEAL_WIDTH = 84')
    expect(watchingRow).toContain('const DRAG_THRESHOLD = 6')
  })

  it('keeps translateX-based swipe transform on the front row, independent of motion-press scale', () => {
    expect(watchingRow).toContain('transform: `translateX(${translateX}px)`')
    // motion-press applies via the standalone `scale` CSS property (see index.css),
    // never `transform: scale(...)`, so it can't fight this translateX.
    expect(indexCss).toMatch(/\.motion-press:active[^{]*\{\s*scale: 0\.98;/)
  })

  it('keeps passive/non-passive touch listener behavior untouched', () => {
    expect(watchingRow).toContain("addEventListener('touchstart', handleTouchStart, { passive: true })")
    expect(watchingRow).toContain("addEventListener('touchmove', handleTouchMove, { passive: false })")
  })
})

describe('touch feedback: keyboard focus-visible improvements', () => {
  it('reveals the hover-remove icon button on keyboard focus, not just mouse hover', () => {
    expect(indexCss).toContain('.watching-row-hover-remove:focus-visible {')
    expect(indexCss).toMatch(/\.watching-row-hover-remove:focus-visible \{\s*opacity: 1;\s*pointer-events: auto;\s*\}/)
  })
})

describe('touch feedback: minimum target sizing on icon-only and dialog buttons', () => {
  it('ShowDetail and SeasonDetail error-dismiss buttons meet the 44px minimum', () => {
    expect(showDetail).toContain(
      'className="motion-press min-h-11 min-w-11 shrink-0 text-red-400/80 hover:text-red-400"',
    )
    expect(seasonDetail).toContain(
      'className="motion-press min-h-11 min-w-11 shrink-0 text-red-400/80 hover:text-red-400"',
    )
  })

  it('Browse delayed-add dismiss button meets the 44px minimum', () => {
    expect(browse).toContain(
      'className="motion-press min-h-11 min-w-11 shrink-0 text-(--color-accent)/80 hover:text-(--color-accent)"',
    )
  })

  it('ConfirmDialog Cancel/Confirm buttons meet the 44px minimum height', () => {
    expect(confirmDialog).toContain('motion-press min-h-11 rounded-md px-3 py-1.5')
    expect((confirmDialog.match(/motion-press min-h-11 rounded-md px-3 py-1\.5/g) ?? []).length).toBe(2)
  })
})

describe('touch feedback: destructive confirmation still required', () => {
  it('ConfirmDialog still requires an explicit onConfirm click and keeps its alertdialog semantics', () => {
    expect(confirmDialog).toContain('role="alertdialog"')
    expect(confirmDialog).toContain('onClick={onConfirm}')
    // Escape still just calls onCancel — no auto-confirm behavior was introduced.
    expect(confirmDialog).toContain("if (e.key === 'Escape') onCancel()")
  })
})

describe('touch feedback: reduced motion still collapses press feedback', () => {
  it('the global prefers-reduced-motion block still neutralizes motion-press scale/opacity', () => {
    const reducedMotionBlock = indexCss.slice(
      indexCss.indexOf('@media (prefers-reduced-motion: reduce)'),
    )
    expect(reducedMotionBlock).toContain(
      ".motion-press:active:not(:disabled):not([aria-disabled='true']) {",
    )
    expect(reducedMotionBlock).toContain('scale: none;')
    expect(reducedMotionBlock).toContain('opacity: 1;')
  })
})

describe('touch feedback: episode-toggle mutation semantics are untouched', () => {
  it('SeasonDetail still guards toggleEpisode on hasAired and disables unaired controls', () => {
    expect(seasonDetail).toContain('if (!hasAired(episode)) return')
    expect(seasonDetail).toContain('disabled={!episodeHasAired}')
  })

  it('ShowDetail still routes season toggles through the same optimistic mutation queue', () => {
    expect(showDetail).toContain('toggleSeasonOptimistically({')
  })
})

describe('touch feedback: no new network calls introduced by this pass', () => {
  it('Browse keeps exactly one debounced search call and no fetch() usage', () => {
    expect(browse).not.toContain('fetch(')
    expect((browse.match(/searchShows\(/g) ?? []).length).toBe(1)
  })
})
