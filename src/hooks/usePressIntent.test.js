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

  it('never synthesizes a click', () => {
    expect(hookSrc).not.toContain('.click(')
    expect(hookSrc).not.toContain('dispatchEvent')
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

describe('scroll-cancel CSS override', () => {
  it('adds a same-specificity override so cancellation wins over :active without !important', () => {
    const ruleStart = indexCss.indexOf(
      ".motion-press[data-press-cancelled='true']:active:not(:disabled):not([aria-disabled='true']) {",
    )
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = indexCss.slice(ruleStart, indexCss.indexOf('}', ruleStart) + 1)
    expect(rule).not.toContain('!important')
    expect(rule).toContain('scale: none;')
    expect(rule).toContain('opacity: 1;')
  })

  it('leaves the base :active press rule and reduced-motion neutralization untouched', () => {
    expect(indexCss).toMatch(
      /\.motion-press:active:not\(:disabled\):not\(\[aria-disabled='true'\]\) \{\s*scale: 0\.98;\s*opacity: 0\.9;\s*\}/,
    )
    const reducedMotionBlock = indexCss.slice(indexCss.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotionBlock).toContain('scale: none;')
    expect(reducedMotionBlock).toContain('opacity: 1;')
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
