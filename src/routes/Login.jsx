import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

// Rerun-native login — no Finflow visual components. Owner-only: Google is
// the primary and only prominent action, recovery (email/password) is
// reachable but deliberately subtle, and there is no signup action anywhere
// on this screen. Rendered by AuthGate whenever status is 'unauthenticated',
// 'oauth-error', or 'unauthorized' — never inside the app shell/TabBar.
export default function Login() {
  const { message, clearMessage } = useAuth()
  const [showRecovery, setShowRecovery] = useState(false)
  const [googleSubmitting, setGoogleSubmitting] = useState(false)
  const [googleError, setGoogleError] = useState(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [recoveryError, setRecoveryError] = useState(null)

  const topMessage = message ?? googleError

  async function handleGoogleLogin() {
    if (googleSubmitting) return
    clearMessage()
    setGoogleError(null)
    setGoogleSubmitting(true)
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/` },
      })
      if (error) {
        setGoogleError('Google sign-in failed. Please try again.')
        setGoogleSubmitting(false)
      }
      // On success the browser navigates away to Google — nothing further
      // to do here, this component unmounts.
    } catch {
      setGoogleError('Google sign-in failed. Please try again.')
      setGoogleSubmitting(false)
    }
  }

  function openRecovery() {
    clearMessage()
    setGoogleError(null)
    setRecoveryError(null)
    setShowRecovery(true)
  }

  function closeRecovery() {
    setRecoveryError(null)
    setShowRecovery(false)
  }

  async function handleRecoverySubmit(event) {
    event.preventDefault()
    if (submitting) return
    clearMessage()
    setRecoveryError(null)
    setSubmitting(true)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    setSubmitting(false)
    if (error) {
      setRecoveryError('Incorrect email or password.')
    }
    // On success, AuthContext's onAuthStateChange picks up the new session
    // and AuthGate swaps this screen out for the boot shell while ownership
    // is confirmed — no local "success" state needed here.
  }

  return (
    <div className="auth-screen">
      <div className="auth-screen__panel">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img src="/rerun-icon.svg" alt="" className="h-16 w-16" />
          <h1 className="type-page-title text-(--color-text)">Rerun</h1>
          <p className="type-body text-(--color-text-secondary)">
            Personal watch log. Owner-only access.
          </p>
        </div>

        <div className="surface-card p-5">
          {showRecovery ? (
            <form onSubmit={handleRecoverySubmit} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="type-metadata text-(--color-text-secondary)">Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="surface-interactive focus-ring type-body min-h-11 px-3 py-2 text-(--color-text)"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="type-metadata text-(--color-text-secondary)">Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="surface-interactive focus-ring type-body min-h-11 px-3 py-2 text-(--color-text)"
                />
              </label>

              {recoveryError && (
                <p role="alert" aria-live="assertive" className="status-banner status-banner--destructive type-body">
                  {recoveryError}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="focus-ring motion-press min-h-11 rounded-md bg-(--color-accent) px-4 py-2.5 text-sm font-semibold text-(--color-canvas) disabled:opacity-60"
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>

              <button
                type="button"
                onClick={closeRecovery}
                className="focus-ring motion-press min-h-11 text-center text-xs font-medium text-(--color-text-muted) underline"
              >
                Back to Google sign-in
              </button>
            </form>
          ) : (
            <div className="flex flex-col gap-4">
              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={googleSubmitting}
                aria-disabled={googleSubmitting}
                className="focus-ring motion-press min-h-11 rounded-md bg-(--color-accent) px-4 py-2.5 text-sm font-semibold text-(--color-canvas) disabled:opacity-60"
              >
                {googleSubmitting ? 'Connecting to Google…' : 'Continue with Google'}
              </button>

              {topMessage && (
                <p role="alert" aria-live="assertive" className="status-banner status-banner--destructive type-body">
                  {topMessage}
                </p>
              )}

              <button
                type="button"
                onClick={openRecovery}
                className="focus-ring motion-press min-h-11 text-center text-xs font-medium text-(--color-text-muted) underline"
              >
                Use recovery login
              </button>

              {/* Reserved for a future "View demo" action (separate PR) —
                  deliberately empty and inert; do not add interactive
                  content here without also revisiting the owner-only gate. */}
              <div data-testid="login-demo-slot" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
