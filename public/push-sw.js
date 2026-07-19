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
  const body = typeof payload.body === 'string' && payload.body.trim() ? payload.body : PUSH_FALLBACK_BODY
  const url = typeof payload.url === 'string' && payload.url.trim() ? payload.url : PUSH_DEFAULT_URL

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: PUSH_ICON,
      badge: PUSH_BADGE,
      data: { url },
    }),
  )
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
