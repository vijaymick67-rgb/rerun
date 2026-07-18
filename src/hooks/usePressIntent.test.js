import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const hookSrc = src('./usePressIntent.js')
const appSrc = src('../App.jsx')
const indexCss = src('../index.css')
const watchingRow = src('../components/WatchingRow.jsx')
const pressIntentSrc = src('../lib/pressIntent.js')

describe('usePressIntent: touch-only, delegated, cleaned-up wiring', () => {
  it('only reacts to touch pointers, leaving mouse/pen and keyboard activation untouched', () => {
    expect((hookSrc.match(/pointerType !== 'touch'/g) ?? []).length).toBe(4)
  })

  it('delegates a single long-lived listener set instead of per-component wiring', () => {
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      expect(hookSrc).toContain(`document.addEventListener('${type}'`)
      expect(hookSrc).toContain(`document.removeEventListener('${type}'`)
    }
  })

  it('never calls preventDefault, so native scrolling is never hijacked', () => {
    expect(hookSrc).not.toContain('preventDefault')
  })

  it('never synthesizes a click, captures a pointer, or suppresses propagation', () => {
    expect(hookSrc).not.toContain('.click(')
    expect(hookSrc).not.toContain('dispatchEvent')
    expect(hookSrc).not.toContain('setPointerCapture')
    expect(hookSrc).not.toContain('stopPropagation')
  })

  it('resets the shared tracker on route change, window blur, and unmount cleanup', () => {
    expect(hookSrc).toContain('[pathname]')
    expect(hookSrc).toContain("window.addEventListener('blur'")
    expect(hookSrc).toContain("window.removeEventListener('blur'")
    const resetCallCount = (hookSrc.match(/pressTracker\.reset\(\)/g)?.length ?? 0)
    expect(resetCallCount).toBeGreaterThanOrEqual(3)
  })

  it('drives the single shared tracker singleton, not a per-mount instance', () => {
    expect(hookSrc).toContain("import { findPressableAncestor, pressTracker } from '../lib/pressIntent'")
  })

  it('is mounted once from the app shell', () => {
    expect(appSrc).toContain("import usePressIntent from './hooks/usePressIntent'")
    expect(appSrc).toContain('usePressIntent()')
  })
})

describe('release-time tap classification CSS', () => {
  it('drives touch press feedback only from the data-pressed attribute, unconditionally on pointer type', () => {
    const ruleStart = indexCss.indexOf(
      ".motion-press[data-pressed='true']:not(:disabled):not([aria-disabled='true']) {",
    )
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = indexCss.slice(ruleStart, indexCss.indexOf('}', ruleStart) + 1)
    expect(rule).not.toContain('!important')
    expect(rule).toContain('scale: 0.98;')
    expect(rule).toContain('opacity: 0.9;')
  })

  it('gates the immediate native :active feedback behind a fine-pointer/hover-capable media query, so touch never gets it', () => {
    const mediaStart = indexCss.indexOf('@media (hover: hover) and (pointer: fine) {')
    expect(mediaStart).toBeGreaterThan(-1)
    const activeRuleStart = indexCss.indexOf(
      ".motion-press:active:not(:disabled):not([aria-disabled='true']) {",
    )
    expect(activeRuleStart).toBeGreaterThan(mediaStart)

    const activeOccurrences = [
      ...indexCss.matchAll(/\.motion-press:active:not\(:disabled\):not\(\[aria-disabled='true'\]\) \{/g),
    ]
    expect(activeOccurrences.length).toBeGreaterThan(0)
    for (const match of activeOccurrences) {
      const precedingCss = indexCss.slice(0, match.index)
      const nearestMediaOpen = precedingCss.lastIndexOf('@media')
      expect(nearestMediaOpen).toBeGreaterThan(-1)
      const mediaHeader = indexCss.slice(nearestMediaOpen, indexCss.indexOf('{', nearestMediaOpen))
      expect(mediaHeader).toContain('(hover: hover) and (pointer: fine)')
    }
  })

  it('no longer contains any hold-timer activation-delay terminology from the previous architecture', () => {
    expect(pressIntentSrc).not.toContain('PRESS_ACTIVATE_DELAY')
    expect(pressIntentSrc).not.toContain('data-press-cancelled')
    expect(indexCss).not.toContain('data-press-cancelled')
    expect(hookSrc).not.toContain('data-press-cancelled')
  })

  it('reduced motion neutralizes both the touch attribute and the fine-pointer :active rule', () => {
    const reducedMotionBlock = indexCss.slice(indexCss.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotionBlock).toContain(
      ".motion-press[data-pressed='true']:not(:disabled):not([aria-disabled='true']) {",
    )
    expect(reducedMotionBlock).toContain('scale: none;')
    expect(reducedMotionBlock).toContain('opacity: 1;')
    expect(reducedMotionBlock).toContain('prefers-reduced-motion: reduce) and (hover: hover) and (pointer: fine)')
  })
})

describe('navigation-delay coordination is narrowly scoped to card/show navigation Links', () => {
  it('wires WatchingRow, ShowDetail season rows, and Stats posters through handleTapNavigateClick', () => {
    const showDetail = src('../routes/ShowDetail.jsx')
    const stats = src('../routes/Stats.jsx')
    expect(watchingRow).toContain('handleTapNavigateClick(e, navigate,')
    expect(showDetail).toContain('handleTapNavigateClick(')
    expect(stats).toContain('handleTapNavigateClick(')
  })

  it('never preventDefaults on the pointer/touch phase — only the resulting click of an already-classified tap', () => {
    const trackerBody = pressIntentSrc.slice(
      pressIntentSrc.indexOf('export function createPressTracker'),
      pressIntentSrc.indexOf('export const pressTracker'),
    )
    expect(trackerBody).not.toContain('preventDefault')

    const navigateFnBody = pressIntentSrc.slice(
      pressIntentSrc.indexOf('export function handleTapNavigateClick'),
    )
    expect(navigateFnBody.match(/preventDefault/g)?.length ?? 0).toBe(1)
  })

  it('TabBar tab switches are left untouched by the navigation-delay coordination', () => {
    const tabBar = src('../components/TabBar.jsx')
    expect(tabBar).not.toContain('handleTapNavigateClick')
    expect(tabBar).not.toContain('pressIntent')
  })
})

describe('WatchingRow gesture recognizer is untouched by press-intent wiring', () => {
  it('still owns its own touch listeners and threshold, independent of usePressIntent', () => {
    expect(watchingRow).toContain('const DRAG_THRESHOLD = 6')
    expect(watchingRow).toContain("addEventListener('touchstart', handleTouchStart, { passive: true })")
    expect(watchingRow).toContain("addEventListener('touchmove', handleTouchMove, { passive: false })")
    expect(watchingRow).not.toContain('usePressIntent')
  })
})
