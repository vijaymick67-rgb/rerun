// Local-only flag so Settings only re-POSTs the existing subscription (which
// rotates the management token and, server-side, sets the Phase 2 activation
// watermark the first time it's null — see api/push/subscribe.js) once per
// installation instead of on every app open. It is not itself a source of
// truth: the real activation state lives server-side on the subscription
// row, so a cleared/missing flag just means the next mount safely re-sends
// the same idempotent request.
const STORAGE_KEY = 'rerun:push:automaticNotificationsActivated'

export function getAutomaticNotificationsActivated(storage = globalThis.localStorage) {
  if (!storage) return false
  try {
    return storage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function setAutomaticNotificationsActivated(activated, storage = globalThis.localStorage) {
  if (!storage) return
  try {
    if (activated) storage.setItem(STORAGE_KEY, 'true')
    else storage.removeItem(STORAGE_KEY)
  } catch {
    // Private-browsing/quota-exceeded storage errors just mean the flag
    // isn't persisted — not fatal, the next mount safely retries.
  }
}
