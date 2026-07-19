// PushManager.subscribe() requires the VAPID public key as a raw
// Uint8Array, but it's distributed (env var, server response) as a
// URL-safe base64 string. This is the standard conversion.
export function urlBase64ToUint8Array(base64String) {
  if (typeof base64String !== 'string' || base64String.trim() === '') {
    throw new Error('A VAPID public key is required.')
  }
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
