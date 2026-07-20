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

export function AuthProvider({ children }) {
  const [status, setStatus] = useState('booting')
  const [session, setSession] = useState(null)
  const [message, setMessage] = useState(null)

  const sessionRef = useRef(null)
  const lastProcessedTokenRef = useRef(null)
  const rejectionLatchRef = useRef(new Set())
  const processSessionRef = useRef(null)

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

      const { data, error } = await supabase.rpc('current_user_is_owner')
      if (cancelled) return

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
      try {
        await supabase.auth.signOut()
      } catch {
        // Sign-out failing must never leave the private app reachable —
        // fall through to the same local-state clear below regardless.
      }
      if (cancelled) return
      lastProcessedTokenRef.current = null
      updateSession(null)
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
    try {
      await supabase.auth.signOut()
    } catch {
      // Fail closed regardless of whether the network call succeeded.
    }
    lastProcessedTokenRef.current = null
    updateSession(null)
    setStatus('unauthenticated')
  }, [updateSession])

  return (
    <AuthContext.Provider value={{ status, session, message, clearMessage, retryOwnerCheck, signOut }}>
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
