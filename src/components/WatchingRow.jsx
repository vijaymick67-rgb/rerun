import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { POSTER_BASE } from '../lib/tmdb'
import { watchingStatusLabel } from '../lib/watchHelpers'
import { handleTapNavigateClick } from '../lib/pressIntent'
import ProgressiveImage from './ProgressiveImage'

const REVEAL_WIDTH = 84
const DRAG_THRESHOLD = 6

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

  const baseX = isOpen ? -REVEAL_WIDTH : 0
  const translateX = dragX !== null ? dragX : baseX

  function setDrag(value) {
    dragXRef.current = value
    setDragX(value)
  }

  useEffect(() => {
    const el = frontRef.current
    if (!el) return

    function handleTouchStart(e) {
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
        state.isHorizontal = Math.abs(deltaX) > Math.abs(deltaY)
      }
      if (!state.isHorizontal) return

      e.preventDefault()
      const next = Math.min(0, Math.max(-REVEAL_WIDTH, state.base + deltaX))
      setDrag(next)
    }

    function handleTouchEnd() {
      const state = dragState.current
      dragState.current = null
      if (state && state.isHorizontal) {
        const current = dragXRef.current !== null ? dragXRef.current : state.base
        const shouldOpen = current < -REVEAL_WIDTH / 2
        onOpenChange(shouldOpen ? show.id : null)
      }
      setDrag(null)
    }

    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
    el.addEventListener('touchend', handleTouchEnd, { passive: true })
    el.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    return () => {
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
      el.removeEventListener('touchcancel', handleTouchEnd)
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
    if (isOpen) {
      e.preventDefault()
      onOpenChange(null)
      return
    }
    handleTapNavigateClick(e, navigate, `/watching/${show.tmdb_id}`)
  }

  // A cached row can render nextReleasedUnwatchedEpisode long before this
  // load's mutation context for it is ready (see Watching.jsx's
  // readyShowIds) — the control must not appear tappable in that window,
  // since tapping it before context exists would silently do nothing.
  const quickMarkEpisode = canQuickMark ? (show.nextReleasedUnwatchedEpisode ?? null) : null
  const showProgressBar = (show.releasedEpisodeCount ?? 0) > 0 &&
    (show.releasedWatchedCount ?? 0) < (show.releasedEpisodeCount ?? 0)

  function handleQuickMarkClick(e) {
    e.preventDefault()
    e.stopPropagation()
    if (isQuickMarking || !quickMarkEpisode) return
    onQuickMark(show)
  }

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
        className="relative flex touch-pan-y gap-3 bg-(--color-surface) p-3"
        style={{
          transform: `translateX(${translateX}px)`,
          transition: dragX !== null ? 'none' : 'transform 200ms ease',
        }}
      >
        <Link
          to={`/watching/${show.tmdb_id}`}
          onClick={handleLinkClick}
          className="motion-press flex min-w-0 flex-1 items-center gap-3 pr-14 text-left"
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
