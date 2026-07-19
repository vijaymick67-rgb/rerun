// Known Web Push service hosts. The subscribe endpoint stores whatever
// endpoint URL the browser reports, and the test-send endpoint later POSTs
// to it server-side — without this allow-list, a forged endpoint could turn
// the test-send endpoint into an open SSRF relay. This is a personal app
// with no auth, so this allow-list (plus the fact that only known-shape
// subscriptions get stored at all) is the actual line of defense here.
const ALLOWED_ENDPOINT_HOST_SUFFIXES = [
  'web.push.apple.com',
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
]

function isAllowedPushHost(hostname) {
  return ALLOWED_ENDPOINT_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  )
}

function isBase64Url(value) {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9_-]+=*$/.test(value)
}

function base64UrlByteLength(value) {
  const stripped = value.replace(/=+$/, '')
  const padded = stripped + '='.repeat((4 - (stripped.length % 4)) % 4)
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length
}

// Validates the shape PushSubscription.toJSON() produces:
// { endpoint, keys: { p256dh, auth }, expirationTime }
export function validateSubscriptionPayload(body) {
  if (!body || typeof body !== 'object') return { valid: false, error: 'Missing subscription payload' }

  const { endpoint, keys } = body
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) {
    return { valid: false, error: 'Invalid subscription endpoint' }
  }

  let url
  try {
    url = new URL(endpoint)
  } catch {
    return { valid: false, error: 'Invalid subscription endpoint' }
  }
  if (url.protocol !== 'https:' || !isAllowedPushHost(url.hostname)) {
    return { valid: false, error: 'Unrecognized push service endpoint' }
  }

  if (!keys || typeof keys !== 'object') return { valid: false, error: 'Missing subscription keys' }
  const { p256dh, auth } = keys

  // Uncompressed P-256 public key: 0x04 prefix + 32-byte x + 32-byte y.
  if (!isBase64Url(p256dh) || base64UrlByteLength(p256dh) !== 65) {
    return { valid: false, error: 'Invalid p256dh key' }
  }
  // 16-byte shared authentication secret.
  if (!isBase64Url(auth) || base64UrlByteLength(auth) !== 16) {
    return { valid: false, error: 'Invalid auth key' }
  }

  return { valid: true, endpoint, p256dh, auth }
}
