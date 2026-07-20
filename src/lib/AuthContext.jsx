// Central owner-only auth state machine. Rerun is a single-owner app: the
// only thing this context ever grants is "the current Supabase session
// belongs to the registered owner" (public.current_user_is_owner(), see
// supabase/migrations/20260720130000_add_owner_auth_infrastructure.sql).
// Row Level Security — not this file — is the real security boundary; this
// context exists purely to decide what the UI shows and to actively reject
// (sign out) a non-owner session per the product spec.
//
// States (status):
//   booting                  initial getSession() still in flight
//   unauthenticated           no session
//   oauth-error                no session, and the OAuth redirect carried an
//                             error — same render as unauthenticated, plus
//                             `message`
//   checking-owner             a session exists, current_user_is_owner() is
//                             in flight
//   authenticated-owner        session confirmed to belong to the owner —
//                             the only status that may mount private routes
//   unauthorized                session confirmed NOT to belong to the
//                             owner — mid sign-out, private app stays
//                             unmounted
//   offline-auth-unavailable   session exists but ownership could not be
//                             confirmed (network/RPC failure) — never signs
//                             out, never mounts private routes
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { consumeOAuthCallbackError } from './oauthCallback'

const AuthContext = createContext(undefined)

const REJECTION_MESSAGE = "You're not the owner."

const SIGN_OUT_WARNING =
  'Sign-out could not be confirmed with the server, but local access has been revoked on this device.'

export function AuthProvider({ children }) {
  const [status, setStatus] = useState('booting')
  const [session, setSession] = useState(null)
  const [message, setMessage] = useState(null)
  const [signOutError, setSignOutError] = useState(null)

  const sessionRef = useRef(null)
  const lastProcessedTokenRef = useRef(null)
  const rejectionLatchRef = useRef(new Set())
  const processSessionRef = useRef(null)
  // Bumped on every owner-check attempt (and on any event that supersedes
  // one, e.g. a later SIGNED_IN/SIGNED_OUT). An in-flight RPC whose
  // requestId no longer matches this ref is stale and must not touch state —
  // otherwise a slow check for an old session could resolve after a newer
  // session has already taken over and authenticate/reject the wrong one.
  const requestIdRef = useRef(0)

  const updateSession = useCallback((next) => {
    sessionRef.current = next
    setSession(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    const oauthError = consumeOAuthCallbackError()
    if (oauthError) setMessage(oauthError)

    async function processSession(nextSession, { force = false } = {}) {
      if (cancelled) return

      if (!nextSession) {
        updateSession(null)
        setStatus(oauthError ? 'oauth-error' : 'unauthenticated')
        return
      }

      const token = nextSession.access_token
      if (!force && lastProcessedTokenRef.current === token) {
        // Duplicate event (StrictMode double-invoke, a repeated SIGNED_IN,
        // or an already-processed INITIAL_SESSION racing getSession()) for a
        // session we've already resolved — refresh the stored session object
        // without re-running the RPC or touching status.
        updateSession(nextSession)
        return
      }

      lastProcessedTokenRef.current = token
      updateSession(nextSession)
      setStatus('checking-owner')

      const requestId = ++requestIdRef.current
      const { data, error } = await supabase.rpc('current_user_is_owner')
      // A newer processSession call (a different, later session) may have
      // started and even finished while this RPC was in flight. If so, this
      // result is stale — discard it rather than let it authenticate,
      // reject, or sign out a session that is no longer current.
      if (cancelled || requestId !== requestIdRef.current) return

      if (error) {
        // Cannot confirm ownership right now (most likely offline). Fail
        // closed toward "don't mount the private app", but this is
        // explicitly NOT the same as "not the owner" — never sign out here.
        setStatus('offline-auth-unavailable')
        return
      }

      if (data === true) {
        setStatus('authenticated-owner')
        return
      }

      // data === false: a real, non-owner session. Latch so a duplicate
      // event for this same token can't run the rejection sequence twice.
      if (rejectionLatchRef.current.has(token)) return
      rejectionLatchRef.current.add(token)

      setMessage(REJECTION_MESSAGE)
      setStatus('unauthorized')
      let signOutFailed = false
      try {
        // Local scope only: rejecting this device must not terminate the
        // owner's (or a mistaken visitor's) sessions on other devices.
        const { error: signOutErr } = await supabase.auth.signOut({ scope: 'local' })
        if (signOutErr) signOutFailed = true
      } catch {
        signOutFailed = true
      }
      if (cancelled || requestId !== requestIdRef.current) return
      lastProcessedTokenRef.current = null
      updateSession(null)
      setSignOutError(signOutFailed ? SIGN_OUT_WARNING : null)
      // The rejection message takes priority over the sign-out warning on
      // this screen; the warning is still available via context if needed.
      setStatus('unauthenticated')
    }

    processSessionRef.current = processSession

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      processSession(data.session)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return

      if (event === 'TOKEN_REFRESHED') {
        // A refreshed token for the same owner session must never flip
        // status or re-trigger the owner RPC — that would unmount and
        // remount the private app (and PersistentWatching with it) on an
        // ordinary background refresh.
        if (nextSession) updateSession(nextSession)
        return
      }

      if (event === 'SIGNED_OUT') {
        // Invalidate any owner-check still in flight for the session that
        // just ended — it must not resolve later and re-authenticate.
        requestIdRef.current += 1
        lastProcessedTokenRef.current = null
        updateSession(null)
        setStatus('unauthenticated')
        return
      }

      processSession(nextSession)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [updateSession])

  const clearMessage = useCallback(() => setMessage(null), [])

  const retryOwnerCheck = useCallback(() => {
    if (!sessionRef.current || !processSessionRef.current) return
    processSessionRef.current(sessionRef.current, { force: true })
  }, [])

  const signOut = useCallback(async () => {
    setMessage(null)
    // Invalidate any owner-check still in flight — an ordinary sign-out
    // (e.g. from Settings) must not let a slow, now-irrelevant RPC result
    // re-authenticate the app afterward.
    requestIdRef.current += 1
    let signOutFailed = false
    try {
      // Local scope: this device's session only, not every device the
      // owner is signed in on.
      const { error } = await supabase.auth.signOut({ scope: 'local' })
      if (error) signOutFailed = true
    } catch {
      signOutFailed = true
    }
    // Fail closed regardless of whether the network call succeeded: the
    // private app must unmount either way. `signOutError` records the
    // uncertainty instead of silently treating the sign-out as confirmed.
    lastProcessedTokenRef.current = null
    updateSession(null)
    setSignOutError(signOutFailed ? SIGN_OUT_WARNING : null)
    setStatus('unauthenticated')
  }, [updateSession])

  const clearSignOutError = useCallback(() => setSignOutError(null), [])

  return (
    <AuthContext.Provider
      value={{ status, session, message, clearMessage, retryOwnerCheck, signOut, signOutError, clearSignOutError }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
