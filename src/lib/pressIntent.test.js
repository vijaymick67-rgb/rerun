import { describe, expect, it, vi } from 'vitest'
import {
  PRESS_CANCEL_ATTR,
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
    // to the overlay button itself.
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

describe('createPressTracker', () => {
  it('pointer down starts tracking without cancelling', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    expect(tracker.isTracking(1)).toBe(true)
    expect(tracker.isCancelled).toBe(false)
    expect(el.setAttribute).not.toHaveBeenCalled()
  })

  it('movement below the threshold preserves tap intent', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 100, 100)
    tracker.move(1, 102, 101)
    expect(tracker.isCancelled).toBe(false)
    expect(el.setAttribute).not.toHaveBeenCalled()
  })

  it('vertical movement beyond the threshold cancels the press', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 100, 100)
    tracker.move(1, 100, 100 + PRESS_MOVE_THRESHOLD + 5)
    expect(tracker.isCancelled).toBe(true)
    expect(el.setAttribute).toHaveBeenCalledWith(PRESS_CANCEL_ATTR, 'true')
  })

  it('horizontal movement beyond the threshold cancels an ordinary control (and a Watching-row nested Link the same way)', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 100, 100)
    tracker.move(1, 100 + PRESS_MOVE_THRESHOLD + 5, 100)
    expect(tracker.isCancelled).toBe(true)
    expect(el.setAttribute).toHaveBeenCalledWith(PRESS_CANCEL_ATTR, 'true')
  })

  it('a cancelled press cannot reactivate within the same pointer sequence', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.move(1, 0, 20)
    expect(tracker.isCancelled).toBe(true)
    el.setAttribute.mockClear()
    tracker.move(1, 0, 0) // finger drifts back near the start
    expect(tracker.isCancelled).toBe(true)
    expect(el.setAttribute).not.toHaveBeenCalled()
  })

  it('release on pointerup clears the cancelled attribute and tracking state', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.move(1, 0, 20)
    tracker.up(1)
    expect(el.removeAttribute).toHaveBeenCalledWith(PRESS_CANCEL_ATTR)
    expect(tracker.isTracking(1)).toBe(false)
    expect(tracker.trackedElement).toBe(null)
  })

  it('release on pointercancel clears the cancelled attribute and tracking state', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.move(1, 0, 20)
    tracker.cancel(1)
    expect(el.removeAttribute).toHaveBeenCalledWith(PRESS_CANCEL_ATTR)
    expect(tracker.isTracking(1)).toBe(false)
  })

  it('releasing a genuine (uncancelled) tap still clears tracking without ever setting the cancel attribute', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.up(1)
    expect(el.setAttribute).not.toHaveBeenCalled()
    expect(tracker.isTracking(1)).toBe(false)
  })

  it('a second concurrent pointer cannot corrupt the first pointer\'s tracked state', () => {
    const tracker = createPressTracker()
    const elA = fakeElement({ classes: ['motion-press'] })
    const elB = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, elA, 0, 0)
    tracker.down(2, elB, 0, 0) // ignored: pointer 1 already active
    expect(tracker.isTracking(1)).toBe(true)
    expect(tracker.trackedElement).toBe(elA)

    tracker.move(2, 0, 50) // pointer B was never tracked, so this is a no-op
    expect(elA.setAttribute).not.toHaveBeenCalled()

    tracker.up(2) // pointer B releasing must not touch pointer A's state
    expect(tracker.isTracking(1)).toBe(true)
    expect(tracker.trackedElement).toBe(elA)
  })

  it('reset() clears any in-flight tracking (used on route change / unmount / blur)', () => {
    const tracker = createPressTracker()
    const el = fakeElement({ classes: ['motion-press'] })
    tracker.down(1, el, 0, 0)
    tracker.move(1, 0, 20)
    tracker.reset()
    expect(el.removeAttribute).toHaveBeenCalledWith(PRESS_CANCEL_ATTR)
    expect(tracker.isTracking(1)).toBe(false)
  })
})
