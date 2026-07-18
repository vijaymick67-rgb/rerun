import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { findPressableAncestor, pressTracker } from '../lib/pressIntent'

// Mounted once at the app shell. Delegated pointer listeners are the *only*
// thing that applies visible touch press feedback: native `:active` is
// neutralized for touch input in index.css because it fires immediately on
// finger-down, before gesture intent (tap vs. scroll vs. swipe vs. long
// press) is knowable at all. Instead, a touch sequence is classified only at
// release (see pressTracker.up in ../lib/pressIntent): movement past the
// threshold at any point, or a hold longer than PRESS_TAP_MAX_DURATION,
// disqualifies it from ever showing feedback: scroll/swipe never flashes,
// and a long stationary press never shrinks either, since nothing is applied
// until — and unless — release proves it was a genuine tap. Only touch
// pointers are handled: mouse/pen keep relying on native `:active` via a
// (hover: hover) and (pointer: fine) media query, and keyboard activation
// never dispatches pointer events at all.
export default function usePressIntent() {
  const { pathname } = useLocation()

  useEffect(() => {
    pressTracker.reset()
  }, [pathname])

  useEffect(() => {
    function onPointerDown(e) {
      if (e.pointerType !== 'touch') return
      const target = findPressableAncestor(e.target)
      if (!target) return
      pressTracker.down(e.pointerId, target, e.clientX, e.clientY)
    }

    function onPointerMove(e) {
      if (e.pointerType !== 'touch') return
      pressTracker.move(e.pointerId, e.clientX, e.clientY)
    }

    function onPointerUp(e) {
      if (e.pointerType !== 'touch') return
      pressTracker.up(e.pointerId)
    }

    function onPointerCancel(e) {
      if (e.pointerType !== 'touch') return
      pressTracker.cancel(e.pointerId)
    }

    function onWindowBlur() {
      pressTracker.reset()
    }

    document.addEventListener('pointerdown', onPointerDown, { passive: true })
    document.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerup', onPointerUp, { passive: true })
    document.addEventListener('pointercancel', onPointerCancel, { passive: true })
    window.addEventListener('blur', onWindowBlur)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('blur', onWindowBlur)
      pressTracker.reset()
    }
  }, [])
}
