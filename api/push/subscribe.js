import { createSupabaseAdmin } from './_supabaseAdmin.js'
import { validateSubscriptionPayload } from './_validation.js'

export const config = { runtime: 'nodejs' }

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

    const userAgentHeader = req.headers?.['user-agent']
    const userAgent = typeof userAgentHeader === 'string' ? userAgentHeader.slice(0, 512) : null

    const { error } = await client.from('push_subscriptions').upsert(
      {
        endpoint: result.endpoint,
        p256dh: result.p256dh,
        auth: result.auth,
        user_agent: userAgent,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    )

    if (error) {
      console.error('push_subscribe_failed', { message: error.message })
      json(res, 500, { error: 'Could not save subscription' })
      return
    }

    json(res, 200, { success: true })
  }
}

export default createSubscribeHandler()
