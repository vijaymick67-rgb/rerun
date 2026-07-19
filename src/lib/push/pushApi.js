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
