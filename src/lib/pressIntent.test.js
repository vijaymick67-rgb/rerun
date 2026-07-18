import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PRESS_ACTIVATE_DELAY,
  PRESS_ATTR,
  PRESS_MOVE_THRESHOLD,
  createPressTracker,
  exceedsPressThreshold,
  findPressableAncestor,
  isPressable,
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

// The tracker's activation timer uses the platform setTimeout/clearTimeout by
// default, so fake timers give deterministic control over PRESS_ACTIVATE_DELAY
// without needing to inject a custom clock into every test.
describe('createPressTracker: delayed-activation state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pointer down starts a pending activation without setting the pressed attribute', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    expect(tracker.isTracking(1)).toBe(true)
    expect(tracker.hasPendingTimer).toBe(true)
    expect(tracker.isActivated).toBe(false)
    expect(el.setAttribute).not.toHaveBeenCalled()
  })

  it('activates only once the configured delay has fully elapsed', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)

    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY - 1)
    expect(tracker.isActivated).toBe(false)
    expect(el.setAttribute).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(tracker.isActivated).toBe(true)
    expect(el.setAttribute).toHaveBeenCalledWith(PRESS_ATTR, 'true')
  })

  it('sub-threshold jitter before the delay does not prevent activation', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 100, 100)
    tracker.move(1, 102, 101)
    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY)
    expect(tracker.isActivated).toBe(true)
    expect(el.setAttribute).toHaveBeenCalledWith(PRESS_ATTR, 'true')
  })

  it('movement beyond the threshold before the delay elapses cancels the pending timer and prevents activation entirely', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 100, 100)
    tracker.move(1, 100, 100 + PRESS_MOVE_THRESHOLD + 5)
    expect(tracker.hasPendingTimer).toBe(false)
    expect(tracker.isCancelled).toBe(true)

    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY * 4)
    expect(tracker.isActivated).toBe(false)
    expect(el.setAttribute).not.toHaveBeenCalled()
  })

  it('vertical movement beyond the threshold cancels the sequence', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 100, 100)
    tracker.move(1, 100, 100 + PRESS_MOVE_THRESHOLD + 5)
    expect(tracker.isCancelled).toBe(true)
  })

  it('horizontal movement beyond the threshold cancels the sequence (e.g. a Watching-row swipe)', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 100, 100)
    tracker.move(1, 100 + PRESS_MOVE_THRESHOLD + 5, 100)
    expect(tracker.isCancelled).toBe(true)
  })

  it('movement beyond the threshold after activation removes the pressed state immediately', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY)
    expect(tracker.isActivated).toBe(true)

    tracker.move(1, 0, PRESS_MOVE_THRESHOLD + 5)
    expect(tracker.isActivated).toBe(false)
    expect(tracker.isCancelled).toBe(true)
    expect(el.removeAttribute).toHaveBeenCalledWith(PRESS_ATTR)
  })

  it('a cancelled sequence cannot reactivate before release, even if the finger drifts back near the start', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.move(1, 0, PRESS_MOVE_THRESHOLD + 5)
    expect(tracker.isCancelled).toBe(true)
    el.setAttribute.mockClear()

    tracker.move(1, 0, 0)
    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY * 4)
    expect(tracker.isCancelled).toBe(true)
    expect(tracker.isActivated).toBe(false)
    expect(el.setAttribute).not.toHaveBeenCalled()
  })

  it('a stationary long press activates exactly once and stays stable, never re-toggling', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY)
    expect(el.setAttribute).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY * 10)
    tracker.move(1, 1, -1) // stays within threshold the whole time
    expect(el.setAttribute).toHaveBeenCalledTimes(1)
    expect(el.removeAttribute).not.toHaveBeenCalled()
    expect(tracker.isActivated).toBe(true)
  })

  it('pointer up before activation clears the pending timer and never sets the pressed attribute', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.up(1)
    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY * 4)
    expect(el.setAttribute).not.toHaveBeenCalled()
    expect(tracker.isTracking(1)).toBe(false)
  })

  it('pointer up after activation removes the pressed attribute', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY)
    tracker.up(1)
    expect(el.removeAttribute).toHaveBeenCalledWith(PRESS_ATTR)
    expect(tracker.isTracking(1)).toBe(false)
    expect(tracker.trackedElement).toBe(null)
  })

  it('pointer cancel resets everything, whether pending or already activated', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY)
    tracker.cancel(1)
    expect(el.removeAttribute).toHaveBeenCalledWith(PRESS_ATTR)
    expect(tracker.isTracking(1)).toBe(false)
    expect(tracker.hasPendingTimer).toBe(false)
  })

  it('reset() clears a pending timer and leaves no attribute (used on route change / blur / unmount)', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.reset()
    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY * 4)
    expect(el.setAttribute).not.toHaveBeenCalled()
    expect(tracker.isTracking(1)).toBe(false)
    expect(tracker.hasPendingTimer).toBe(false)
  })

  it('reset() clears an already-activated state and removes the attribute (used on route change / blur / unmount)', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY)
    tracker.reset()
    expect(el.removeAttribute).toHaveBeenCalledWith(PRESS_ATTR)
    expect(tracker.isTracking(1)).toBe(false)
  })

  it('a second concurrent pointer cannot steal or corrupt the first pointer\'s active sequence', () => {
    const tracker = createPressTracker()
    const elA = fakeElement({ classes: ['motion-press'] })
    const elB = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, elA, 0, 0)
    tracker.down(2, elB, 0, 0) // ignored: pointer 1 already active
    expect(tracker.isTracking(1)).toBe(true)
    expect(tracker.trackedElement).toBe(elA)

    tracker.move(2, 0, 50) // pointer B was never tracked, so this is a no-op
    vi.advanceTimersByTime(PRESS_ACTIVATE_DELAY)
    expect(elB.setAttribute).not.toHaveBeenCalled()
    expect(elA.setAttribute).toHaveBeenCalledWith(PRESS_ATTR, 'true')

    tracker.up(2) // pointer B releasing must not touch pointer A's state
    expect(tracker.isTracking(1)).toBe(true)
    expect(tracker.trackedElement).toBe(elA)
  })

  it('never applies feedback to a disabled or aria-disabled target resolved via findPressableAncestor', () => {
    const disabledEl = fakeElement({ classes: ['motion-press'], disabled: true })
    const ariaDisabledEl = fakeElement({ classes: ['motion-press'], ariaDisabled: 'true' })
    expect(findPressableAncestor(disabledEl)).toBe(null)
    expect(findPressableAncestor(ariaDisabledEl)).toBe(null)
  })
})
