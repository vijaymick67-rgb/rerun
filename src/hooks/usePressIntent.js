import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { createPressTracker, findPressableAncestor } from '../lib/pressIntent'

// Mounted once at the app shell. Delegated pointer listeners are the *only*
// thing that applies visible touch press feedback: native `:active` is
// neutralized for touch input in index.css because it fires immediately on
// finger-down, before gesture intent (tap vs. scroll vs. swipe) is knowable,
// which makes scroll-safe feedback impossible. Instead a touch sequence
// only becomes visually pressed after PRESS_ACTIVATE_DELAY has passed with
// movement staying under the threshold — ordinary scroll/swipe initiation
// crosses the threshold well before that timer fires, so it never shows
// feedback at all. Only touch pointers are handled: mouse/pen keep relying
// on native `:active` via a (hover: hover) and (pointer: fine) media query,
// and keyboard activation never dispatches pointer events at all.
export default function usePressIntent() {
  const trackerRef = useRef(null)
  if (!trackerRef.current) trackerRef.current = createPressTracker()
  const { pathname } = useLocation()

  useEffect(() => {
    trackerRef.current.reset()
  }, [pathname])

  useEffect(() => {
    const tracker = trackerRef.current

    function onPointerDown(e) {
      if (e.pointerType !== 'touch') return
      const target = findPressableAncestor(e.target)
      if (!target) return
      tracker.down(e.pointerId, target, e.clientX, e.clientY)
    }

    function onPointerMove(e) {
      if (e.pointerType !== 'touch') return
      tracker.move(e.pointerId, e.clientX, e.clientY)
    }

    function onPointerUp(e) {
      if (e.pointerType !== 'touch') return
      tracker.up(e.pointerId)
    }

    function onPointerCancel(e) {
      if (e.pointerType !== 'touch') return
      tracker.cancel(e.pointerId)
    }

    function onWindowBlur() {
      tracker.reset()
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
      tracker.reset()
    }
  }, [])
}
