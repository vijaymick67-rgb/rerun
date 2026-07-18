// Central movement threshold used to decide whether a touch sequence is
// still a tap or has become a scroll/swipe. Kept in one place so every
// surface that needs press-cancellation reasons about the same intent.
export const PRESS_MOVE_THRESHOLD = 6

// Attribute toggled on the pressed `.motion-press` element when a touch
// sequence crosses the threshold. See index.css: a same-specificity
// `:active` override resets scale/opacity while the finger is still down,
// which is what actually cancels the stuck-`:active`-during-scroll look on
// iOS Safari. Native `:active` continues to drive the immediate tap feel.
export const PRESS_CANCEL_ATTR = 'data-press-cancelled'

export function exceedsPressThreshold(dx, dy, threshold = PRESS_MOVE_THRESHOLD) {
  return Math.abs(dx) > threshold || Math.abs(dy) > threshold
}

// Duck-typed on classList/disabled/getAttribute so this is testable with
// plain mock objects instead of a real DOM.
export function isPressable(el) {
  if (!el || !el.classList || typeof el.classList.contains !== 'function') return false
  if (!el.classList.contains('motion-press')) return false
  if (el.disabled) return false
  if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false
  return true
}

// Walks from the touch target up through ancestors to find the element that
// should receive press feedback. Overlay controls (e.g. a three-dot button
// sitting over a poster Link) are siblings, not ancestors, of the thing
// underneath them, so this naturally resolves to the actual touched control
// without ever reaching for the surrounding card.
export function findPressableAncestor(el) {
  let node = el
  while (node) {
    if (isPressable(node)) return node
    node = node.parentElement ?? null
  }
  return null
}

// Tracks exactly one in-flight touch pointer sequence at a time and flips
// PRESS_CANCEL_ATTR on/off as movement crosses the intent threshold. Has no
// knowledge of CSS classes or DOM traversal — callers resolve the target
// element (see findPressableAncestor) and hand it in.
export function createPressTracker({ threshold = PRESS_MOVE_THRESHOLD } = {}) {
  let pointerId = null
  let element = null
  let startX = 0
  let startY = 0
  let cancelled = false

  function release() {
    if (element) element.removeAttribute(PRESS_CANCEL_ATTR)
    pointerId = null
    element = null
    cancelled = false
  }

  return {
    down(id, target, x, y) {
      // A second concurrent pointer must never steal or clear the first
      // pointer's tracked state.
      if (pointerId !== null) return
      pointerId = id
      element = target
      startX = x
      startY = y
      cancelled = false
    },
    move(id, x, y) {
      if (id !== pointerId || cancelled || !element) return
      if (exceedsPressThreshold(x - startX, y - startY, threshold)) {
        cancelled = true
        element.setAttribute(PRESS_CANCEL_ATTR, 'true')
      }
    },
    up(id) {
      if (id !== pointerId) return
      release()
    },
    cancel(id) {
      if (id !== pointerId) return
      release()
    },
    reset: release,
    isTracking(id) {
      return id === pointerId
    },
    get isCancelled() {
      return cancelled
    },
    get trackedElement() {
      return element
    },
  }
}
