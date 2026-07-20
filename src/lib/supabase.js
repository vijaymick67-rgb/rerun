import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Explicit (rather than relying on the client's defaults) because Rerun now
// depends on session persistence and OAuth redirect handling for owner-only
// auth: the browser session must survive reloads/PWA relaunches
// (persistSession), refresh silently in the background (autoRefreshToken),
// and Google's redirect back to `/` must be parsed into a session
// automatically (detectSessionInUrl) — see src/lib/AuthContext.jsx.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
