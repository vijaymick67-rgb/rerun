export function buildNtfyRequest(notification, topic) {
  if (typeof topic !== 'string' || topic.trim() === '') throw new Error('NTFY_TOPIC is required')
  const payload = {
    topic,
    title: notification.title,
    message: notification.body,
  }
  if (notification.attachment) {
    payload.attach = notification.attachment.url
    payload.filename = notification.attachment.filename
  }
  return {
    url: 'https://ntfy.sh',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    },
  }
}

export async function publishNtfy(notification, { topic, fetchImpl = fetch }) {
  const request = buildNtfyRequest(notification, topic)
  const response = await fetchImpl(request.url, request.init)
  if (!response.ok) {
    throw new Error(`ntfy push failed (${response.status})`)
  }
  return response
}

