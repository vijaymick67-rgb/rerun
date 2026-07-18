// Central movement threshold used to decide whether a touch sequence is
// still a stationary press or has become a scroll/swipe. Kept in one place
// so every surface that needs press classification reasons about the same
// intent.
export const PRESS_MOVE_THRESHOLD = 6

// A touch sequence only counts as a "tap" if it's released within this long
// of touching down. Held past this, a stationary finger is a long press —
// which must never show shrink/dim feedback and must never affect native
// long-press/context-menu/link-preview behavior (we never preventDefault on
// touchstart/touchmove/pointerdown, so the browser's own long-press handling
// is untouched regardless of this constant).
export const PRESS_TAP_MAX_DURATION = 500

// How long a classified tap's shrink feedback stays visible before it's
// auto-cleared. Applies to every `.motion-press` element (buttons included),
// not just navigation links.
export const PRESS_FEEDBACK_HOLD = 120

// How long a navigating tap waits, after the shrink is applied, before the
// actual route change fires — long enough that the shrink has visibly
// painted, short enough that navigation still feels immediate rather than
// delayed. Kept separate from PRESS_FEEDBACK_HOLD because the two express
// different things: how long feedback lingers vs. how long navigation waits.
export const PRESS_NAV_DELAY = 80

// Attribute toggled on the target `.motion-press` element once a touch
// sequence is classified, at release, as a genuine tap. This is the *only*
// thing that drives visible touch press feedback (see index.css) — native
// `:active` is neutralized for touch input, because it fires before gesture
// intent (tap vs. scroll vs. swipe vs. long press) is knowable at all.
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

// Tracks exactly one in-flight touch pointer sequence at a time. Unlike an
// activate-on-hold model, nothing visual happens until release: `up()` is
// the single place that classifies the completed gesture and, only for a
// genuine tap (no meaningful movement, released within PRESS_TAP_MAX_DURATION),
// applies PRESS_ATTR. A long, stationary hold never activates anything —
// there is nothing pending to cancel — and a scroll/swipe that crosses the
// movement threshold is disqualified the moment it happens, before release.
//
// `now`, `setTimer`/`clearTimer` are injectable so callers (and tests, via
// vi.useFakeTimers or a manual clock) can control timing deterministically.
export function createPressTracker({
  threshold = PRESS_MOVE_THRESHOLD,
  tapMaxDuration = PRESS_TAP_MAX_DURATION,
  feedbackHold = PRESS_FEEDBACK_HOLD,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let pointerId = null
  let element = null
  let startX = 0
  let startY = 0
  let startTime = 0
  let moved = false

  let feedbackElement = null
  let feedbackTimer = null

  // A short-lived ticket recording the element a tap was just classified
  // valid for. The click event that immediately follows a real touch tap
  // (in the same synchronous dispatch sequence, well before any new
  // pointerdown could occur) consumes it via consumeValidTap — that's how a
  // navigating Link knows to delay its own navigation instead of firing
  // immediately. Never touched by mouse or keyboard activation, since those
  // never call down()/up() at all.
  let pendingTap = null

  function clearFeedbackTimer() {
    if (feedbackTimer !== null) {
      clearTimer(feedbackTimer)
      feedbackTimer = null
    }
  }

  function applyFeedback(target) {
    clearFeedbackTimer()
    if (feedbackElement && feedbackElement !== target) {
      feedbackElement.removeAttribute(PRESS_ATTR)
    }
    feedbackElement = target
    target.setAttribute(PRESS_ATTR, 'true')
    feedbackTimer = setTimer(() => {
      feedbackTimer = null
      if (feedbackElement === target) {
        target.removeAttribute(PRESS_ATTR)
        feedbackElement = null
      }
    }, feedbackHold)
  }

  function clearFeedbackNow() {
    clearFeedbackTimer()
    if (feedbackElement) {
      feedbackElement.removeAttribute(PRESS_ATTR)
      feedbackElement = null
    }
  }

  function resetTracking() {
    pointerId = null
    element = null
    moved = false
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
      startTime = now()
      moved = false
      pendingTap = null
    },
    move(id, x, y) {
      if (id !== pointerId || moved) return
      if (exceedsPressThreshold(x - startX, y - startY, threshold)) {
        // Movement beyond the threshold permanently disqualifies this
        // sequence from ever producing tap feedback, whether it's a scroll
        // or a Watching-row swipe. Nothing has been applied yet (feedback
        // only ever happens at release), so there is nothing to undo.
        moved = true
      }
    },
    up(id) {
      if (id !== pointerId) return false
      const target = element
      const duration = now() - startTime
      const isValidTap = !moved && !!target && duration <= tapMaxDuration
      resetTracking()
      if (!isValidTap) return false
      applyFeedback(target)
      pendingTap = target
      return true
    },
    cancel(id) {
      if (id !== pointerId) return
      resetTracking()
    },
    // Full reset for route change / blur / unmount: drops any in-progress
    // pointer tracking, clears lingering visible feedback immediately, and
    // invalidates any unconsumed tap ticket.
    reset() {
      resetTracking()
      clearFeedbackNow()
      pendingTap = null
    },
    // Consumed by a navigating Link's onClick to check whether this click is
    // the direct result of a touch tap just classified valid on this exact
    // element. Returns true at most once per tap.
    consumeValidTap(target) {
      if (pendingTap !== null && pendingTap === target) {
        pendingTap = null
        return true
      }
      return false
    },
    isTracking(id) {
      return id === pointerId
    },
    get isMoved() {
      return moved
    },
    get hasFeedback() {
      return feedbackElement !== null
    },
    get feedbackElement() {
      return feedbackElement
    },
    get hasPendingTap() {
      return pendingTap !== null
    },
  }
}

// Single shared tracker for the whole app: mounted once by usePressIntent
// (see src/hooks/usePressIntent.js) and read by any navigating Link's tap
// handler (see handleTapNavigateClick below), so both sides observe the same
// classification for the same touch sequence.
export const pressTracker = createPressTracker()

// Shared onClick handler for `.motion-press` <Link> elements whose target
// route can hide or unmount the tapped element as soon as navigation
// starts (e.g. WatchingRow's persistent list, hidden via display:none the
// instant a detail route is entered). Only touch taps that pressTracker just
// classified as valid are affected: preventDefault + a short delay so the
// shrink feedback has time to paint before the route actually changes.
// Mouse clicks and keyboard activation never produce a pendingTap, so they
// fall straight through to react-router's normal, immediate Link navigation.
export function handleTapNavigateClick(
  e,
  navigate,
  to,
  { delay = PRESS_NAV_DELAY, setTimer = (fn, ms) => setTimeout(fn, ms) } = {},
) {
  if (!pressTracker.consumeValidTap(e.currentTarget)) return
  e.preventDefault()
  setTimer(() => navigate(to), delay)
}
