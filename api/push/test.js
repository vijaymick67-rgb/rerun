import webpush from 'web-push'
import { createSupabaseAdmin } from './_supabaseAdmin.js'

export const config = { runtime: 'nodejs' }

// Manual test only — this endpoint never accepts a caller-supplied target,
// it only ever sends to whatever is already stored in push_subscriptions.
export const TEST_NOTIFICATION_TITLE = 'Rerun notifications are working'
export const TEST_NOTIFICATION_BODY = "You'll be notified when new episodes are ready."
export const TEST_NOTIFICATION_URL = '/watching'

// Basic abuse guard for a personal, unauthenticated endpoint: don't let a
// single subscription be re-pushed faster than this.
const MIN_RESEND_INTERVAL_MS = 30 * 1000

function json(res, status, body) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.json(body)
}

export function createTestPushHandler({
  env = process.env,
  supabase,
  sendNotification = (subscription, payload) => webpush.sendNotification(subscription, payload),
  setVapidDetails = (...args) => webpush.setVapidDetails(...args),
  now = () => new Date(),
} = {}) {
  return async function testPushHandler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      json(res, 405, { error: 'Method not allowed' })
      return
    }

    const publicKey = env.VITE_VAPID_PUBLIC_KEY
    const privateKey = env.VAPID_PRIVATE_KEY
    const subject = env.VAPID_SUBJECT
    if (!publicKey || !privateKey || !subject) {
      json(res, 500, { error: 'Push notifications are not configured' })
      return
    }
    setVapidDetails(subject, publicKey, privateKey)

    let client
    try {
      client = supabase ?? createSupabaseAdmin(env)
    } catch {
      json(res, 500, { error: 'Push notifications are not configured' })
      return
    }

    const { data: subscriptions, error } = await client
      .from('push_subscriptions')
      .select('*')
      .order('updated_at', { ascending: false })
    if (error) {
      console.error('push_test_read_failed', { message: error.message })
      json(res, 500, { error: 'Could not read stored subscription' })
      return
    }
    if (!subscriptions || subscriptions.length === 0) {
      json(res, 404, { error: 'No stored subscription — enable notifications first' })
      return
    }

    const nowMs = now().getTime()
    const payload = JSON.stringify({
      title: TEST_NOTIFICATION_TITLE,
      body: TEST_NOTIFICATION_BODY,
      url: TEST_NOTIFICATION_URL,
    })

    let sent = 0
    let rateLimited = 0
    const staleEndpoints = []
    let lastError = null

    for (const row of subscriptions) {
      const lastSentMs = row.last_test_sent_at ? new Date(row.last_test_sent_at).getTime() : 0
      if (nowMs - lastSentMs < MIN_RESEND_INTERVAL_MS) {
        rateLimited += 1
        continue
      }

      const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }
      try {
        await sendNotification(subscription, payload)
        sent += 1
        await client
          .from('push_subscriptions')
          .update({ last_test_sent_at: now().toISOString() })
          .eq('endpoint', row.endpoint)
      } catch (err) {
        const statusCode = err?.statusCode
        if (statusCode === 404 || statusCode === 410) {
          staleEndpoints.push(row.endpoint)
          await client.from('push_subscriptions').delete().eq('endpoint', row.endpoint)
        } else {
          lastError = err
          console.error('push_test_send_failed', { statusCode, message: err?.message })
        }
      }
    }

    if (sent > 0) {
      json(res, 200, { success: true, sent, staleRemoved: staleEndpoints.length })
      return
    }
    if (staleEndpoints.length > 0) {
      json(res, 410, { error: 'Subscription expired and was removed — enable notifications again' })
      return
    }
    if (rateLimited > 0) {
      json(res, 429, { error: 'A test notification was sent recently — try again shortly' })
      return
    }
    json(res, 502, { error: lastError?.message || 'Could not deliver test notification' })
  }
}

export default createTestPushHandler()
