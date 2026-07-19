import { urlBase64ToUint8Array } from './vapidKey.js'

// Must only be called from an explicit user tap (e.g. the "Enable
// notifications" button's onClick) — never from an effect on mount. iOS in
// particular treats an unprompted call as an abuse signal.
export async function requestNotificationPermission(notificationApi = globalThis.Notification) {
  if (!notificationApi) return 'unsupported'
  if (notificationApi.permission === 'granted' || notificationApi.permission === 'denied') {
    return notificationApi.permission
  }
  return notificationApi.requestPermission()
}

export async function getServiceWorkerRegistration(
  serviceWorkerContainer = globalThis.navigator?.serviceWorker,
) {
  if (!serviceWorkerContainer?.ready) return null
  return serviceWorkerContainer.ready
}

export async function getExistingPushSubscription(registration) {
  if (!registration?.pushManager) return null
  return registration.pushManager.getSubscription()
}

// Reuses a subscription already registered with the browser's push service
// instead of creating a duplicate — calling subscribe() again with the same
// applicationServerKey is also safe, but skipping it avoids an unnecessary
// permission-adjacent browser call.
export async function subscribeToPush(registration, vapidPublicKey) {
  if (!registration?.pushManager) {
    throw new Error('No active service worker registration.')
  }
  const existing = await getExistingPushSubscription(registration)
  if (existing) return existing
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  })
}

export async function unsubscribeFromPush(subscription) {
  if (!subscription) return true
  return subscription.unsubscribe()
}
