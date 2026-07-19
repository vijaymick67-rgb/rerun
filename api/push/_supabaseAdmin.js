import { createClient } from '@supabase/supabase-js'

// push_subscriptions has every privilege revoked from anon/authenticated
// (see the migration), so it's reachable only through the service-role key,
// server-side. The project URL itself isn't sensitive — it's already public
// in the client bundle via VITE_SUPABASE_URL — so it's reused here rather
// than duplicated under a second env var name.
export function createSupabaseAdmin(env = process.env) {
  const url = env.VITE_SUPABASE_URL
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) {
    throw new Error('Supabase server credentials are not configured')
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
