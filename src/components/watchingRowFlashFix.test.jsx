import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import WatchingRow from './WatchingRow'

const watchingRowSrc = readFileSync(new URL('./WatchingRow.jsx', import.meta.url), 'utf8')
const watchingSrc = readFileSync(new URL('../routes/Watching.jsx', import.meta.url), 'utf8')

function renderRow(overrides = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WatchingRow
        show={{
          id: 1,
          tmdb_id: 9001,
          name: 'Lanterns',
          poster_path: null,
          status: { type: 'countdown', daysUntil: 5, air_date: '2026-07-22' },
        }}
        isRemoving={false}
        isOpen={false}
        onOpenChange={vi.fn()}
        onRemove={vi.fn()}
        {...overrides}
      />
    </MemoryRouter>,
  )
}

// History: the red Remove-layer flash on returning to Watching was originally
// attributed to a WatchingRow-level compositing race and two speculative CSS
// workarounds were merged in PR #76 — an imperative outside-tap snap
// (transition:none + forced layout flush) and a `transform-gpu` promotion on
// every row. Real-device footage disproved that theory: the flash also fired
// with no swipe ever performed, and the whole page visibly blinked. The real
// cause was the route wrapper remounting the Watching page (and replaying its
// fade) on every navigation. That is now fixed at the routing layer by keeping
// the Watching instance mounted across its detail subtree, so PR #76's
// row-level workarounds are removed. These tests lock in the revert and assert
// the swipe/press contract PR #76 must not have disturbed on the way out.
describe('watching-row: PR #76 compositor workarounds are removed', () => {
  it('no longer forces a GPU compositing layer (transform-gpu) on the row container', () => {
    expect(renderRow()).not.toContain('transform-gpu')
    expect(watchingRowSrc).not.toContain('transform-gpu')
  })

  it('the outer container still keeps its overflow-hidden/rounded clip', () => {
    expect(watchingRowSrc).toContain(
      'className="watching-row relative overflow-hidden rounded-lg',
    )
  })

  it('no longer runs the imperative outside-tap snap / forced layout flush', () => {
    expect(watchingRowSrc).not.toContain("el.style.transition = 'none'")
    expect(watchingRowSrc).not.toContain("el.style.transform = 'translateX(0px)'")
    expect(watchingRowSrc).not.toContain('void el.offsetHeight')
  })

  it('outside tap still closes the row via plain React state (onOpenChange(null))', () => {
    const outsideEffect = watchingRowSrc.slice(
      watchingRowSrc.indexOf('function handleOutside(e)'),
      watchingRowSrc.indexOf("document.addEventListener('touchstart', handleOutside)"),
    )
    expect(outsideEffect).toContain('!rowRef.current.contains(e.target)')
    expect(outsideEffect).toContain('onOpenChange(null)')
  })
})

describe('watching-row: swipe contract untouched', () => {
  it('preserves REVEAL_WIDTH, DRAG_THRESHOLD, and passive touch listener flags', () => {
    expect(watchingRowSrc).toContain('const REVEAL_WIDTH = 84')
    expect(watchingRowSrc).toContain('const DRAG_THRESHOLD = 6')
    expect(watchingRowSrc).toContain("addEventListener('touchstart', handleTouchStart, { passive: true })")
    expect(watchingRowSrc).toContain("addEventListener('touchmove', handleTouchMove, { passive: false })")
    expect(watchingRowSrc).toContain("addEventListener('touchend', handleTouchEnd, { passive: true })")
  })

  it('leaves the drag-driven touchend close/settle path (the real swipe gesture feel) untouched', () => {
    const touchEndBody = watchingRowSrc.slice(
      watchingRowSrc.indexOf('function handleTouchEnd()'),
      watchingRowSrc.indexOf('el.addEventListener'),
    )
    expect(touchEndBody).toContain('const shouldOpen = current < -REVEAL_WIDTH / 2')
    expect(touchEndBody).toContain('onOpenChange(shouldOpen ? show.id : null)')
    expect(touchEndBody).not.toContain("style.transition = 'none'")
  })

  it('a genuine swipe still targets exactly translateX(-84px) when open', () => {
    const html = renderRow({ isOpen: true })
    expect(html).toContain('translateX(-84px)')
  })

  it('a tap on the open row itself still just closes it (never navigates in the same tap)', () => {
    expect(watchingRowSrc).toContain('function handleLinkClick(e) {')
    expect(watchingRowSrc).toContain('if (isOpen) {\n      e.preventDefault()\n      onOpenChange(null)\n    }')
  })
})

describe('watching-row: row identity and state lifecycle', () => {
  it('rows are keyed by the stable show.id so identity survives sorting/refresh', () => {
    expect(watchingSrc).toContain('key={show.id}')
  })

  it('openSwipeId is plain, non-persisted component state — nothing restores it non-null on mount', () => {
    expect(watchingSrc).toContain('const [openSwipeId, setOpenSwipeId] = useState(null)')
  })

  it('the swipe-open id is never written to the watching cache', () => {
    const cacheCallSite = watchingSrc.slice(
      watchingSrc.indexOf('saveWatchingCache(next)'),
      watchingSrc.indexOf('saveWatchingCache(next)') + 40,
    )
    expect(cacheCallSite).not.toContain('openSwipeId')
  })

  it('remove-confirmation flow still closes any open swipe before showing the dialog', () => {
    const handleRemove = watchingSrc.slice(
      watchingSrc.indexOf('function handleRemove(show)'),
      watchingSrc.indexOf('async function confirmRemove()'),
    )
    expect(handleRemove).toContain('setOpenSwipeId(null)')
    expect(handleRemove).toContain('setConfirmingShow(show)')
  })
})

describe('watching-row: navigation destination and mutation semantics unchanged', () => {
  it('WatchingRow still links to /watching/:tmdb_id', () => {
    const html = renderRow()
    expect(html).toContain('href="/watching/9001"')
  })

  it('remove is still routed through the confirm dialog + Supabase delete, not a direct mutation', () => {
    expect(watchingSrc).toContain("supabase\n      .from('tracked_shows')\n      .delete()")
    expect(watchingSrc).toContain('.eq(\'id\', show.id)')
  })
})

describe('watching-row: sort/status/countdown semantics untouched', () => {
  it('sortWatchingShows keeps its exact existing rank/ordering rules', () => {
    expect(watchingSrc).toContain(
      "const statusRank = { nextUp: 0, countdown: 1, caughtUp: 2, completed: 3 }",
    )
    expect(watchingSrc).toContain('Math.max(0, a.status.daysUntil) - Math.max(0, b.status.daysUntil)')
  })

  it('visibility filtering still goes through the shared isVisibleInWatching helper', () => {
    expect(watchingSrc).toContain('shows.filter((show) => isVisibleInWatching(show, show.status))')
  })
})

describe('watching-row: PR #75 press feedback remains intact', () => {
  it('the navigation Link still carries motion-press', () => {
    expect(watchingRowSrc).toContain(
      'className="motion-press flex flex-1 items-center gap-3 text-left"',
    )
  })
})
