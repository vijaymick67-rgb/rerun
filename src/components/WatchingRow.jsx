import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { POSTER_BASE } from '../lib/tmdb'
import { watchingStatusLabel } from '../lib/watchHelpers'
import { handleTapNavigateClick } from '../lib/pressIntent'
import ProgressiveImage from './ProgressiveImage'

const REVEAL_WIDTH = 84
const DRAG_THRESHOLD = 6

// How much more horizontal than vertical movement must be present before a
// touch sequence is allowed to lock into a horizontal (left/right) swipe at
// all. Below this ratio, vertical scrolling always wins — this is what keeps
// an accidental diagonal drag during a scroll from ever arming the
// no-confirmation right-swipe quick mark.
const HORIZONTAL_DOMINANCE_RATIO = 1.3

// A rightward drag must travel at least this far before a release will fire
// quick mark — deliberately larger than DRAG_THRESHOLD (which only decides
// horizontal vs. vertical) so a slight flick can never activate a
// destructive-adjacent, no-confirmation action.
const RIGHT_ACTIVATION_DISTANCE = 80

// The row is never allowed to travel further right than this. Travel past
// RIGHT_ACTIVATION_DISTANCE is resisted (see pullWithResistance) so the
// gesture reads as "armed", not as the row sliding fully away.
const RIGHT_MAX_PULL = 104
const RIGHT_RESISTANCE_DIVISOR = 3

// How long the post-quick-mark success wash stays visible before it clears
// itself — independent of the Supabase mutation's own timing, since the row
// must never look "stuck" green regardless of how the mutation resolves.
// This is deliberately "gesture accepted" feedback, not a persistence
// confirmation: it starts the instant a valid right-swipe is recognized and
// always finishes on its own fixed schedule, exactly like the tick button's
// own optimistic (no-spinner, no-confirmation) contract. If the mutation
// later fails, Watching.jsx's rollback is what's authoritative — the row's
// text/progress revert — while this wash has already cleared on its own.
const SUCCESS_FLASH_DURATION = 400

// Bounded window during which a click event that immediately follows a
// recognized horizontal swipe (Remove-reveal or quick-mark) is swallowed.
// Mobile browsers can still synthesize a click after touchend even though
// touchmove already called preventDefault() on the drag itself, and that
// synthetic click must never be allowed to navigate the row — a completed
// swipe is not a tap. The flag is consumed (and cleared) the moment a click
// actually arrives; this timeout only guards the case where the browser
// never emits one at all, so it never swallows an unrelated, later tap.
const CLICK_SUPPRESS_WINDOW = 500

function pullWithResistance(deltaX) {
  if (deltaX <= RIGHT_ACTIVATION_DISTANCE) return deltaX
  const resisted = RIGHT_ACTIVATION_DISTANCE +
    (deltaX - RIGHT_ACTIVATION_DISTANCE) / RIGHT_RESISTANCE_DIVISOR
  return Math.min(RIGHT_MAX_PULL, resisted)
}

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
  const successTimerRef = useRef(null)
  const [showSuccessFlash, setShowSuccessFlash] = useState(false)
  const suppressNextClickRef = useRef(false)
  const suppressClickTimerRef = useRef(null)

  const baseX = isOpen ? -REVEAL_WIDTH : 0
  const translateX = dragX !== null ? dragX : baseX

  // A cached row can render nextReleasedUnwatchedEpisode long before this
  // load's mutation context for it is ready (see Watching.jsx's
  // readyShowIds) — the control must not appear tappable or swipeable in
  // that window, since acting on it before context exists would silently do
  // nothing.
  const quickMarkEpisode = canQuickMark ? (show.nextReleasedUnwatchedEpisode ?? null) : null
  const rightSwipeEligible = !!quickMarkEpisode && !isQuickMarking
  const showProgressBar = (show.releasedEpisodeCount ?? 0) > 0 &&
    (show.releasedWatchedCount ?? 0) < (show.releasedEpisodeCount ?? 0)

  // Read inside the touch handlers below via .current so a right-swipe
  // release always acts on the freshest show/eligibility, without forcing
  // the gesture effect to re-subscribe its listeners on every render (the
  // same pattern Watching.jsx uses for showsRef).
  const showRef = useRef(show)
  showRef.current = show
  const onQuickMarkRef = useRef(onQuickMark)
  onQuickMarkRef.current = onQuickMark
  const rightSwipeEligibleRef = useRef(rightSwipeEligible)
  rightSwipeEligibleRef.current = rightSwipeEligible

  function setDrag(value) {
    dragXRef.current = value
    setDragX(value)
  }

  useEffect(() => () => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current)
    if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current)
  }, [])

  useEffect(() => {
    const el = frontRef.current
    if (!el) return

    function handleTouchStart(e) {
      // A gesture that starts on an interactive control (tick, Remove) must
      // never be reinterpreted as a row swipe underneath it.
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
        // Locked the instant the gesture is classified horizontal, so a
        // reversal mid-drag can never cross over into the opposite action.
        family: null,
        rightEligible: rightSwipeEligibleRef.current,
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
        if (state.base < 0 || deltaX < 0) {
          state.family = 'reveal'
        } else if (state.rightEligible) {
          state.family = 'quickmark'
        } else {
          // Rightward drag on an ineligible (e.g. caught-up) row is not a
          // recognized gesture at all — no displacement, no armed state,
          // nothing to cancel or bounce back from.
          state.isHorizontal = false
          return
        }
        state.isHorizontal = true
      }
      if (!state.isHorizontal) return

      e.preventDefault()
      if (state.family === 'reveal') {
        const next = Math.min(0, Math.max(-REVEAL_WIDTH, state.base + deltaX))
        setDrag(next)
      } else {
        const pulled = deltaX > 0 ? pullWithResistance(deltaX) : 0
        setDrag(Math.max(0, pulled))
      }
    }

    function armClickSuppression() {
      // Any recognized horizontal swipe — reveal or quick-mark, armed or
      // not — was not a tap, so the click that may follow it must never
      // reach the navigating Link.
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
        if (state.family === 'quickmark' && current >= RIGHT_ACTIVATION_DISTANCE) {
          onQuickMarkRef.current(showRef.current)
          setShowSuccessFlash(true)
          if (successTimerRef.current) clearTimeout(successTimerRef.current)
          successTimerRef.current = setTimeout(() => {
            successTimerRef.current = null
            setShowSuccessFlash(false)
          }, SUCCESS_FLASH_DURATION)
        }
      }
      setDrag(null)
    }

    function handleTouchCancel() {
      // A cancelled sequence never activates quick mark and never commits a
      // Remove-reveal state change — it just snaps back to rest.
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

  function handleQuickMarkClick(e) {
    e.preventDefault()
    e.stopPropagation()
    if (isQuickMarking || !quickMarkEpisode) return
    onQuickMark(show)
  }

  const rightSwipePulling = dragX !== null && dragX > 0
  const rightSwipeArmed = rightSwipePulling && dragX >= RIGHT_ACTIVATION_DISTANCE
  const underlayOpacity = rightSwipePulling ? Math.min(1, dragX / RIGHT_ACTIVATION_DISTANCE) : 0

  return (
    <div
      ref={rowRef}
      className="watching-row content-row relative overflow-hidden"
    >
      {quickMarkEpisode && (
        <div
          aria-hidden="true"
          className={`watching-swipe-underlay absolute inset-0${
            rightSwipeArmed ? ' watching-swipe-underlay--armed' : ''
          }`}
          style={{
            opacity: underlayOpacity,
            transition: dragX !== null ? 'none' : 'opacity 200ms ease',
          }}
        />
      )}

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
        data-success-flash={showSuccessFlash ? 'true' : undefined}
        data-swipe-glow={rightSwipeArmed ? 'armed' : rightSwipePulling ? 'pulling' : undefined}
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

        {quickMarkEpisode && (
          <button
            type="button"
            onClick={handleQuickMarkClick}
            disabled={isQuickMarking}
            aria-busy={isQuickMarking}
            // While pending, the row may already have optimistically advanced
            // to the NEXT episode (see Watching.jsx's commitWatched, which
            // runs before the Supabase call resolves) — quickMarkEpisode at
            // that point names the episode after the one actually in flight,
            // so the label must not claim that episode is being marked.
            aria-label={isQuickMarking
              ? `Updating watched status for ${show.name}`
              : `Mark S${quickMarkEpisode.season_number}E${quickMarkEpisode.episode_number} of ${show.name} watched`}
            className="motion-press watching-quick-mark absolute top-1/2 right-1 -translate-y-1/2 disabled:cursor-default"
          >
            <span className="watching-quick-mark__chip">
              <svg
                viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5" fill="none"
                stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="m5 12 4 4L19 6" />
              </svg>
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
