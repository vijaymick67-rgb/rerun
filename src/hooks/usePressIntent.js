import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { createPressTracker, findPressableAncestor } from '../lib/pressIntent'

// Mounted once at the app shell. Delegated pointer listeners replace nothing
// about how press feedback is *applied* (that's still plain CSS `:active`,
// so a genuine tap has zero JS latency) — they only cancel it promptly once
// a touch sequence moves far enough to be a scroll or swipe, which is the
// thing raw `:active` can't do on its own during the start of an iOS scroll.
// Only touch pointers are handled: mouse and pen keep relying on native
// `:active` untouched, and keyboard activation never dispatches pointer
// events at all.
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
