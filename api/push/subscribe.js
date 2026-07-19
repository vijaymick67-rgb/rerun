import { createSupabaseAdmin } from './_supabaseAdmin.js'
import { validateSubscriptionPayload } from './_validation.js'
import { generateManagementToken, hashManagementToken } from './_managementToken.js'

export const config = { runtime: 'nodejs' }

// This is a personal, single-user app with no auth — realistically 1-3
// devices ever subscribe. This cap exists purely to bound how far the
// public subscribe endpoint can be abused to grow the table with junk rows,
// not as a real per-user quota.
const MAX_PUSH_SUBSCRIPTIONS = 20

// First-run flood protection for Phase 2 (automatic episode notifications):
// activation is backdated by this much so an episode that became available
// moments before a subscribe call isn't missed purely due to request timing
// during setup/deployment, while still being far too small to backfill any
// real backlog.
const ACTIVATION_GRACE_WINDOW_MS = 30 * 60 * 1000

function json(res, status, body) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.json(body)
}

export function createSubscribeHandler({ env = process.env, supabase } = {}) {
  return async function subscribeHandler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      json(res, 405, { error: 'Method not allowed' })
      return
    }

    const result = validateSubscriptionPayload(req.body)
    if (!result.valid) {
      json(res, 400, { error: result.error })
      return
    }

    let client
    try {
      client = supabase ?? createSupabaseAdmin(env)
    } catch {
      json(res, 500, { error: 'Push notifications are not configured' })
      return
    }

    const { data: existingRow, error: lookupError } = await client
      .from('push_subscriptions')
      .select('id, automatic_notifications_enabled_at')
      .eq('endpoint', result.endpoint)
      .maybeSingle()
    if (lookupError) {
      console.error('push_subscribe_lookup_failed', { message: lookupError.message })
      json(res, 500, { error: 'Could not save subscription' })
      return
    }

    // Only enforce the cap for genuinely new rows — re-subscribing an
    // already-stored endpoint must never be blocked by it.
    if (!existingRow) {
      const { count, error: countError } = await client
        .from('push_subscriptions')
        .select('id', { count: 'exact', head: true })
      if (countError) {
        console.error('push_subscribe_count_failed', { message: countError.message })
        json(res, 500, { error: 'Could not save subscription' })
        return
      }
      if ((count ?? 0) >= MAX_PUSH_SUBSCRIPTIONS) {
        json(res, 429, { error: 'Too many stored subscriptions' })
        return
      }
    }

    const userAgentHeader = req.headers?.['user-agent']
    const userAgent = typeof userAgentHeader === 'string' ? userAgentHeader.slice(0, 512) : null

    // Rotated on every successful subscribe call, including re-subscribes —
    // the raw token is only ever returned here, once; only its hash is
    // persisted.
    const managementToken = generateManagementToken()
    const managementTokenHash = hashManagementToken(managementToken)

    // Set once per subscription, never overwritten on a later re-subscribe —
    // this is the Phase 2 activation watermark (see
    // supabase/migrations/20260719140000_add_automatic_episode_notifications.sql).
    // A brand-new row, or an existing Phase 1-only row that has never
    // activated automatic notifications, gets backdated by the grace window;
    // an already-activated row keeps its original timestamp exactly.
    const automaticNotificationsEnabledAt =
      existingRow?.automatic_notifications_enabled_at ??
      new Date(Date.now() - ACTIVATION_GRACE_WINDOW_MS).toISOString()

    const { error } = await client.from('push_subscriptions').upsert(
      {
        endpoint: result.endpoint,
        p256dh: result.p256dh,
        auth: result.auth,
        user_agent: userAgent,
        management_token_hash: managementTokenHash,
        automatic_notifications_enabled_at: automaticNotificationsEnabledAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    )

    if (error) {
      console.error('push_subscribe_failed', { message: error.message })
      json(res, 500, { error: 'Could not save subscription' })
      return
    }

    json(res, 200, { success: true, managementToken })
  }
}

export default createSubscribeHandler()
