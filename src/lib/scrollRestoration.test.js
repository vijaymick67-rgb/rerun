import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createBoundedScrollRestorer,
  getScrollNavigationAction,
  getScrollRouteKey,
  isNestedParentPath,
  MAX_RESTORE_ATTEMPTS,
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

describe('bounded dynamic-content restoration', () => {
  it('retries only until the target is reachable or the fixed bound is met', () => {
    let maxScroll = 0
    let scheduled
    const positions = []
    const cancelSchedule = () => {}

    createBoundedScrollRestorer({
      target: 500,
      getMaxScroll: () => maxScroll,
      scrollTo: (position) => positions.push(position),
      schedule: (callback) => {
        scheduled = callback
        return 1
      },
      cancelSchedule,
    })

    expect(positions).toEqual([0])
    maxScroll = 600
    scheduled()
    expect(positions).toEqual([0, 500])
  })

  it('stops after the fixed attempt bound and supports cancellation', () => {
    let scheduled
    let scheduleCount = 0
    const positions = []
    const cancelSchedule = () => {}
    const cancel = createBoundedScrollRestorer({
      target: 500,
      getMaxScroll: () => 0,
      scrollTo: (position) => positions.push(position),
      schedule: (callback) => {
        scheduled = callback
        scheduleCount += 1
        return scheduleCount
      },
      cancelSchedule,
    })

    for (let attempt = 0; attempt < MAX_RESTORE_ATTEMPTS - 1; attempt += 1) scheduled()
    expect(positions).toHaveLength(MAX_RESTORE_ATTEMPTS)
    expect(scheduleCount).toBe(MAX_RESTORE_ATTEMPTS - 1)

    cancel()
    scheduled()
    expect(positions).toHaveLength(MAX_RESTORE_ATTEMPTS)
  })
})
