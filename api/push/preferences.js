import { createSupabaseAdmin } from './_supabaseAdmin.js'
import { hashManagementToken } from './_managementToken.js'
import {
  isValidPreferredHour,
  MAX_PREFERRED_HOUR_IST,
  MIN_PREFERRED_HOUR_IST,
} from '../../src/lib/notifications/deliverySchedule.js'

export const config = { runtime: 'nodejs' }

function json(res, status, body) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.json(body)
}

// Updates only the caller's own preferred automatic-notification delivery
// hour. Ownership is resolved exclusively by management-token hash — the
// same proof-of-ownership pattern api/push/test.js and
// api/notifications/verify.js already use for a token-only lookup (as
// opposed to api/push/unsubscribe.js, which looks up by a caller-supplied
// endpoint first). This endpoint deliberately never accepts or returns a
// subscription endpoint or push keys, and never rotates the management
// token — it only ever touches preferred_notification_hour_ist.
export function createPreferencesHandler({ env = process.env, supabase } = {}) {
  return async function preferencesHandler(req, res) {
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

    const preferredNotificationHourIst = req.body?.preferredNotificationHourIst
    if (!isValidPreferredHour(preferredNotificationHourIst)) {
      json(res, 400, {
        error: `Notification hour must be an integer from ${MIN_PREFERRED_HOUR_IST} through ${MAX_PREFERRED_HOUR_IST}`,
      })
      return
    }

    let client
    try {
      client = supabase ?? createSupabaseAdmin(env)
    } catch {
      json(res, 500, { error: 'Push notifications are not configured' })
      return
    }

    const managementTokenHash = hashManagementToken(managementToken)
    const { data: row, error: lookupError } = await client
      .from('push_subscriptions')
      .select('id')
      .eq('management_token_hash', managementTokenHash)
      .maybeSingle()
    if (lookupError) {
      console.error('push_preferences_lookup_failed', { message: lookupError.message })
      json(res, 500, { error: 'Could not read stored subscription' })
      return
    }
    if (!row) {
      json(res, 404, { error: 'No stored subscription — enable notifications first' })
      return
    }

    const { error: updateError } = await client
      .from('push_subscriptions')
      .update({ preferred_notification_hour_ist: preferredNotificationHourIst, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    if (updateError) {
      console.error('push_preferences_update_failed', { message: updateError.message })
      json(res, 500, { error: 'Could not save notification time' })
      return
    }

    json(res, 200, { success: true, preferredNotificationHourIst })
  }
}

export default createPreferencesHandler()
