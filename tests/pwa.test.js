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
import {
  createUpdateChecker,
  createUpdateLifecycle,
  installControllerChangeListener,
  PWA_UPDATE_CHECK_INTERVAL_MS,
  requestServiceWorkerUpdate,
} from '../src/pwa/updateLifecycle.js'
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

  it('keeps first install idle and prompt-driven', () => {
    const lifecycle = createUpdateLifecycle({ activateAndReload: vi.fn() })
    expect(PWA_OPTIONS.registerType).toBe('prompt')
    expect(lifecycle.getState()).toBe('idle')
    expect(lifecycle.getPromptCount()).toBe(0)
  })

  it('ships valid required icon dimensions', () => {
    expect(readPngDimensions('icon-192.png')).toEqual({ width: 192, height: 192 })
    expect(readPngDimensions('icon-512.png')).toEqual({ width: 512, height: 512 })
    expect(readPngDimensions('icon-maskable-512.png')).toEqual({ width: 512, height: 512 })
    expect(readPngDimensions('apple-touch-icon.png')).toEqual({ width: 180, height: 180 })
  })

  it('does not create duplicate update prompts', () => {
    const lifecycle = createUpdateLifecycle({ activateAndReload: vi.fn() })
    const worker = {}
    expect(lifecycle.announceReady(worker)).toBe(true)
    expect(lifecycle.announceReady(worker)).toBe(false)
    expect(lifecycle.getPromptCount()).toBe(1)
    expect(lifecycle.getState()).toBe('ready')
  })

  it('allows a future distinct update to prompt after dismissal', () => {
    const lifecycle = createUpdateLifecycle({ activateAndReload: vi.fn() })
    const firstWorker = { version: 'a' }
    expect(lifecycle.announceReady(firstWorker)).toBe(true)
    expect(lifecycle.dismiss()).toBe(true)
    expect(lifecycle.announceReady(firstWorker)).toBe(false)
    expect(lifecycle.announceReady({ version: 'b' })).toBe(true)
    expect(lifecycle.getPromptCount()).toBe(2)
  })

  it('explicit Update sends one activation request to the waiting worker', async () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined)
    await requestServiceWorkerUpdate(updateServiceWorker)
    expect(updateServiceWorker).toHaveBeenCalledWith(false)
  })

  it('confirms the installed vite-plugin-pwa 1.3.0 reload contract', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'node_modules/vite-plugin-pwa/package.json'), 'utf8'))
    const reactSource = readFileSync(
      resolve(repoRoot, 'node_modules/vite-plugin-pwa/dist/client/build/react.js'),
      'utf8',
    )
    expect(packageJson.version).toBe('1.3.0')
    const registerSource = readFileSync(
      resolve(repoRoot, 'node_modules/vite-plugin-pwa/dist/client/build/register.js'),
      'utf8',
    )
    const typeSource = readFileSync(
      resolve(repoRoot, 'node_modules/vite-plugin-pwa/types/index.d.ts'),
      'utf8',
    )
    expect(reactSource).toContain('onNeedReload')
    expect(typeSource).toContain('onNeedReload?: () => void')
    expect(registerSource).toContain('wb?.addEventListener("controlling"')
    expect(registerSource).toContain('if (event.isUpdate)')
    expect(registerSource).toContain('sendSkipWaitingMessage?.()')
    expect(registerSource).toContain('if (onNeedReload)')
    expect(registerSource).toContain('window.location.reload()')
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

  it('gates prompts while offline and permits them after reconnect', () => {
    let online = false
    const lifecycle = createUpdateLifecycle({
      activateAndReload: vi.fn(),
      isOnline: () => online,
    })
    const worker = {}
    expect(lifecycle.announceReady(worker)).toBe(false)
    online = true
    expect(lifecycle.announceReady(worker)).toBe(true)
  })

  it('sends one activation request even when Update is tapped repeatedly', async () => {
    let release
    const activateAndReload = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const lifecycle = createUpdateLifecycle({ activateAndReload })
    lifecycle.announceReady({ version: 'a' })
    const first = lifecycle.update()
    const second = lifecycle.update()
    expect(activateAndReload).toHaveBeenCalledOnce()
    release()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
  })

  it('reloads once for duplicate controllerchange events and preserves the browser URL', async () => {
    const reload = vi.fn()
    const location = { pathname: '/watching/123', search: '?tab=season', hash: '#episode-4' }
    const activateAndReload = vi.fn().mockResolvedValue(undefined)
    const lifecycle = createUpdateLifecycle({
      activateAndReload,
      reload: () => reload(location.pathname + location.search + location.hash),
    })
    lifecycle.announceReady({ version: 'a' })
    await lifecycle.update()
    expect(lifecycle.handleControllerChange()).toBe(true)
    expect(lifecycle.handleControllerChange()).toBe(false)
    expect(reload).toHaveBeenCalledOnce()
    expect(reload).toHaveBeenCalledWith('/watching/123?tab=season#episode-4')
    expect(location).toEqual({ pathname: '/watching/123', search: '?tab=season', hash: '#episode-4' })
    expect(lifecycle.getState()).toBe('reloading')
    expect(lifecycle.announceReady({ version: 'a' })).toBe(false)
  })

  it('attaches one native controllerchange listener and removes it on cleanup', () => {
    const listeners = new Map()
    const serviceWorkerContainer = {
      addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type, listener) => {
        if (listeners.get(type) === listener) listeners.delete(type)
      }),
    }
    const onControllerChange = vi.fn()
    const remove = installControllerChangeListener({ serviceWorkerContainer, onControllerChange })
    expect(serviceWorkerContainer.addEventListener).toHaveBeenCalledOnce()
    listeners.get('controllerchange')()
    listeners.get('controllerchange')()
    expect(onControllerChange).toHaveBeenCalledTimes(2)
    remove()
    remove()
    expect(serviceWorkerContainer.removeEventListener).toHaveBeenCalledOnce()
    expect(listeners.has('controllerchange')).toBe(false)
  })

  it('handles stale or redundant workers without throwing', async () => {
    const activateAndReload = vi.fn().mockRejectedValue(new Error('worker is gone'))
    const lifecycle = createUpdateLifecycle({ activateAndReload })
    lifecycle.announceReady({ version: 'a' })
    await expect(lifecycle.update()).resolves.toBe(false)
    expect(lifecycle.getState()).toBe('ready')
    expect(lifecycle.handleControllerChange()).toBe(true)
  })

  it('reloads when another tab activates a dismissed update', () => {
    const reload = vi.fn()
    const lifecycle = createUpdateLifecycle({ reload })
    lifecycle.announceReady({ version: 'a' })
    lifecycle.dismiss()
    expect(lifecycle.handleControllerChange()).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('keeps reloading state when controllerchange wins the activation race', async () => {
    let release
    const reload = vi.fn()
    const activateAndReload = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const lifecycle = createUpdateLifecycle({ activateAndReload, reload })
    lifecycle.announceReady({ version: 'a' })
    const update = lifecycle.update()
    expect(lifecycle.handleControllerChange()).toBe(true)
    release()
    await expect(update).resolves.toBe(true)
    expect(lifecycle.getState()).toBe('reloading')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('checks for updates at most once at a time and cleans up its timer', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const setIntervalFn = vi.fn(() => 42)
    const clearIntervalFn = vi.fn()
    const checker = createUpdateChecker({
      registration: { update },
      setIntervalFn,
      clearIntervalFn,
    })
    expect(PWA_UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000)
    expect(checker.start()).toBe(true)
    expect(checker.start()).toBe(false)
    const first = checker.check()
    const second = checker.check()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(update).toHaveBeenCalledOnce()
    checker.stop()
    expect(clearIntervalFn).toHaveBeenCalledWith(42)
    expect(checker.isRunning()).toBe(false)
  })

  it('keeps activation prompt-driven while retaining Workbox cache safety', () => {
    expect(PWA_OPTIONS.workbox.clientsClaim).toBe(true)
    expect(PWA_OPTIONS.workbox.cleanupOutdatedCaches).toBe(true)
    expect(PWA_OPTIONS.workbox.skipWaiting).toBeUndefined()
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
