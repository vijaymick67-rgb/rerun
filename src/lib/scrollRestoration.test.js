import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createBoundedScrollRestorer,
  flushPendingScrollPosition,
  getRouteShellKey,
  getScrollNavigationAction,
  getScrollRouteKey,
  isNestedParentPath,
  MAX_RESTORE_ATTEMPTS,
  RESTORE_RETRY_DELAY_MS,
} from './scrollRestoration'

const source = readFileSync(new URL('./scrollRestoration.js', import.meta.url), 'utf8')

describe('scroll restoration route policy', () => {
  it('uses independent keys for tabs and nested pages', () => {
    expect(getScrollRouteKey('/')).toBe('/watching')
    expect(getScrollRouteKey('/watching')).toBe('/watching')
    expect(getScrollRouteKey('/stats')).toBe('/stats')
    expect(getScrollRouteKey('/stats')).not.toBe(getScrollRouteKey('/watching'))
    expect(getScrollRouteKey('/watching/123')).toBe('/watching/123')
    expect(getScrollRouteKey('/watching/123/season/1')).toBe('/watching/123/season/1')
  })

  it('restores tab positions without changing existing tab history semantics', () => {
    expect(getScrollNavigationAction({
      isInitial: false,
      navigationType: 'PUSH',
      previousPathname: '/watching',
      pathname: '/stats',
    })).toEqual({ type: 'restore', key: '/stats' })
  })

  it('resets forward nested navigation and restores parent navigation', () => {
    expect(getScrollNavigationAction({
      isInitial: false,
      navigationType: 'PUSH',
      previousPathname: '/watching',
      pathname: '/watching/123',
    })).toEqual({ type: 'top', key: '/watching/123' })

    expect(getScrollNavigationAction({
      isInitial: false,
      navigationType: 'PUSH',
      previousPathname: '/watching/123',
      pathname: '/watching',
    })).toEqual({ type: 'restore', key: '/watching' })

    expect(getScrollNavigationAction({
      isInitial: false,
      navigationType: 'PUSH',
      previousPathname: '/watching/123',
      pathname: '/watching/123/season/1',
    })).toEqual({ type: 'top', key: '/watching/123/season/1' })

    expect(getScrollNavigationAction({
      isInitial: false,
      navigationType: 'POP',
      previousPathname: '/watching/123/season/1',
      pathname: '/watching/123',
    })).toEqual({ type: 'restore', key: '/watching/123' })

    expect(isNestedParentPath('/watching/123/season/1', '/watching/123')).toBe(true)
    expect(isNestedParentPath('/watching/123/season/1', '/watching/999')).toBe(false)
  })

  it('starts direct loads, Not Found, and forward navigation at the top', () => {
    for (const pathname of ['/watching', '/watching/123', '/missing']) {
      expect(getScrollNavigationAction({
        isInitial: true,
        navigationType: 'POP',
        previousPathname: pathname,
        pathname,
      }).type).toBe('top')
    }
  })

  it('keeps scroll memory in session only', () => {
    expect(source).not.toContain('localStorage')
    expect(source).not.toContain('sessionStorage')
  })
})

describe('Stats nested route (/stats/all) scroll + shell policy', () => {
  it('gives /stats and /stats/all the same shell identity, so entering the expanded page never remounts the shared Stats data owner', () => {
    expect(getRouteShellKey('/stats/all')).toBe(getRouteShellKey('/stats'))
    expect(getRouteShellKey('/stats/all')).toBe('/stats')
  })

  it('does not fold /stats/all into any other tab or the Watching subtree', () => {
    expect(getRouteShellKey('/stats/all')).not.toBe(getRouteShellKey('/watching'))
    expect(getRouteShellKey('/stats/all')).not.toBe(getRouteShellKey('/browse'))
    expect(getRouteShellKey('/stats/all')).not.toBe(getRouteShellKey('/settings'))
  })

  it('/stats/all keeps its own scroll-position key, independent of /stats', () => {
    expect(getScrollRouteKey('/stats/all')).toBe('/stats/all')
    expect(getScrollRouteKey('/stats/all')).not.toBe(getScrollRouteKey('/stats'))
  })

  it('entering /stats/all from the main preview link starts at the top', () => {
    expect(getScrollNavigationAction({
      isInitial: false,
      navigationType: 'PUSH',
      previousPathname: '/stats',
      pathname: '/stats/all',
    })).toEqual({ type: 'top', key: '/stats/all' })
  })

  it('a forward (redo) POP back into /stats/all restores its own previously-captured position, same as the Watching subtree already does for nested forward POPs', () => {
    expect(getScrollNavigationAction({
      isInitial: false,
      navigationType: 'POP',
      previousPathname: '/stats',
      pathname: '/stats/all',
    })).toEqual({ type: 'restore', key: '/stats/all' })
  })

  it('returning to /stats from /stats/all restores the parent scroll position, via the visible back link, browser Back, or any other route landing on /stats', () => {
    for (const navigationType of ['PUSH', 'POP']) {
      expect(getScrollNavigationAction({
        isInitial: false,
        navigationType,
        previousPathname: '/stats/all',
        pathname: '/stats',
      })).toEqual({ type: 'restore', key: '/stats' })
    }
  })
})

describe('bounded dynamic-content restoration', () => {
  it('preserves the captured Watching position across a clamped route commit', () => {
    const positions = new Map([['/watching', 1800]])
    const pendingPositions = new Map([['/watching', 1800]])
    let maxScroll = 200
    const restored = []
    let scheduled

    flushPendingScrollPosition(positions, pendingPositions, '/watching')
    expect(positions.get('/watching')).toBe(1800)

    createBoundedScrollRestorer({
      target: positions.get('/watching'),
      getMaxScroll: () => maxScroll,
      scrollTo: (position) => restored.push(position),
      schedule: (callback) => {
        scheduled = callback
        return 1
      },
      cancelSchedule: () => {},
    })

    expect(restored).toEqual([200])
    maxScroll = 1800
    scheduled()
    expect(restored).toEqual([200, 1800])
  })

  it('waits beyond 150ms and stops immediately once the target is reachable', () => {
    let maxScroll = 0
    let scheduled
    let scheduleCount = 0
    let finishCount = 0
    let elapsed = 0
    const positions = []
    const cancelSchedule = () => {}

    createBoundedScrollRestorer({
      target: 500,
      getMaxScroll: () => maxScroll,
      scrollTo: (position) => positions.push(position),
      schedule: (callback) => {
        scheduleCount += 1
        scheduled = () => {
          elapsed += RESTORE_RETRY_DELAY_MS
          callback()
        }
        return scheduleCount
      },
      cancelSchedule,
      onFinish: () => { finishCount += 1 },
    })

    expect(positions).toEqual([0])
    expect(scheduleCount).toBe(1)
    scheduled()
    scheduled()
    expect(elapsed).toBe(150)
    expect(positions).toEqual([0, 0, 0])
    maxScroll = 600
    scheduled()
    expect(elapsed).toBeGreaterThan(150)
    expect(positions).toEqual([0, 0, 0, 500])
    expect(finishCount).toBe(1)
    scheduled()
    expect(positions).toEqual([0, 0, 0, 500])
  })

  it('stops after the fixed attempt bound and supports cancellation', () => {
    let scheduled
    let scheduleCount = 0
    const cancelledTimers = []
    const positions = []
    const cancel = createBoundedScrollRestorer({
      target: 500,
      getMaxScroll: () => 0,
      scrollTo: (position) => positions.push(position),
      schedule: (callback) => {
        scheduled = callback
        scheduleCount += 1
        return scheduleCount
      },
      cancelSchedule: (timerId) => cancelledTimers.push(timerId),
      onFinish: () => { throw new Error('cancelled restoration must not finish') },
    })

    scheduled()
    expect(positions).toHaveLength(2)
    expect(scheduleCount).toBe(2)

    cancel()
    expect(cancelledTimers).toEqual([2])
    scheduled()
    expect(positions).toHaveLength(2)
  })

  it('finishes at the hard bound and cancels scheduled work', () => {
    let scheduled
    const cancelledTimers = []
    let finishCount = 0
    const positions = []
    createBoundedScrollRestorer({
      target: 500,
      getMaxScroll: () => 0,
      scrollTo: (position) => positions.push(position),
      schedule: (callback) => {
        scheduled = callback
        return positions.length
      },
      cancelSchedule: (timerId) => cancelledTimers.push(timerId),
      onFinish: () => { finishCount += 1 },
    })

    for (let attempt = 0; attempt < MAX_RESTORE_ATTEMPTS - 1; attempt += 1) scheduled()
    expect(positions).toHaveLength(MAX_RESTORE_ATTEMPTS)
    expect(finishCount).toBe(1)
    expect(cancelledTimers).toEqual([])
  })
})
