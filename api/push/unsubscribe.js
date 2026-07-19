import { createSupabaseAdmin } from './_supabaseAdmin.js'
import { managementTokenMatches } from './_managementToken.js'

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
    const managementToken = req.body?.managementToken
    if (typeof managementToken !== 'string' || managementToken.trim() === '') {
      json(res, 400, { error: 'Invalid management token' })
      return
    }

    let client
    try {
      client = supabase ?? createSupabaseAdmin(env)
    } catch {
      json(res, 500, { error: 'Push notifications are not configured' })
      return
    }

    // Proves the caller manages this specific subscription before deleting
    // it — a bare endpoint string isn't proof of ownership.
    const { data: row, error: readError } = await client
      .from('push_subscriptions')
      .select('management_token_hash')
      .eq('endpoint', endpoint)
      .maybeSingle()
    if (readError) {
      console.error('push_unsubscribe_lookup_failed', { message: readError.message })
      json(res, 500, { error: 'Could not remove subscription' })
      return
    }
    if (!row) {
      json(res, 404, { error: 'No stored subscription for that endpoint' })
      return
    }
    if (!managementTokenMatches(managementToken, row.management_token_hash)) {
      json(res, 403, { error: 'Not authorized to manage this subscription' })
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
