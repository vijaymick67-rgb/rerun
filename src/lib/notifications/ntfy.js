export function buildNtfyRequest(notification, topic) {
  if (!topic) throw new Error('NTFY_TOPIC is required')
  const headers = {
    Title: notification.title,
    'Content-Type': 'text/plain; charset=utf-8',
  }
  if (notification.attachment) {
    headers.Attach = notification.attachment.url
    headers.Filename = notification.attachment.filename
  }
  return {
    url: `https://ntfy.sh/${encodeURIComponent(topic)}`,
    init: { method: 'POST', headers, body: notification.body },
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
