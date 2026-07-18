// Central movement threshold used to decide whether a touch sequence is
// still a stationary press or has become a scroll/swipe. Kept in one place
// so every surface that needs press-activation reasons about the same
// intent.
export const PRESS_MOVE_THRESHOLD = 6

// A touch sequence only becomes visually "pressed" after it has stayed
// under the movement threshold for this long. Short enough that a genuine
// tap still feels immediate; long enough that ordinary scroll/swipe
// initiation crosses the movement threshold before it ever fires.
export const PRESS_ACTIVATE_DELAY = 80

// Attribute toggled on the target `.motion-press` element once the
// activation delay elapses without cancelling movement. This is the *only*
// thing that drives visible touch press feedback (see index.css) — native
// `:active` is neutralized for touch input, because it fires before gesture
// intent is knowable and can't be made scroll-safe.
export const PRESS_ATTR = 'data-pressed'

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

// Tracks exactly one in-flight touch pointer sequence at a time and applies
// PRESS_ATTR once, after `delay` has passed with movement staying under
// `threshold` the whole time. Has no knowledge of CSS classes or DOM
// traversal beyond setAttribute/removeAttribute — callers resolve the
// target element (see findPressableAncestor) and hand it in.
//
// `setTimer`/`clearTimer` are injectable so callers (and tests, via
// vi.useFakeTimers) can control activation timing deterministically.
export function createPressTracker({
  threshold = PRESS_MOVE_THRESHOLD,
  delay = PRESS_ACTIVATE_DELAY,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let pointerId = null
  let element = null
  let startX = 0
  let startY = 0
  let activated = false
  let cancelled = false
  let timerId = null

  function clearPendingTimer() {
    if (timerId !== null) {
      clearTimer(timerId)
      timerId = null
    }
  }

  function activate() {
    timerId = null
    // The sequence may have been cancelled or released between scheduling
    // this callback and it firing; only apply the attribute if it's still
    // a live, uncancelled sequence.
    if (cancelled || pointerId === null || !element) return
    activated = true
    element.setAttribute(PRESS_ATTR, 'true')
  }

  function release() {
    clearPendingTimer()
    if (element && activated) element.removeAttribute(PRESS_ATTR)
    pointerId = null
    element = null
    activated = false
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
      activated = false
      cancelled = false
      timerId = setTimer(activate, delay)
    },
    move(id, x, y) {
      if (id !== pointerId || cancelled || !element) return
      if (exceedsPressThreshold(x - startX, y - startY, threshold)) {
        // Movement beyond the threshold — whether before or after
        // activation — permanently disqualifies this sequence from
        // showing (or continuing to show) pressed feedback. It cannot
        // reactivate before release.
        cancelled = true
        clearPendingTimer()
        if (activated) {
          activated = false
          element.removeAttribute(PRESS_ATTR)
        }
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
    get isActivated() {
      return activated
    },
    get isCancelled() {
      return cancelled
    },
    get trackedElement() {
      return element
    },
    get hasPendingTimer() {
      return timerId !== null
    },
  }
}
