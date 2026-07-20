// One-time handling of Supabase's OAuth error redirect. Google returns to
// `redirectTo` (always `${origin}/` — see supabase.auth.signInWithOAuth in
// Login.jsx) with `error`/`error_code`/`error_description` query params
// appended when the attempt was cancelled or failed. A *successful* sign-in
// carries the session in the URL hash instead, which the Supabase client
// itself consumes and strips (detectSessionInUrl in src/lib/supabase.js) —
// this helper only ever deals with the failure case.
//
// Adapted from Finflow's src/lib/oauthCallback.js. Rerun has no linking flow
// and no route-based redirect-before-mount (AuthGate renders Login in place,
// it never navigates away), so the `google_link` param and the path check
// Finflow needed are both dropped here.

const OAUTH_ERROR_PARAM_KEYS = ['error', 'error_code', 'error_description']

function clearOAuthErrorParams() {
  const params = new URLSearchParams(window.location.search)
  let changed = false
  for (const key of OAUTH_ERROR_PARAM_KEYS) {
    if (params.has(key)) {
      params.delete(key)
      changed = true
    }
  }
  if (!changed) return

  const newSearch = params.toString()
  const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash
  window.history.replaceState({}, '', newUrl)
}

// Call once, on boot. Returns a calm user-facing message if Google reported
// an error, or null otherwise. Always strips the params it consumed so a
// page refresh never replays the same stale error.
export function consumeOAuthCallbackError() {
  const params = new URLSearchParams(window.location.search)
  const hasError = params.has('error') || params.has('error_code')
  if (!hasError) return null

  clearOAuthErrorParams()
  return 'Google sign-in was cancelled or failed. Please try again.'
}
