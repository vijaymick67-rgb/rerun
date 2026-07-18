import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PRESS_ATTR,
  PRESS_FEEDBACK_HOLD,
  PRESS_MOVE_THRESHOLD,
  PRESS_NAV_DELAY,
  PRESS_TAP_MAX_DURATION,
  createPressTracker,
  exceedsPressThreshold,
  findPressableAncestor,
  handleTapNavigateClick,
  isPressable,
  pressTracker,
} from './pressIntent'

function fakeElement({ classes = [], disabled = false, ariaDisabled = null, parentElement = null } = {}) {
  const attrs = new Map()
  return {
    classList: { contains: (c) => classes.includes(c) },
    disabled,
    parentElement,
    getAttribute: (name) => {
      if (name === 'aria-disabled') return ariaDisabled
      return attrs.get(name) ?? null
    },
    setAttribute: vi.fn((name, value) => attrs.set(name, value)),
    removeAttribute: vi.fn((name) => attrs.delete(name)),
    hasAttribute: (name) => attrs.has(name),
  }
}

describe('exceedsPressThreshold', () => {
  it('does not cancel for tiny stationary jitter', () => {
    expect(exceedsPressThreshold(1, -2)).toBe(false)
    expect(exceedsPressThreshold(PRESS_MOVE_THRESHOLD, PRESS_MOVE_THRESHOLD)).toBe(false)
  })

  it('cancels once vertical movement crosses the threshold', () => {
    expect(exceedsPressThreshold(0, PRESS_MOVE_THRESHOLD + 1)).toBe(true)
  })

  it('cancels once horizontal movement crosses the threshold', () => {
    expect(exceedsPressThreshold(PRESS_MOVE_THRESHOLD + 1, 0)).toBe(true)
  })
})

describe('isPressable / findPressableAncestor', () => {
  it('an eligible motion-press element is pressable', () => {
    const el = fakeElement({ classes: ['motion-press'] })
    expect(isPressable(el)).toBe(true)
    expect(findPressableAncestor(el)).toBe(el)
  })

  it('a native-disabled control is never pressable', () => {
    const el = fakeElement({ classes: ['motion-press'], disabled: true })
    expect(isPressable(el)).toBe(false)
    expect(findPressableAncestor(el)).toBe(null)
  })

  it('an aria-disabled control is never pressable', () => {
    const el = fakeElement({ classes: ['motion-press'], ariaDisabled: 'true' })
    expect(isPressable(el)).toBe(false)
    expect(findPressableAncestor(el)).toBe(null)
  })

  it('resolves a nested tap (e.g. an svg icon) to its motion-press ancestor', () => {
    const button = fakeElement({ classes: ['motion-press'] })
    const icon = fakeElement({ parentElement: button })
    expect(findPressableAncestor(icon)).toBe(button)
  })

  it('an overlay control never resolves to a sibling card underneath it', () => {
    // Overlay button and card Link are siblings under a shared wrapper, not
    // ancestor/descendant, so a tap on the overlay's icon must resolve only
    // to the overlay button itself (e.g. the Stats poster three-dot menu).
    const cardLink = fakeElement({ classes: ['motion-press'] })
    const wrapper = fakeElement({ parentElement: null })
    const overlayButton = fakeElement({ classes: ['motion-press'], parentElement: wrapper })
    const overlayIcon = fakeElement({ parentElement: overlayButton })
    void cardLink

    expect(findPressableAncestor(overlayIcon)).toBe(overlayButton)
  })

  it('returns null when no ancestor is pressable', () => {
    const root = fakeElement({ parentElement: null })
    const leaf = fakeElement({ parentElement: root })
    expect(findPressableAncestor(leaf)).toBe(null)
  })
})

// The tracker classifies a touch sequence only at release: nothing visual
// happens on down or during movement, so a manually-controlled clock lets
// each test drive exact hold durations across the PRESS_TAP_MAX_DURATION
// boundary deterministically, without depending on real wall-clock time.
describe('createPressTracker: release-time tap classification', () => {
  let clockNow

  function makeTracker(overrides = {}) {
    return createPressTracker({ now: () => clockNow, ...overrides })
  }

  beforeEach(() => {
    clockNow = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pointer down applies no visible feedback at all', () => {
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    expect(tracker.isTracking(1)).toBe(true)
    expect(el.setAttribute).not.toHaveBeenCalled()
    expect(tracker.hasFeedback).toBe(false)
  })

  it('a quick, stationary tap applies feedback only at release', () => {
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    clockNow += 40
    expect(el.setAttribute).not.toHaveBeenCalled()

    const wasValid = tracker.up(1)
    expect(wasValid).toBe(true)
    expect(el.setAttribute).toHaveBeenCalledWith(PRESS_ATTR, 'true')
    expect(tracker.hasFeedback).toBe(true)
  })

  it('a released-immediately tap (near-zero hold time) still shows feedback', () => {
    // Regression: the previous hold-timer model missed quick taps entirely
    // because release could beat the activation delay.
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    expect(tracker.up(1)).toBe(true)
    expect(el.setAttribute).toHaveBeenCalledWith(PRESS_ATTR, 'true')
  })

  it('feedback auto-clears after PRESS_FEEDBACK_HOLD', () => {
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.up(1)

    vi.advanceTimersByTime(PRESS_FEEDBACK_HOLD - 1)
    expect(el.removeAttribute).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(el.removeAttribute).toHaveBeenCalledWith(PRESS_ATTR)
    expect(tracker.hasFeedback).toBe(false)
  })

  it('sub-threshold jitter does not disqualify a tap', () => {
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 100, 100)
    tracker.move(1, 102, 101)
    expect(tracker.up(1)).toBe(true)
    expect(el.setAttribute).toHaveBeenCalledWith(PRESS_ATTR, 'true')
  })

  it('vertical movement beyond the threshold disqualifies the tap: no feedback at release (scroll)', () => {
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 100, 100)
    tracker.move(1, 100, 100 + PRESS_MOVE_THRESHOLD + 5)
    expect(tracker.isMoved).toBe(true)
    expect(tracker.up(1)).toBe(false)
    expect(el.setAttribute).not.toHaveBeenCalled()
  })

  it('horizontal movement beyond the threshold disqualifies the tap: no feedback at release (Watching-row swipe)', () => {
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 100, 100)
    tracker.move(1, 100 + PRESS_MOVE_THRESHOLD + 5, 100)
    expect(tracker.up(1)).toBe(false)
    expect(el.setAttribute).not.toHaveBeenCalled()
  })

  it('movement is permanent for the sequence: drifting back under the threshold does not requalify it', () => {
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.move(1, 0, PRESS_MOVE_THRESHOLD + 5)
    tracker.move(1, 0, 0)
    expect(tracker.up(1)).toBe(false)
    expect(el.setAttribute).not.toHaveBeenCalled()
  })

  // PRESS_TAP_MAX_DURATION is the exact tap/long-press boundary: released at
  // or before it is a tap (inclusive), released any later is a long press.
  // Each case below drives the hold duration to a precise millisecond so the
  // boundary itself — not just "short" vs. "long" — is pinned down.
  describe('tap vs. long-press boundary at PRESS_TAP_MAX_DURATION', () => {
    it('qualifies just below the cutoff', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      tracker.down(1, el, 0, 0)
      clockNow += PRESS_TAP_MAX_DURATION - 1
      expect(tracker.up(1)).toBe(true)
      expect(el.setAttribute).toHaveBeenCalledWith(PRESS_ATTR, 'true')
    })

    it('qualifies exactly at the cutoff (inclusive)', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      tracker.down(1, el, 0, 0)
      clockNow += PRESS_TAP_MAX_DURATION
      expect(tracker.up(1)).toBe(true)
      expect(el.setAttribute).toHaveBeenCalledWith(PRESS_ATTR, 'true')
    })

    it('disqualifies just above the cutoff — this is a long press', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      tracker.down(1, el, 0, 0)
      clockNow += PRESS_TAP_MAX_DURATION + 1
      expect(tracker.up(1)).toBe(false)
      expect(el.setAttribute).not.toHaveBeenCalled()
      expect(tracker.hasFeedback).toBe(false)
    })

    it('a 500ms release never qualifies as a tap, regardless of the exact cutoff value', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      tracker.down(1, el, 0, 0)
      clockNow += 500
      expect(tracker.up(1)).toBe(false)
      expect(el.setAttribute).not.toHaveBeenCalled()
      expect(tracker.hasFeedback).toBe(false)
      expect(tracker.hasPendingTap).toBe(false)
    })
  })

  it('pointer cancel never applies feedback, however long or short the hold', () => {
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    clockNow += 40
    tracker.cancel(1)
    expect(el.setAttribute).not.toHaveBeenCalled()
    expect(tracker.isTracking(1)).toBe(false)
  })

  it('reset() clears in-progress tracking and applies no feedback', () => {
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.reset()
    clockNow += PRESS_TAP_MAX_DURATION * 4
    expect(tracker.up(1)).toBe(false)
    expect(el.setAttribute).not.toHaveBeenCalled()
    expect(tracker.isTracking(1)).toBe(false)
  })

  it('reset() immediately clears already-visible feedback (route change / blur / unmount)', () => {
    const tracker = makeTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.up(1)
    expect(tracker.hasFeedback).toBe(true)

    tracker.reset()
    expect(el.removeAttribute).toHaveBeenCalledWith(PRESS_ATTR)
    expect(tracker.hasFeedback).toBe(false)

    // The pending auto-clear timer from up() must not fire a second,
    // redundant removeAttribute after reset() already cleared it.
    el.removeAttribute.mockClear()
    vi.advanceTimersByTime(PRESS_FEEDBACK_HOLD * 4)
    expect(el.removeAttribute).not.toHaveBeenCalled()
  })

  it('a second concurrent pointer cannot steal or corrupt the first pointer\'s tracked sequence', () => {
    const tracker = makeTracker()
    const elA = fakeElement({ classes: ['motion-press'] })
    const elB = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, elA, 0, 0)
    tracker.down(2, elB, 0, 0) // ignored: pointer 1 already active
    expect(tracker.isTracking(1)).toBe(true)

    tracker.move(2, 0, 50) // pointer B was never tracked, so this is a no-op
    expect(tracker.up(1)).toBe(true)
    expect(elA.setAttribute).toHaveBeenCalledWith(PRESS_ATTR, 'true')
    expect(elB.setAttribute).not.toHaveBeenCalled()

    tracker.up(2) // pointer B releasing must not touch pointer A's state
    expect(tracker.hasFeedback).toBe(true)
    expect(tracker.feedbackElement).toBe(elA)
  })

  it('never applies feedback to a disabled or aria-disabled target resolved via findPressableAncestor', () => {
    const disabledEl = fakeElement({ classes: ['motion-press'], disabled: true })
    const ariaDisabledEl = fakeElement({ classes: ['motion-press'], ariaDisabled: 'true' })
    expect(findPressableAncestor(disabledEl)).toBe(null)
    expect(findPressableAncestor(ariaDisabledEl)).toBe(null)
  })

  describe('consumeValidTap', () => {
    it('is true exactly once for the element a tap was just classified valid on', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      tracker.down(1, el, 0, 0)
      tracker.up(1)
      expect(tracker.hasPendingTap).toBe(true)
      expect(tracker.consumeValidTap(el)).toBe(true)
      expect(tracker.consumeValidTap(el)).toBe(false)
      expect(tracker.hasPendingTap).toBe(false)
    })

    it('is false for a different element than the one just tapped', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      const other = fakeElement({ classes: ['motion-press'] })
      tracker.down(1, el, 0, 0)
      tracker.up(1)
      expect(tracker.consumeValidTap(other)).toBe(false)
    })

    it('is false when nothing was ever tapped (e.g. a mouse click or keyboard activation)', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      expect(tracker.consumeValidTap(el)).toBe(false)
    })

    it('is false after a scroll/swipe-disqualified release', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      tracker.down(1, el, 0, 0)
      tracker.move(1, 0, PRESS_MOVE_THRESHOLD + 5)
      tracker.up(1)
      expect(tracker.consumeValidTap(el)).toBe(false)
    })

    it('is false after a long press', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      tracker.down(1, el, 0, 0)
      clockNow += PRESS_TAP_MAX_DURATION + 1
      tracker.up(1)
      expect(tracker.consumeValidTap(el)).toBe(false)
    })

    it('is invalidated by reset() (route change / blur / unmount)', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      tracker.down(1, el, 0, 0)
      tracker.up(1)
      tracker.reset()
      expect(tracker.consumeValidTap(el)).toBe(false)
    })

    it('is invalidated by the next pointer down, even on the same element', () => {
      const tracker = makeTracker()
      const el = fakeElement({ classes: ['motion-press'] })
      tracker.down(1, el, 0, 0)
      tracker.up(1)
      tracker.down(2, el, 10, 10)
      expect(tracker.consumeValidTap(el)).toBe(false)
    })
  })

  describe('scheduleNavigation / cancelPendingNavigation', () => {
    it('runs the scheduled callback after the delay, exactly once', () => {
      const tracker = makeTracker()
      const run = vi.fn()
      tracker.scheduleNavigation(run, 80)
      expect(tracker.hasPendingNavigation).toBe(true)
      expect(run).not.toHaveBeenCalled()

      vi.advanceTimersByTime(79)
      expect(run).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(run).toHaveBeenCalledTimes(1)
      expect(tracker.hasPendingNavigation).toBe(false)
    })

    it('cancelPendingNavigation stops it from ever firing', () => {
      const tracker = makeTracker()
      const run = vi.fn()
      tracker.scheduleNavigation(run, 80)
      tracker.cancelPendingNavigation()
      expect(tracker.hasPendingNavigation).toBe(false)

      vi.advanceTimersByTime(1000)
      expect(run).not.toHaveBeenCalled()
    })

    it('a second scheduleNavigation call cancels/replaces the first — only the latest ever fires', () => {
      const tracker = makeTracker()
      const first = vi.fn()
      const second = vi.fn()
      tracker.scheduleNavigation(first, 80)
      tracker.scheduleNavigation(second, 80)

      vi.advanceTimersByTime(80)
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledTimes(1)
    })

    it('reset() cancels a pending navigation (route change / blur / unmount all call reset())', () => {
      const tracker = makeTracker()
      const run = vi.fn()
      tracker.scheduleNavigation(run, 80)

      tracker.reset()
      expect(tracker.hasPendingNavigation).toBe(false)

      vi.advanceTimersByTime(1000)
      expect(run).not.toHaveBeenCalled()
    })

    it('a completed navigation does not linger as "pending" for a later reset() to act on', () => {
      const tracker = makeTracker()
      const run = vi.fn()
      tracker.scheduleNavigation(run, 80)
      vi.advanceTimersByTime(80)
      expect(run).toHaveBeenCalledTimes(1)

      // reset() firing afterwards (e.g. the route-change effect that the
      // navigate() call itself triggered) must be a harmless no-op here.
      expect(() => tracker.reset()).not.toThrow()
      vi.advanceTimersByTime(1000)
      expect(run).toHaveBeenCalledTimes(1)
    })
  })
})

// handleTapNavigateClick always reads the module's shared `pressTracker`
// singleton (the same one usePressIntent drives via real pointer events), so
// these tests drive that singleton directly through down/up rather than a
// fresh createPressTracker() instance.
describe('handleTapNavigateClick', () => {
  function fakeClickEvent(currentTarget) {
    return { currentTarget, preventDefault: vi.fn() }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    pressTracker.reset()
  })

  afterEach(() => {
    // reset() also cancels any pending navigation left over from a test
    // that intentionally never let one fire, so a stray timer can't leak
    // into a later test.
    pressTracker.reset()
    vi.useRealTimers()
  })

  it('lets the click through untouched when no touch tap was classified (mouse/keyboard)', () => {
    const el = fakeElement({ classes: ['motion-press'] })
    const navigate = vi.fn()
    const event = fakeClickEvent(el)

    handleTapNavigateClick(event, navigate, '/watching/1', { setTimer: vi.fn() })

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('prevents default and navigates after the delay when the click follows a valid touch tap', () => {
    const el = fakeElement({ classes: ['motion-press'] })
    pressTracker.down(1, el, 0, 0)
    pressTracker.up(1)

    const navigate = vi.fn()
    const setTimer = vi.fn((fn) => fn())
    const event = fakeClickEvent(el)

    handleTapNavigateClick(event, navigate, '/watching/42', { setTimer })

    expect(event.preventDefault).toHaveBeenCalled()
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), PRESS_NAV_DELAY)
    expect(navigate).toHaveBeenCalledWith('/watching/42')
  })

  it('does not navigate for a click that does not match the pending tap', () => {
    const el = fakeElement({ classes: ['motion-press'] })
    const other = fakeElement({ classes: ['motion-press'] })
    pressTracker.down(1, el, 0, 0)
    pressTracker.up(1)

    const navigate = vi.fn()
    const event = fakeClickEvent(other)
    handleTapNavigateClick(event, navigate, '/watching/1', { setTimer: vi.fn() })

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not navigate twice for the same tap (ticket is consumed once)', () => {
    const el = fakeElement({ classes: ['motion-press'] })
    pressTracker.down(1, el, 0, 0)
    pressTracker.up(1)

    const navigate = vi.fn()
    const setTimer = vi.fn((fn) => fn())
    handleTapNavigateClick(fakeClickEvent(el), navigate, '/watching/1', { setTimer })
    handleTapNavigateClick(fakeClickEvent(el), navigate, '/watching/1', { setTimer })

    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('respects a custom delay override', () => {
    const el = fakeElement({ classes: ['motion-press'] })
    pressTracker.down(1, el, 0, 0)
    pressTracker.up(1)

    const navigate = vi.fn()
    const setTimer = vi.fn((fn) => fn())
    handleTapNavigateClick(fakeClickEvent(el), navigate, '/watching/1', { delay: 50, setTimer })

    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 50)
  })

  it('navigates exactly once, ~80ms (PRESS_NAV_DELAY) after the tap — the paintable feedback window', () => {
    // No injected setTimer here: this exercises the tracker's real default
    // timer under vi.useFakeTimers(), so the delay itself is verified, not
    // just that *some* timer function was called.
    const el = fakeElement({ classes: ['motion-press'] })
    pressTracker.down(1, el, 0, 0)
    pressTracker.up(1)
    expect(pressTracker.hasFeedback).toBe(true) // shrink is already visible

    const navigate = vi.fn()
    handleTapNavigateClick(fakeClickEvent(el), navigate, '/watching/42')

    expect(navigate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PRESS_NAV_DELAY - 1)
    expect(navigate).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/watching/42')
  })

  it('a route change (pressTracker.reset()) before the delay elapses cancels the pending navigation', () => {
    const el = fakeElement({ classes: ['motion-press'] })
    pressTracker.down(1, el, 0, 0)
    pressTracker.up(1)

    const navigate = vi.fn()
    handleTapNavigateClick(fakeClickEvent(el), navigate, '/watching/42')
    expect(pressTracker.hasPendingNavigation).toBe(true)

    // usePressIntent calls pressTracker.reset() on route change, window
    // blur, and app-shell unmount alike — all three share this one path.
    pressTracker.reset()
    expect(pressTracker.hasPendingNavigation).toBe(false)

    vi.advanceTimersByTime(PRESS_NAV_DELAY * 4)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('window blur (also pressTracker.reset()) cancels a pending navigation the same way', () => {
    const el = fakeElement({ classes: ['motion-press'] })
    pressTracker.down(1, el, 0, 0)
    pressTracker.up(1)

    const navigate = vi.fn()
    handleTapNavigateClick(fakeClickEvent(el), navigate, '/watching/42')

    pressTracker.reset() // usePressIntent's onWindowBlur handler
    vi.advanceTimersByTime(PRESS_NAV_DELAY * 4)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('app-shell unmount (also pressTracker.reset(), via usePressIntent\'s cleanup) cancels a pending navigation', () => {
    const el = fakeElement({ classes: ['motion-press'] })
    pressTracker.down(1, el, 0, 0)
    pressTracker.up(1)

    const navigate = vi.fn()
    handleTapNavigateClick(fakeClickEvent(el), navigate, '/watching/42')

    pressTracker.reset() // usePressIntent's effect cleanup on unmount
    vi.advanceTimersByTime(PRESS_NAV_DELAY * 4)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('a second confirmed tap cancels/replaces a still-pending first navigation', () => {
    const first = fakeElement({ classes: ['motion-press'] })
    const second = fakeElement({ classes: ['motion-press'] })

    pressTracker.down(1, first, 0, 0)
    pressTracker.up(1)
    const navigate = vi.fn()
    handleTapNavigateClick(fakeClickEvent(first), navigate, '/watching/1')

    // A second tap completes (e.g. the user backed out and tapped another
    // card) before the first navigation's delay elapsed.
    pressTracker.down(2, second, 0, 0)
    pressTracker.up(2)
    handleTapNavigateClick(fakeClickEvent(second), navigate, '/watching/2')

    vi.advanceTimersByTime(PRESS_NAV_DELAY)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/watching/2')
  })

  it('a normal single confirmed tap still navigates exactly once to the right target', () => {
    const el = fakeElement({ classes: ['motion-press'] })
    pressTracker.down(1, el, 0, 0)
    pressTracker.up(1)

    const navigate = vi.fn()
    handleTapNavigateClick(fakeClickEvent(el), navigate, '/watching/7')
    vi.advanceTimersByTime(PRESS_NAV_DELAY)

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/watching/7')
  })
})
