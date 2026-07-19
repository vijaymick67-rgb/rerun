import { createSupabaseAdmin } from './_supabaseAdmin.js'
import { validateSubscriptionPayload } from './_validation.js'
import { generateManagementToken, hashManagementToken } from './_managementToken.js'

export const config = { runtime: 'nodejs' }

// This is a personal, single-user app with no auth — realistically 1-3
// devices ever subscribe. This cap exists purely to bound how far the
// public subscribe endpoint can be abused to grow the table with junk rows,
// not as a real per-user quota.
const MAX_PUSH_SUBSCRIPTIONS = 20

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
      .select('id')
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

    const { error } = await client.from('push_subscriptions').upsert(
      {
        endpoint: result.endpoint,
        p256dh: result.p256dh,
        auth: result.auth,
        user_agent: userAgent,
        management_token_hash: managementTokenHash,
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
