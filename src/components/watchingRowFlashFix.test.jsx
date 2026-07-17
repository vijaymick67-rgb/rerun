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

describe('watching remove-flash fix: root cause and containment', () => {
  it('closes an open row instantly (no CSS transition) before the outside-tap state update commits', () => {
    const outsideEffect = watchingRowSrc.slice(
      watchingRowSrc.indexOf('useEffect(() => {\n    if (!isOpen) return'),
      watchingRowSrc.indexOf('function handleLinkClick'),
    )
    expect(outsideEffect).toContain("el.style.transition = 'none'")
    expect(outsideEffect).toContain("el.style.transform = 'translateX(0px)'")
    expect(outsideEffect).toContain('void el.offsetHeight')
    // The imperative snap must happen before the React state update, so the
    // browser's very next paint already reflects the closed, non-animating
    // state — eliminating the mid-transition frame a navigation could unmount
    // mid-flight (the mechanism behind the reported flash).
    expect(outsideEffect.indexOf('el.style.transition')).toBeLessThan(
      outsideEffect.indexOf('onOpenChange(null)'),
    )
  })

  it('does not special-case any specific show name or status type — the fix applies uniformly', () => {
    expect(watchingRowSrc).not.toMatch(/Lanterns|Adults/)
    // The instant-close fix lives inside the generic isOpen-gated outside-tap
    // effect, not behind any status-type branch, so nextUp/countdown/caughtUp
    // rows are all covered identically.
    const outsideEffectIndex = watchingRowSrc.indexOf("if (!isOpen) return")
    const statusBranchIndex = watchingRowSrc.indexOf("status?.type === 'countdown'")
    expect(outsideEffectIndex).toBeGreaterThan(-1)
    expect(statusBranchIndex).toBeGreaterThan(outsideEffectIndex)
  })
})

describe('watching remove-flash fix: swipe contract untouched', () => {
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
    // The instant-snap fix must NOT appear in the gesture-driven close path —
    // a live drag release should keep its natural animated settle.
    expect(touchEndBody).not.toContain("style.transition = 'none'")
  })

  it('a genuine swipe still targets exactly translateX(-84px) when open', () => {
    const html = renderRow({ isOpen: true })
    expect(html).toContain('translateX(-84px)')
  })

  it('outside tap still closes the row (onOpenChange still invoked with null)', () => {
    const outsideEffect = watchingRowSrc.slice(
      watchingRowSrc.indexOf('function handleOutside(e)'),
      watchingRowSrc.indexOf("document.addEventListener('touchstart', handleOutside)"),
    )
    expect(outsideEffect).toContain('!rowRef.current.contains(e.target)')
    expect(outsideEffect).toContain('onOpenChange(null)')
  })

  it('a tap on the open row itself still just closes it (never navigates in the same tap)', () => {
    expect(watchingRowSrc).toContain('function handleLinkClick(e) {')
    expect(watchingRowSrc).toContain('if (isOpen) {\n      e.preventDefault()\n      onOpenChange(null)\n    }')
  })
})

describe('watching remove-flash fix: row identity and state lifecycle', () => {
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

describe('watching remove-flash fix: navigation destination and mutation semantics unchanged', () => {
  it('WatchingRow still links to /watching/:tmdb_id', () => {
    const html = renderRow()
    expect(html).toContain('href="/watching/9001"')
  })

  it('remove is still routed through the confirm dialog + Supabase delete, not a direct mutation', () => {
    expect(watchingSrc).toContain("supabase\n      .from('tracked_shows')\n      .delete()")
    expect(watchingSrc).toContain('.eq(\'id\', show.id)')
  })
})

describe('watching remove-flash fix: sort/status/countdown semantics untouched', () => {
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

describe('watching remove-flash fix: PR #75 press feedback remains intact', () => {
  it('the navigation Link still carries motion-press (not the cause of this bug)', () => {
    expect(watchingRowSrc).toContain(
      'className="motion-press flex flex-1 items-center gap-3 text-left"',
    )
  })
})
