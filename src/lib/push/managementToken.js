// Holds the opaque per-installation token returned once by
// /api/push/subscribe. It proves to /api/push/test and /api/push/unsubscribe
// that this browser install owns the stored subscription — localStorage
// keeps it around across reloads, unlike component state.
const STORAGE_KEY = 'rerun:push:managementToken'

export function getStoredManagementToken(storage = globalThis.localStorage) {
  if (!storage) return null
  try {
    return storage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setStoredManagementToken(token, storage = globalThis.localStorage) {
  if (!storage) return
  try {
    if (token) storage.setItem(STORAGE_KEY, token)
    else storage.removeItem(STORAGE_KEY)
  } catch {
    // Private-browsing/quota-exceeded storage errors just mean the token
    // isn't persisted — not fatal, the next enable/disable tap recovers.
  }
}

export function clearStoredManagementToken(storage = globalThis.localStorage) {
  setStoredManagementToken(null, storage)
}
