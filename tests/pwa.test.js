import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PWA_IMAGE_CACHE_MAX_AGE_SECONDS,
  PWA_IMAGE_CACHE_MAX_ENTRIES,
  PWA_MANIFEST,
  PWA_OPTIONS,
  isNavigationFallbackAllowed,
  shouldCacheRuntimeRequest,
} from '../vite/pwa-options.js'
import { removeStaticLoadingShell } from '../src/pwa/appShell.js'
import { createUpdateLifecycle, requestServiceWorkerUpdate } from '../src/pwa/updateLifecycle.js'
import NotFound from '../src/components/NotFound.jsx'

const repoRoot = resolve(import.meta.dirname, '..')

function readPngDimensions(fileName) {
  const png = readFileSync(resolve(repoRoot, 'public', fileName))
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

describe('PWA foundation', () => {
  it('contains the required manifest installability fields', () => {
    expect(PWA_MANIFEST).toMatchObject({
      name: 'RERUN',
      short_name: 'RERUN',
      display: 'standalone',
      orientation: 'portrait-primary',
      start_url: '/',
      scope: '/',
      theme_color: '#0f1115',
      background_color: '#0f1115',
    })
    expect(PWA_MANIFEST.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', type: 'image/png' }),
      expect.objectContaining({ sizes: '512x512', type: 'image/png' }),
      expect.objectContaining({ purpose: 'maskable' }),
    ]))
  })

  it('ships valid required icon dimensions', () => {
    expect(readPngDimensions('icon-192.png')).toEqual({ width: 192, height: 192 })
    expect(readPngDimensions('icon-512.png')).toEqual({ width: 512, height: 512 })
    expect(readPngDimensions('icon-maskable-512.png')).toEqual({ width: 512, height: 512 })
    expect(readPngDimensions('apple-touch-icon.png')).toEqual({ width: 180, height: 180 })
  })

  it('does not create duplicate update prompts', () => {
    const lifecycle = createUpdateLifecycle({ activateAndReload: vi.fn() })
    expect(lifecycle.announceReady()).toBe(true)
    expect(lifecycle.announceReady()).toBe(false)
    expect(lifecycle.getPromptCount()).toBe(1)
    expect(lifecycle.getState()).toBe('ready')
  })

  it('allows a future distinct update to prompt after dismissal', () => {
    const lifecycle = createUpdateLifecycle({ activateAndReload: vi.fn() })
    expect(lifecycle.announceReady()).toBe(true)
    expect(lifecycle.dismiss()).toBe(true)
    expect(lifecycle.announceReady()).toBe(true)
    expect(lifecycle.getPromptCount()).toBe(2)
  })

  it('explicit Update invokes activation and reload', async () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined)
    await requestServiceWorkerUpdate(updateServiceWorker)
    expect(updateServiceWorker).toHaveBeenCalledWith(true)
  })

  it('dismissed or idle state does not reload', async () => {
    const activateAndReload = vi.fn()
    const lifecycle = createUpdateLifecycle({ activateAndReload })
    expect(await lifecycle.update()).toBe(false)
    expect(activateAndReload).not.toHaveBeenCalled()
    lifecycle.announceReady()
    lifecycle.dismiss()
    expect(await lifecycle.update()).toBe(false)
    expect(activateAndReload).not.toHaveBeenCalled()
  })

  it('activates exactly once and returns to retryable state after an update error', async () => {
    const activateAndReload = vi.fn()
      .mockRejectedValueOnce(new Error('activation failed'))
      .mockResolvedValueOnce(undefined)
    const lifecycle = createUpdateLifecycle({ activateAndReload })
    lifecycle.announceReady()
    expect(await lifecycle.update()).toBe(false)
    expect(lifecycle.getState()).toBe('ready')
    expect(await lifecycle.update()).toBe(true)
    expect(lifecycle.getState()).toBe('updated')
    expect(activateAndReload).toHaveBeenCalledTimes(2)
  })

  it('uses a distinct Not Found state for unknown online routes', () => {
    const rendered = NotFound()
    const output = JSON.stringify(rendered)
    expect(output).toContain('Page not found')
    expect(output).not.toContain('RERUN is offline')
  })

  it('removes the static loading shell after React mounts', () => {
    const remove = vi.fn()
    const documentStub = { getElementById: vi.fn(() => ({ remove })) }
    expect(removeStaticLoadingShell(documentStub)).toBe(true)
    expect(remove).toHaveBeenCalledOnce()
  })

  it('keeps safe-area app-shell structure and reduced-motion behavior', () => {
    const css = readFileSync(resolve(repoRoot, 'src/index.css'), 'utf8')
    const app = readFileSync(resolve(repoRoot, 'src/App.jsx'), 'utf8')
    expect(css).toContain('env(safe-area-inset-top, 0px)')
    expect(css).toContain('env(safe-area-inset-bottom, 0px)')
    expect(css).toContain('.app-shell')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(app).toContain('className="app-shell"')
    expect(app).toContain('removeStaticLoadingShell')
  })

  it('excludes personal Supabase and API requests from runtime caching', () => {
    expect(shouldCacheRuntimeRequest('https://umzeszalktyudjtnvmus.supabase.co/rest/v1/tracked_shows')).toBe(false)
    expect(shouldCacheRuntimeRequest('https://rerun-nine.vercel.app/api/tmdb/tv/1')).toBe(false)
    expect(shouldCacheRuntimeRequest('https://api.tvmaze.com/shows/1/episodes')).toBe(false)
    expect(shouldCacheRuntimeRequest('https://image.tmdb.org/t/p/w342/poster.jpg')).toBe(true)
    expect(shouldCacheRuntimeRequest('https://image.tmdb.org/t/p/w342/poster.jpg', { method: 'POST' })).toBe(false)
  })

  it('bounds image runtime caching with expiration', () => {
    const imageCache = PWA_OPTIONS.workbox.runtimeCaching[0]
    expect(imageCache.handler).toBe('CacheFirst')
    expect(imageCache.options.cacheName).toBe('rerun-tmdb-images')
    expect(imageCache.options.expiration).toMatchObject({
      maxEntries: PWA_IMAGE_CACHE_MAX_ENTRIES,
      maxAgeSeconds: PWA_IMAGE_CACHE_MAX_AGE_SECONDS,
    })
    expect(PWA_IMAGE_CACHE_MAX_ENTRIES).toBeGreaterThan(0)
    expect(PWA_IMAGE_CACHE_MAX_AGE_SECONDS).toBeGreaterThan(0)
  })

  it('excludes API paths from the service-worker navigation fallback', () => {
    expect(isNavigationFallbackAllowed('/watching/123')).toBe(true)
    expect(isNavigationFallbackAllowed('/api/tmdb/tv/123')).toBe(false)
    expect(isNavigationFallbackAllowed('/api/news')).toBe(false)
    expect(isNavigationFallbackAllowed('/rest/v1/tracked_shows')).toBe(false)
  })

  it('documents the honest offline behavior as cached-shell-only', () => {
    expect(PWA_OPTIONS.workbox.navigateFallback).toBe('/index.html')
    expect(PWA_OPTIONS.includeAssets).not.toContain('offline.html')
  })

  it('keeps the static loading shell lightweight and reduced-motion safe', () => {
    const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8')
    expect(html).toContain('id="app-loading"')
    expect(html).toContain('prefers-reduced-motion: no-preference')
    expect(html).toContain('viewport-fit=cover')
  })
})
