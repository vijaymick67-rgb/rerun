import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { POSTER_BASE } from '../lib/tmdb'
import { episodeKey, watchingStatusLabel } from '../lib/watchHelpers'
import { handleTapNavigateClick } from '../lib/pressIntent'
import ProgressiveImage from './ProgressiveImage'

const REVEAL_WIDTH = 84
const DRAG_THRESHOLD = 6

// How much more horizontal than vertical movement must be present before a
// touch sequence is allowed to lock into the left-swipe Remove-reveal
// gesture at all. Below this ratio, vertical scrolling always wins.
const HORIZONTAL_DOMINANCE_RATIO = 1.3

// Bounded window during which a click event that immediately follows a
// recognized Remove-reveal swipe is swallowed. Mobile browsers can still
// synthesize a click after touchend even though touchmove already called
// preventDefault() on the drag itself, and that synthetic click must never
// be allowed to navigate the row — a completed swipe is not a tap. The flag
// is consumed (and cleared) the moment a click actually arrives; this
// timeout only guards the case where the browser never emits one at all, so
// it never swallows an unrelated, later tap.
const CLICK_SUPPRESS_WINDOW = 500

// Minimum time the status button stays visibly green after a tap before it
// is allowed to return to grey, even if the row has already advanced to the
// next episode by then — long enough to be consciously noticed, short
// enough that the interaction never feels delayed. See handleStatusClick.
const QUICK_MARK_MIN_DWELL_MS = 340

export default function WatchingRow({
  show, isRemoving, isOpen, onOpenChange, onRemove, onQuickMark, isQuickMarking,
  canQuickMark = true,
}) {
  const navigate = useNavigate()
  const rowRef = useRef(null)
  const frontRef = useRef(null)
  const dragState = useRef(null)
  const dragXRef = useRef(null)
  const [dragX, setDragX] = useState(null)
  const suppressNextClickRef = useRef(false)
  const suppressClickTimerRef = useRef(null)

  const baseX = isOpen ? -REVEAL_WIDTH : 0
  const translateX = dragX !== null ? dragX : baseX

  // A cached row can render nextReleasedUnwatchedEpisode long before this
  // load's mutation context for it is ready (see Watching.jsx's
  // readyShowIds) — the button must not appear tappable, and must not read
  // as a false "caught up" either, in that window. See visualState below.
  const episode = show.nextReleasedUnwatchedEpisode ?? null
  const currentEpisodeKey = episode ? episodeKey(episode.season_number, episode.episode_number) : null
  const showProgressBar = (show.releasedEpisodeCount ?? 0) > 0 &&
    (show.releasedWatchedCount ?? 0) < (show.releasedEpisodeCount ?? 0)

  // Explicit, bounded presentation state for the status button's brief
  // post-tap green confirmation — deliberately not derived solely from
  // isQuickMarking, since the network request may resolve too fast or too
  // slow to read as a deliberate confirmation either way. `key` is the
  // episode identity that was quick-marked at tap time; the confirmation
  // clears once both a minimum dwell has elapsed AND the row's current
  // episode has actually moved on from that identity (or resolved to
  // caught-up), whichever finishes last.
  const [confirmState, setConfirmState] = useState(null)
  const confirmTimerRef = useRef(null)
  const advanced = confirmState ? currentEpisodeKey !== confirmState.key : false

  function clearConfirmTimer() {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
  }

  function startConfirmation(marked) {
    setConfirmState({ ...marked, dwellDone: false })
    clearConfirmTimer()
    confirmTimerRef.current = setTimeout(() => {
      confirmTimerRef.current = null
      setConfirmState((prev) => (prev && prev.key === marked.key ? { ...prev, dwellDone: true } : prev))
    }, QUICK_MARK_MIN_DWELL_MS)
  }

  // Normal path: both the minimum dwell and a genuine row advance are in —
  // release the confirmation and let the button fall back to its plain
  // derived state (grey if another episode is available, green if caught up).
  useEffect(() => {
    if (confirmState && confirmState.dwellDone && advanced) {
      setConfirmState(null)
    }
  }, [confirmState, advanced])

  // Failure/rollback path: the mutation settled (isQuickMarking went back to
  // false) but the row never advanced — the episode is available again
  // exactly as before, so the button must not keep reading as accepted.
  const prevIsQuickMarkingRef = useRef(isQuickMarking)
  useEffect(() => {
    const wasMarking = prevIsQuickMarkingRef.current
    prevIsQuickMarkingRef.current = isQuickMarking
    if (wasMarking && !isQuickMarking && confirmState && !advanced) {
      clearConfirmTimer()
      setConfirmState(null)
    }
  }, [isQuickMarking, confirmState, advanced])

  useEffect(() => () => {
    clearConfirmTimer()
    if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current)
  }, [])

  function setDrag(value) {
    dragXRef.current = value
    setDragX(value)
  }

  useEffect(() => {
    const el = frontRef.current
    if (!el) return

    function handleTouchStart(e) {
      // A gesture that starts on an interactive control (status button,
      // Remove) must never be reinterpreted as a row swipe underneath it.
      if (e.target && e.target.closest && e.target.closest('button')) {
        dragState.current = null
        return
      }
      const touch = e.touches[0]
      dragState.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        base: isOpen ? -REVEAL_WIDTH : 0,
        isHorizontal: null,
      }
    }

    function handleTouchMove(e) {
      const state = dragState.current
      if (!state) return
      const touch = e.touches[0]
      const deltaX = touch.clientX - state.startX
      const deltaY = touch.clientY - state.startY

      if (state.isHorizontal === null) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD && Math.abs(deltaY) < DRAG_THRESHOLD) return
        const horizontalDominant = Math.abs(deltaX) > Math.abs(deltaY) * HORIZONTAL_DOMINANCE_RATIO
        if (!horizontalDominant) {
          // Vertical scrolling wins — never revisited for this gesture.
          state.isHorizontal = false
          return
        }
        if (state.base >= 0 && deltaX > 0) {
          // A rightward drag from rest is not a recognized gesture at all —
          // there is no more right-swipe action to arm.
          state.isHorizontal = false
          return
        }
        state.isHorizontal = true
      }
      if (!state.isHorizontal) return

      e.preventDefault()
      const next = Math.min(0, Math.max(-REVEAL_WIDTH, state.base + deltaX))
      setDrag(next)
    }

    function armClickSuppression() {
      // A recognized Remove-reveal swipe was not a tap, so the click that
      // may follow it must never reach the navigating Link.
      suppressNextClickRef.current = true
      if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current)
      suppressClickTimerRef.current = setTimeout(() => {
        suppressClickTimerRef.current = null
        suppressNextClickRef.current = false
      }, CLICK_SUPPRESS_WINDOW)
    }

    function handleTouchEnd() {
      const state = dragState.current
      dragState.current = null
      if (state && state.isHorizontal) {
        armClickSuppression()
        const current = dragXRef.current !== null ? dragXRef.current : state.base
        const shouldOpen = current < -REVEAL_WIDTH / 2
        onOpenChange(shouldOpen ? show.id : null)
      }
      setDrag(null)
    }

    function handleTouchCancel() {
      // A cancelled sequence never commits a Remove-reveal state change —
      // it just snaps back to rest.
      dragState.current = null
      setDrag(null)
    }

    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
    el.addEventListener('touchend', handleTouchEnd, { passive: true })
    el.addEventListener('touchcancel', handleTouchCancel, { passive: true })

    return () => {
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
      el.removeEventListener('touchcancel', handleTouchCancel)
    }
  }, [isOpen, show.id, onOpenChange])

  useEffect(() => {
    if (!isOpen) return
    function handleOutside(e) {
      if (rowRef.current && !rowRef.current.contains(e.target)) {
        onOpenChange(null)
      }
    }
    document.addEventListener('touchstart', handleOutside)
    document.addEventListener('mousedown', handleOutside)
    return () => {
      document.removeEventListener('touchstart', handleOutside)
      document.removeEventListener('mousedown', handleOutside)
    }
  }, [isOpen, onOpenChange])

  function handleLinkClick(e) {
    if (suppressNextClickRef.current) {
      // The click a browser may synthesize right after a recognized swipe's
      // touchend — never a real tap, so it never opens or closes anything.
      suppressNextClickRef.current = false
      if (suppressClickTimerRef.current) {
        clearTimeout(suppressClickTimerRef.current)
        suppressClickTimerRef.current = null
      }
      e.preventDefault()
      return
    }
    if (isOpen) {
      e.preventDefault()
      onOpenChange(null)
      return
    }
    handleTapNavigateClick(e, navigate, `/watching/${show.tmdb_id}`)
  }

  // notReady: this load's mutation context for the show isn't populated yet
  // — must never read as a false "caught up" just because the episode field
  // is temporarily absent. accepted: the brief post-tap confirmation.
  // available: a released unwatched episode can be quick-marked. caughtUp:
  // no released unwatched episode remains — permanent until data changes.
  const visualState = !canQuickMark
    ? 'notReady'
    : confirmState
      ? 'accepted'
      : episode
        ? 'available'
        : 'caughtUp'

  function handleStatusClick(e) {
    e.preventDefault()
    e.stopPropagation()
    if (visualState !== 'available' || isQuickMarking) return
    const marked = {
      season_number: episode.season_number,
      episode_number: episode.episode_number,
      key: currentEpisodeKey,
    }
    onQuickMark(show)
    startConfirmation(marked)
  }

  const isInteractive = visualState === 'available' && !isQuickMarking
  const statusLabel = visualState === 'available'
    ? `Mark S${episode.season_number}E${episode.episode_number} of ${show.name} watched`
    : visualState === 'accepted'
      ? `Marked S${confirmState.season_number}E${confirmState.episode_number} of ${show.name} watched`
      : visualState === 'caughtUp'
        ? `Caught up with ${show.name}`
        : `Loading watch status for ${show.name}`

  return (
    <div
      ref={rowRef}
      className="watching-row content-row relative overflow-hidden"
    >
      <button
        type="button"
        onClick={() => onRemove(show)}
        disabled={isRemoving}
        aria-label={`Remove ${show.name}`}
        className="motion-press watching-remove-surface absolute inset-y-0 right-0 flex w-[84px] items-center justify-center text-sm font-medium disabled:opacity-60"
      >
        {isRemoving ? '…' : 'Remove'}
      </button>

      <div
        ref={frontRef}
        className="watching-row-front relative flex touch-pan-y gap-3 bg-(--color-surface) p-3"
        style={{
          transform: `translateX(${translateX}px)`,
          transition: dragX !== null ? 'none' : 'transform 200ms ease',
        }}
      >
        <Link
          to={`/watching/${show.tmdb_id}`}
          onClick={handleLinkClick}
          className="motion-press watching-row-link flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ProgressiveImage
            src={show.poster_path ? POSTER_BASE + show.poster_path : null}
            alt={show.name}
            fallbackLabel="No poster"
            className="h-24 w-16 shrink-0 rounded-md"
          />

          <div className="min-w-0 flex-1">
            <p className="type-show-title truncate text-(--color-text)">{show.name}</p>

            {show.loadError ? (
              <p className="type-caption mt-1 text-(--color-destructive)">Couldn't load episodes</p>
            ) : show.status?.type === 'nextUp' ? (
              <p className="type-caption mt-1 text-(--color-accent)">
                Up next: S{show.status.season_number}E{show.status.episode_number}
                {show.status.name ? ` · ${show.status.name}` : ''}
              </p>
            ) : show.status?.type === 'countdown' ? (
              <span className="watching-countdown-pill type-caption mt-1">
                {watchingStatusLabel(show.status)}
              </span>
            ) : (
              <p className="type-caption mt-1 text-(--color-text-muted)">Caught up</p>
            )}

            {showProgressBar && (
              <div className="progress-track mt-2 w-full max-w-40">
                <div
                  className="progress-fill"
                  style={{ width: `${show.releasedProgress}%` }}
                />
              </div>
            )}
          </div>
        </Link>

        <button
          type="button"
          onClick={() => onRemove(show)}
          disabled={isRemoving}
          aria-label={`Remove ${show.name}`}
          className="motion-press watching-row-hover-remove absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-full text-(--color-text-muted) hover:text-(--color-destructive) disabled:opacity-60"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <button
          type="button"
          onClick={handleStatusClick}
          disabled={!isInteractive}
          aria-busy={isQuickMarking || undefined}
          aria-label={statusLabel}
          data-status={visualState}
          className="motion-press watching-status-button absolute top-1/2 right-2 -translate-y-1/2"
        >
          <svg
            viewBox="0 0 24 24" aria-hidden="true" className="watching-status-button__check" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="m5 12 4 4L19 6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
