async function postJson(url, body, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    // No/invalid JSON body — fall through to status-based error below.
  }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`)
  }
  return data
}

// Upserts by endpoint — safe to call repeatedly for the same subscription.
export async function subscribePush(subscription, fetchImpl = fetch) {
  return postJson('/api/push/subscribe', subscription.toJSON(), fetchImpl)
}

// managementToken proves this browser install owns the subscription being
// removed — the server rejects a bare endpoint with no matching token.
export async function unsubscribePush(endpoint, managementToken, fetchImpl = fetch) {
  return postJson('/api/push/unsubscribe', { endpoint, managementToken }, fetchImpl)
}

// Sends a manual test push to the caller's own stored subscription — this
// endpoint never accepts a caller-supplied target, and never broadcasts to
// any subscription other than the one the managementToken proves ownership of.
export async function sendTestPush(managementToken, fetchImpl = fetch) {
  return postJson('/api/push/test', { managementToken }, fetchImpl)
}

// Sends a synthetic episode-style push to the caller's own stored
// subscription, exercising the Phase 2 payload/template path (not a real
// tracked-show notification) — physical-device verification only.
export async function verifyAutomaticEpisodePush(managementToken, fetchImpl = fetch) {
  return postJson('/api/notifications/verify', { managementToken }, fetchImpl)
}

// Updates the caller's own preferred automatic-notification delivery hour
// (18-23 = 6 PM-11 PM IST). Like sendTestPush/verifyAutomaticEpisodePush,
// this never accepts or sends a caller-supplied subscription endpoint —
// ownership is proven by managementToken alone.
export async function updateNotificationPreference(managementToken, preferredNotificationHourIst, fetchImpl = fetch) {
  return postJson('/api/push/preferences', { managementToken, preferredNotificationHourIst }, fetchImpl)
}
