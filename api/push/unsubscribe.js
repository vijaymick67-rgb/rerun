import { createSupabaseAdmin } from './_supabaseAdmin.js'

export const config = { runtime: 'nodejs' }

function json(res, status, body) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.json(body)
}

export function createUnsubscribeHandler({ env = process.env, supabase } = {}) {
  return async function unsubscribeHandler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      json(res, 405, { error: 'Method not allowed' })
      return
    }

    const endpoint = req.body?.endpoint
    if (typeof endpoint !== 'string' || endpoint.trim() === '') {
      json(res, 400, { error: 'Invalid endpoint' })
      return
    }

    let client
    try {
      client = supabase ?? createSupabaseAdmin(env)
    } catch {
      json(res, 500, { error: 'Push notifications are not configured' })
      return
    }

    const { error } = await client.from('push_subscriptions').delete().eq('endpoint', endpoint)
    if (error) {
      console.error('push_unsubscribe_failed', { message: error.message })
      json(res, 500, { error: 'Could not remove subscription' })
      return
    }

    json(res, 200, { success: true })
  }
}

export default createUnsubscribeHandler()
