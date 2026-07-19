// Push + notification-click handling for the installed Rerun PWA.
//
// This file is pulled into the Workbox-generated service worker via
// `importScripts()` (see workbox.importScripts in vite/pwa-options.js) so
// vite-plugin-pwa can keep using `strategies: 'generateSW'` — it owns the
// precaching, navigation fallback, and update lifecycle (PRs #79–#81) —
// while this adds the two event listeners Workbox itself never registers.
// Runs in the same global scope as the generated sw.js; only ever adds
// listeners, never removes or replaces anything Workbox sets up.

const PUSH_FALLBACK_TITLE = 'Rerun'
const PUSH_FALLBACK_BODY = 'You have a new notification.'
const PUSH_ICON = '/icon-192.png'
const PUSH_BADGE = '/icon-192.png'
const PUSH_DEFAULT_URL = '/watching'

function parsePushPayload(event) {
  if (!event.data) return null
  try {
    return event.data.json()
  } catch {
    // Not JSON — fall back to the fallback title/body below rather than
    // guessing at plain-text structure.
    return null
  }
}

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event) || {}
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title : PUSH_FALLBACK_TITLE
  const url = typeof payload.url === 'string' && payload.url.trim() ? payload.url : PUSH_DEFAULT_URL
  const hasRealBody = typeof payload.body === 'string' && payload.body.trim()
  // `omitBody: true` (automatic episode notifications — see
  // src/lib/notifications/episodeEligibility.js) means the missing body is
  // intentional: iOS already shows "from Rerun" on its own for the
  // installed PWA, so a second body line would be redundant. Anything else
  // with no real body — a malformed payload, or a future payload shape that
  // forgets to set body — is treated as before and gets the generic
  // fallback text, not silently left blank.
  const omitBody = payload.omitBody === true

  // Automatic episode notifications (Phase 2) carry a stable per-show/episode
  // tag (see src/lib/notifications/episodeEligibility.js) so a redelivered
  // push for the same logical event replaces the existing OS notification
  // instead of stacking a visual duplicate. The Phase 1 manual test push
  // carries no tag and falls back to the browser's default (untagged)
  // behavior, unchanged from before.
  const options = { icon: PUSH_ICON, badge: PUSH_BADGE, data: { url } }
  if (hasRealBody) options.body = payload.body
  else if (!omitBody) options.body = PUSH_FALLBACK_BODY
  if (typeof payload.tag === 'string' && payload.tag.trim()) options.tag = payload.tag

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || PUSH_DEFAULT_URL

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl)
      return undefined
    }),
  )
})
