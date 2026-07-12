import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { POSTER_BASE } from '../lib/tmdb'

const REVEAL_WIDTH = 84
const DRAG_THRESHOLD = 6

export default function WatchingRow({ show, isRemoving, isOpen, onOpenChange, onRemove }) {
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
    }
  }

  return (
    <div
      ref={rowRef}
      className="watching-row relative overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface)"
    >
      <button
        type="button"
        onClick={() => onRemove(show)}
        disabled={isRemoving}
        aria-label={`Remove ${show.name}`}
        className="absolute inset-y-0 right-0 flex w-[84px] items-center justify-center bg-red-500/90 text-sm font-medium text-white disabled:opacity-60"
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
          className="flex flex-1 items-center gap-3 text-left"
        >
          {show.poster_path ? (
            <img
              src={POSTER_BASE + show.poster_path}
              alt={show.name}
              className="h-24 w-16 shrink-0 rounded-md object-cover"
            />
          ) : (
            <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded-md bg-(--color-surface-raised) text-xs text-(--color-text-muted)">
              No poster
            </div>
          )}

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-(--color-text)">{show.name}</p>

            {show.nextUp ? (
              <p className="mt-1 text-xs text-(--color-accent)">
                Up next: S{show.nextUp.season_number}E{show.nextUp.episode_number}
                {show.nextUp.name ? ` · ${show.nextUp.name}` : ''}
              </p>
            ) : show.loadError ? (
              <p className="mt-1 text-xs text-red-400">Couldn't load episodes</p>
            ) : (
              <p className="mt-1 text-xs text-(--color-text-muted)">Caught up</p>
            )}
          </div>

          <span aria-hidden="true" className="watching-row-chevron shrink-0 text-(--color-text-muted)">
            ›
          </span>
        </Link>

        <button
          type="button"
          onClick={() => onRemove(show)}
          disabled={isRemoving}
          aria-label={`Remove ${show.name}`}
          className="watching-row-hover-remove absolute top-1/2 right-3 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-(--color-text-muted) hover:text-red-400 disabled:opacity-60"
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
      </div>
    </div>
  )
}
