// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { authMock, rpcMock } = vi.hoisted(() => ({
  authMock: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
  },
  rpcMock: vi.fn(),
}))

vi.mock('./supabase', () => ({
  supabase: {
    auth: authMock,
    rpc: (...args) => rpcMock(...args),
  },
}))

import { AuthProvider, useAuth } from './AuthContext'

let container = null
let root = null
let latestAuth = null
let authChangeCallback = null

function Probe() {
  latestAuth = useAuth()
  return (
    <div>
      <span data-testid="status">{latestAuth.status}</span>
      <span data-testid="message">{latestAuth.message ?? ''}</span>
    </div>
  )
}

function statusText() {
  return container.querySelector('[data-testid="status"]').textContent
}

function messageText() {
  return container.querySelector('[data-testid="message"]').textContent
}

function fakeSession(token = 'token-1', userId = 'user-1') {
  return { access_token: token, user: { id: userId, email: `${userId}@example.com` } }
}

async function mount({ strict = false } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const tree = strict ? (
    <StrictMode>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </StrictMode>
  ) : (
    <AuthProvider>
      <Probe />
    </AuthProvider>
  )
  await act(async () => { root.render(tree) })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  authMock.getSession.mockReset()
  authMock.onAuthStateChange.mockReset().mockImplementation((cb) => {
    authChangeCallback = cb
    return { data: { subscription: { unsubscribe: vi.fn() } } }
  })
  authMock.signOut.mockReset().mockResolvedValue({ error: null })
  rpcMock.mockReset()
  window.history.replaceState({}, '', '/')
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  latestAuth = null
  authChangeCallback = null
})

describe('AuthContext state machine', () => {
  it('starts in booting, then resolves to unauthenticated when there is no session', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: null } })
    await mount()
    await flush()
    expect(statusText()).toBe('unauthenticated')
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('resolves to authenticated-owner when the session belongs to the owner', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: fakeSession() } })
    rpcMock.mockResolvedValue({ data: true, error: null })
    await mount()
    await flush()
    expect(rpcMock).toHaveBeenCalledWith('current_user_is_owner')
    expect(statusText()).toBe('authenticated-owner')
  })

  it('rejects a non-owner session: signs out exactly once and shows the exact message', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: fakeSession() } })
    rpcMock.mockResolvedValue({ data: false, error: null })
    await mount()
    await flush()
    expect(authMock.signOut).toHaveBeenCalledOnce()
    expect(messageText()).toBe("You're not the owner.")
    expect(statusText()).toBe('unauthenticated')
  })

  it('treats an ownership RPC failure as offline-auth-unavailable, never as unauthorized', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: fakeSession() } })
    rpcMock.mockResolvedValue({ data: null, error: new Error('network error') })
    await mount()
    await flush()
    expect(statusText()).toBe('offline-auth-unavailable')
    expect(authMock.signOut).not.toHaveBeenCalled()
    expect(messageText()).toBe('')
  })

  it('retryOwnerCheck re-runs the RPC after an offline failure and can recover', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: fakeSession() } })
    rpcMock.mockResolvedValueOnce({ data: null, error: new Error('offline') })
    await mount()
    await flush()
    expect(statusText()).toBe('offline-auth-unavailable')

    rpcMock.mockResolvedValueOnce({ data: true, error: null })
    await act(async () => { latestAuth.retryOwnerCheck() })
    await flush()
    expect(statusText()).toBe('authenticated-owner')
    expect(rpcMock).toHaveBeenCalledTimes(2)
  })

  it('an expired session (SIGNED_OUT after being authenticated) drops back to unauthenticated', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: fakeSession() } })
    rpcMock.mockResolvedValue({ data: true, error: null })
    await mount()
    await flush()
    expect(statusText()).toBe('authenticated-owner')

    await act(async () => { authChangeCallback('SIGNED_OUT', null) })
    expect(statusText()).toBe('unauthenticated')
  })

  it('does not re-run the owner check for a duplicate event carrying the same session token', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: null } })
    rpcMock.mockResolvedValue({ data: true, error: null })
    await mount()
    await flush()

    const s = fakeSession()
    await act(async () => { authChangeCallback('SIGNED_IN', s) })
    await flush()
    expect(rpcMock).toHaveBeenCalledTimes(1)

    await act(async () => { authChangeCallback('SIGNED_IN', s) })
    await flush()
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(statusText()).toBe('authenticated-owner')
  })

  it('TOKEN_REFRESHED updates the session without re-running the owner check', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: fakeSession('tok-1') } })
    rpcMock.mockResolvedValue({ data: true, error: null })
    await mount()
    await flush()
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(statusText()).toBe('authenticated-owner')

    await act(async () => { authChangeCallback('TOKEN_REFRESHED', fakeSession('tok-2')) })
    await flush()
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(statusText()).toBe('authenticated-owner')
  })

  it('does not double-call the owner RPC or signOut under StrictMode double-invoked effects', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: fakeSession() } })
    rpcMock.mockResolvedValue({ data: false, error: null })
    await mount({ strict: true })
    await flush()
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(authMock.signOut).toHaveBeenCalledTimes(1)
  })

  it('remains fail-closed even when signOut itself throws', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: fakeSession() } })
    rpcMock.mockResolvedValue({ data: false, error: null })
    authMock.signOut.mockRejectedValue(new Error('network down'))
    await mount()
    await flush()
    expect(statusText()).toBe('unauthenticated')
    expect(messageText()).toBe("You're not the owner.")
  })

  it('surfaces a Google OAuth callback error as the oauth-error status and strips the params', async () => {
    window.history.replaceState({}, '', '/?error=access_denied&error_code=user_cancelled')
    authMock.getSession.mockResolvedValue({ data: { session: null } })
    await mount()
    await flush()
    expect(statusText()).toBe('oauth-error')
    expect(messageText()).toBe('Google sign-in was cancelled or failed. Please try again.')
    expect(window.location.search).toBe('')
  })

  it('context signOut() clears the pending message and is fail-closed on failure', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: fakeSession() } })
    rpcMock.mockResolvedValue({ data: true, error: null })
    await mount()
    await flush()
    expect(statusText()).toBe('authenticated-owner')

    authMock.signOut.mockRejectedValueOnce(new Error('network down'))
    await act(async () => { await latestAuth.signOut() })
    expect(statusText()).toBe('unauthenticated')
    expect(messageText()).toBe('')
  })
})
