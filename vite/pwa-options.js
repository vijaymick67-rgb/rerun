export const PWA_THEME_COLOR = '#080b14'

export const PWA_MANIFEST = {
  name: 'Rerun',
  short_name: 'Rerun',
  description: 'A personal TV tracker for keeping up with the shows you watch.',
  display: 'standalone',
  orientation: 'portrait-primary',
  start_url: '/',
  scope: '/',
  theme_color: PWA_THEME_COLOR,
  background_color: PWA_THEME_COLOR,
  categories: ['entertainment', 'lifestyle'],
  icons: [
    {
      src: '/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/icon-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
}

export const PWA_NAVIGATION_FALLBACK_DENYLIST = [
  /^\/api\//,
  /^\/supabase\//,
  /^\/auth\//,
  /^\/rest\/v1\//,
  /^\/functions\/v1\//,
]

export const PWA_NEVER_CACHE_PATTERNS = [
  /^\/api\//,
  /^\/supabase\//,
  /^\/auth\//,
  /^\/rest\/v1\//,
  /^\/storage\/v1\//,
  /^\/functions\/v1\//,
  /supabase\.co/i,
  /api\.tvmaze\.com/i,
]

export const PWA_IMAGE_PATTERN = /^https:\/\/image\.tmdb\.org\/t\/p\//i
export const PWA_IMAGE_CACHE_NAME = 'rerun-tmdb-images'
export const PWA_IMAGE_CACHE_MAX_ENTRIES = 120
export const PWA_IMAGE_CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

export function isNavigationFallbackAllowed(pathname) {
  return !PWA_NAVIGATION_FALLBACK_DENYLIST.some((pattern) => pattern.test(pathname))
}

export function isSensitiveRequestUrl(url) {
  return PWA_NEVER_CACHE_PATTERNS.some((pattern) => pattern.test(url))
}

export function shouldCacheRuntimeRequest(url, { method = 'GET', destination = 'image' } = {}) {
  if (method !== 'GET' || destination !== 'image') return false
  if (isSensitiveRequestUrl(url)) return false
  return PWA_IMAGE_PATTERN.test(url)
}

export const PWA_OPTIONS = {
  registerType: 'prompt',
  strategies: 'generateSW',
  includeAssets: ['favicon.svg', 'rerun-icon.svg', 'apple-touch-icon.png'],
  manifest: PWA_MANIFEST,
  workbox: {
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    navigateFallback: '/index.html',
    navigateFallbackDenylist: PWA_NAVIGATION_FALLBACK_DENYLIST,
    globPatterns: ['**/*.{js,css,html,woff,woff2}'],
    // Adds push + notificationclick handling to the generated service worker
    // without migrating off generateSW — see public/push-sw.js. Workbox
    // inlines this as a literal `importScripts("push-sw.js")` call at the
    // very top of the generated sw.js, before its own precaching/update
    // lifecycle code, so it only ever adds listeners and never touches that
    // lifecycle (PRs #79–#81).
    importScripts: ['push-sw.js'],
    runtimeCaching: [
      {
        urlPattern: PWA_IMAGE_PATTERN,
        handler: 'CacheFirst',
        options: {
          cacheName: PWA_IMAGE_CACHE_NAME,
          cacheableResponse: { statuses: [0, 200] },
          expiration: {
            maxEntries: PWA_IMAGE_CACHE_MAX_ENTRIES,
            maxAgeSeconds: PWA_IMAGE_CACHE_MAX_AGE_SECONDS,
          },
        },
      },
    ],
  },
}
