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

export async function unsubscribePush(endpoint, fetchImpl = fetch) {
  return postJson('/api/push/unsubscribe', { endpoint }, fetchImpl)
}

// Sends a manual test push to the already-stored subscription(s) — this
// endpoint never accepts a caller-supplied target.
export async function sendTestPush(fetchImpl = fetch) {
  return postJson('/api/push/test', {}, fetchImpl)
}
