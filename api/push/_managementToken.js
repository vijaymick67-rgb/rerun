import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Generated fresh on every successful /api/push/subscribe call (including
// re-subscribes of an already-stored endpoint) and returned to the caller
// exactly once — only its SHA-256 hash is ever persisted. Presenting the raw
// token later is how /api/push/test and /api/push/unsubscribe confirm the
// caller is the same browser install that created the subscription, without
// adding real authentication to an otherwise no-auth app.
export function generateManagementToken() {
  return randomBytes(32).toString('base64url')
}

export function hashManagementToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function managementTokenMatches(token, storedHash) {
  if (typeof token !== 'string' || token.length === 0) return false
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false
  const candidate = Buffer.from(hashManagementToken(token), 'hex')
  const stored = Buffer.from(storedHash, 'hex')
  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}
