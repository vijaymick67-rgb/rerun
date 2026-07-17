import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PWA_MANIFEST, PWA_THEME_COLOR } from '../vite/pwa-options.js'

const repoRoot = resolve(import.meta.dirname, '..')
const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8')
const approvedIconSvg = readFileSync(resolve(repoRoot, 'design/rerun-icon-approved.svg'), 'utf8')
const approvedMaskableSvg = readFileSync(resolve(repoRoot, 'design/rerun-icon-approved-maskable.svg'), 'utf8')

function readPng(fileName) {
  return readFileSync(resolve(repoRoot, 'public', fileName))
}

describe('Rerun launch identity', () => {
  it('names the manifest Rerun and keeps theme/background aligned', () => {
    expect(PWA_MANIFEST.name).toBe('Rerun')
    expect(PWA_MANIFEST.short_name).toBe('Rerun')
    expect(PWA_MANIFEST.theme_color).toBe(PWA_THEME_COLOR)
    expect(PWA_MANIFEST.background_color).toBe(PWA_THEME_COLOR)
    const maskableIcon = PWA_MANIFEST.icons.find((icon) => icon.purpose === 'maskable')
    expect(maskableIcon).toMatchObject({ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png' })
    expect(PWA_MANIFEST.icons.filter((icon) => icon.purpose === 'any')).toHaveLength(2)
  })

  it('sets Rerun as the document title and Apple web-app title', () => {
    expect(html).toMatch(/<title>Rerun<\/title>/)
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Rerun" />')
  })

  it('references committed favicon and Apple touch icon assets', () => {
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/rerun-icon.svg" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(() => statSync(resolve(repoRoot, 'public/rerun-icon.svg'))).not.toThrow()
    expect(() => statSync(resolve(repoRoot, 'public/apple-touch-icon.png'))).not.toThrow()
  })

  it('renders the static shell before #root with a Rerun ARIA label', () => {
    const shellIndex = html.indexOf('id="app-loading"')
    const rootIndex = html.indexOf('id="root"')
    expect(shellIndex).toBeGreaterThan(-1)
    expect(rootIndex).toBeGreaterThan(shellIndex)
    expect(html).toContain('aria-label="Loading Rerun"')
  })

  it('contains the approved mark geometry and Rerun wordmark in the shell', () => {
    expect(html).toContain('M406 302 L512 408 L618 302')
    expect(html).toContain('M646 724 C709 770 728 854 688 922')
    expect(html).toContain('>Rerun<')
  })

  it('uses the deep app background with no white flash and covers safe areas', () => {
    expect(html).toContain(`background: ${PWA_THEME_COLOR}`)
    expect(html).toContain('env(safe-area-inset-top, 0px)')
    expect(html).toContain('env(safe-area-inset-bottom, 0px)')
    expect(html).toContain('viewport-fit=cover')
  })

  it('sizes the shell with border-box so safe-area padding stays inside the viewport height', () => {
    const shellRule = html.match(/\.app-loading-shell\s*\{([^}]*)\}/)
    expect(shellRule).not.toBeNull()
    const [, body] = shellRule
    expect(body).toContain('box-sizing: border-box')
    expect(body).toMatch(/min-height:\s*100dvh/)
    expect(body).toMatch(/padding:\s*env\(safe-area-inset-top/)
  })

  it('supports reduced motion and keeps shell motion restrained and non-blocking', () => {
    expect(html).toContain('@media (prefers-reduced-motion: no-preference)')
    expect(html).not.toMatch(/infinite/)
    expect(html).not.toMatch(/setTimeout/)
  })

  it('requires no external network resource for the shell to render', () => {
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toContain('image.tmdb.org')
    expect(html).not.toContain('fonts.googleapis')
  })

  it('ships valid, non-empty, correctly sized PNG assets', () => {
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    for (const [fileName, size] of [
      ['icon-192.png', 192],
      ['icon-512.png', 512],
      ['icon-maskable-512.png', 512],
      ['apple-touch-icon.png', 180],
    ]) {
      const png = readPng(fileName)
      expect(png.length).toBeGreaterThan(0)
      expect(png.subarray(0, 8)).toEqual(pngSignature)
      expect(png.readUInt32BE(16)).toBe(size)
      expect(png.readUInt32BE(20)).toBe(size)
    }
  })

  it('keeps favicon.svg and rerun-icon.svg parseable and free of external references', () => {
    for (const fileName of ['favicon.svg', 'rerun-icon.svg']) {
      const svg = readFileSync(resolve(repoRoot, 'public', fileName), 'utf8')
      expect(svg).toMatch(/^<svg[\s>]/)
      expect(svg.trim().endsWith('</svg>')).toBe(true)
      expect(svg).not.toMatch(/(?:href|src)="https?:\/\//)
      expect(svg).not.toContain('<image')
    }
  })

  it('derives the public icon SVGs from the approved design source', () => {
    for (const fileName of ['favicon.svg', 'rerun-icon.svg']) {
      const svg = readFileSync(resolve(repoRoot, 'public', fileName), 'utf8')
      expect(svg).toBe(approvedIconSvg)
    }
  })

  it('keeps the maskable source distinct from the regular icon with safe-zone padding', () => {
    expect(approvedMaskableSvg).not.toBe(approvedIconSvg)
    expect(approvedIconSvg).toMatch(/viewBox="0 0 1024 1024"/)
    expect(approvedMaskableSvg).toMatch(/viewBox="-80 -80 1184 1184"/)
  })
})
