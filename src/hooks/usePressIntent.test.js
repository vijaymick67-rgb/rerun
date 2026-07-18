import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const hookSrc = src('./usePressIntent.js')
const appSrc = src('../App.jsx')
const indexCss = src('../index.css')
const watchingRow = src('../components/WatchingRow.jsx')

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

  it('resets tracked state on route change, window blur, and unmount cleanup', () => {
    expect(hookSrc).toContain('[pathname]')
    expect(hookSrc).toContain("window.addEventListener('blur'")
    expect(hookSrc).toContain("window.removeEventListener('blur'")
    const resetCallCount =
      (hookSrc.match(/tracker\.reset\(\)/g)?.length ?? 0) +
      (hookSrc.match(/trackerRef\.current\.reset\(\)/g)?.length ?? 0)
    expect(resetCallCount).toBeGreaterThanOrEqual(3)
  })

  it('is mounted once from the app shell', () => {
    expect(appSrc).toContain("import usePressIntent from './hooks/usePressIntent'")
    expect(appSrc).toContain('usePressIntent()')
  })
})

describe('delayed-activation press CSS', () => {
  it('drives touch press feedback only from the delayed data-pressed attribute, unconditionally on pointer type', () => {
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

    // The :active rule must not also exist unscoped anywhere outside a
    // (hover: hover) and (pointer: fine) (optionally reduced-motion) block —
    // otherwise touch input would receive it too.
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

  it('no longer contains the PR #86 cancellation-after-activation attribute or terminology', () => {
    expect(indexCss).not.toContain('data-press-cancelled')
    expect(hookSrc).not.toContain('data-press-cancelled')
    expect(hookSrc).not.toContain('PRESS_CANCEL_ATTR')
  })

  it('reduced motion neutralizes both the delayed touch attribute and the fine-pointer :active rule', () => {
    const reducedMotionBlock = indexCss.slice(indexCss.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotionBlock).toContain(
      ".motion-press[data-pressed='true']:not(:disabled):not([aria-disabled='true']) {",
    )
    expect(reducedMotionBlock).toContain('scale: none;')
    expect(reducedMotionBlock).toContain('opacity: 1;')
    expect(reducedMotionBlock).toContain('prefers-reduced-motion: reduce) and (hover: hover) and (pointer: fine)')
  })
})

describe('WatchingRow gesture recognizer is untouched by the new press-intent wiring', () => {
  it('still owns its own touch listeners and threshold, independent of usePressIntent', () => {
    expect(watchingRow).toContain('const DRAG_THRESHOLD = 6')
    expect(watchingRow).toContain("addEventListener('touchstart', handleTouchStart, { passive: true })")
    expect(watchingRow).toContain("addEventListener('touchmove', handleTouchMove, { passive: false })")
    expect(watchingRow).not.toContain('usePressIntent')
    expect(watchingRow).not.toContain('pressIntent')
  })
})
