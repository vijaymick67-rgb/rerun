import webpush from 'web-push'
import { createSupabaseAdmin } from '../push/_supabaseAdmin.js'
import { hashManagementToken } from '../push/_managementToken.js'
import { buildEpisodeNotificationPayload } from '../../src/lib/notifications/episodeEligibility.js'

export const config = { runtime: 'nodejs' }

// A synthetic show/episode used only for physical-device verification of the
// Phase 2 pipeline. Negative tmdbShowId can never collide with a real TMDB
// show id, so this can never be mistaken for (or interfere with) a real
// tracked show or a real automatic delivery. This endpoint never reads or
// writes tracked_shows or watched_episodes — it goes straight from a
// hard-coded synthetic episode to a real push send.
export const SYNTHETIC_TMDB_SHOW_ID = -1
export const SYNTHETIC_SHOW_NAME = 'Rerun Verification'
export const SYNTHETIC_EPISODE = { seasonNumber: 1, episodeNumber: 1, name: 'Verification episode' }

// Reuses the exact same throttle column/window as the Phase 1 manual test
// endpoint (api/push/test.js) — this is the same kind of manually-triggered
// "send me something now" action, just exercising the Phase 2 content
// template instead of the fixed Phase 1 test copy.
const MIN_RESEND_INTERVAL_MS = 30 * 1000

function json(res, status, body) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.json(body)
}

// Not the real scheduled worker: no tracked-show scan, no TMDB/TVmaze calls,
// no notification_deliveries claim. It proves two things end-to-end on the
// owner's real device — (1) buildEpisodeNotificationPayload (the same
// template/grouping code api/notifications/run.js uses) produces a real,
// deliverable push, and (2) the push channel itself still works — without
// waiting for a real episode to air.
export function createVerifyNotificationHandler({
  env = process.env,
  supabase,
  sendNotification = (subscription, payload) => webpush.sendNotification(subscription, payload),
  setVapidDetails = (...args) => webpush.setVapidDetails(...args),
  now = () => new Date(),
} = {}) {
  return async function verifyNotificationHandler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      json(res, 405, { error: 'Method not allowed' })
      return
    }

    const managementToken = req.body?.managementToken
    if (typeof managementToken !== 'string' || managementToken.trim() === '') {
      json(res, 400, { error: 'Invalid management token' })
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

    const managementTokenHash = hashManagementToken(managementToken)
    const { data: row, error } = await client
      .from('push_subscriptions')
      .select('*')
      .eq('management_token_hash', managementTokenHash)
      .maybeSingle()
    if (error) {
      console.error('notification_verify_read_failed', { message: error.message })
      json(res, 500, { error: 'Could not read stored subscription' })
      return
    }
    if (!row) {
      json(res, 404, { error: 'No stored subscription — enable notifications first' })
      return
    }

    const nowMs = now().getTime()
    const lastSentMs = row.last_test_sent_at ? new Date(row.last_test_sent_at).getTime() : 0
    if (nowMs - lastSentMs < MIN_RESEND_INTERVAL_MS) {
      json(res, 429, { error: 'A verification notification was sent recently — try again shortly' })
      return
    }

    const payload = buildEpisodeNotificationPayload(SYNTHETIC_TMDB_SHOW_ID, SYNTHETIC_SHOW_NAME, [SYNTHETIC_EPISODE])
    const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }

    try {
      await sendNotification(subscription, JSON.stringify(payload))
      await client
        .from('push_subscriptions')
        .update({ last_test_sent_at: now().toISOString() })
        .eq('endpoint', row.endpoint)
      json(res, 200, { success: true, synthetic: true })
    } catch (err) {
      const statusCode = err?.statusCode
      if (statusCode === 404 || statusCode === 410) {
        await client.from('push_subscriptions').delete().eq('endpoint', row.endpoint)
        json(res, 410, { error: 'Subscription expired and was removed — enable notifications again' })
        return
      }
      console.error('notification_verify_send_failed', { statusCode, message: err?.message })
      json(res, 502, { error: err?.message || 'Could not deliver verification notification' })
    }
  }
}

export default createVerifyNotificationHandler()
