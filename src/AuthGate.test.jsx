// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const fromSpy = vi.fn()

vi.mock('./lib/supabase', () => ({
  supabase: {
    from: (...args) => {
      fromSpy(...args)
      return {
        select: () => ({
          order: () => Promise.resolve({ data: [], error: null }),
        }),
      }
    },
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
  },
}))

vi.mock('./components/ReloadPrompt', () => ({ default: () => null }))

const authState = {
  status: 'booting',
  session: null,
  message: null,
  clearMessage: vi.fn(),
  retryOwnerCheck: vi.fn(),
  signOut: vi.fn(),
}

vi.mock('./lib/AuthContext', () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }) => children,
}))

import AuthGate from './AuthGate'

let container = null
let root = null

async function renderGate() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <AuthGate />
      </MemoryRouter>,
    )
  })
}

async function rerenderGate() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <AuthGate />
      </MemoryRouter>,
    )
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  fromSpy.mockClear()
  Object.assign(authState, {
    status: 'booting',
    session: null,
    message: null,
    clearMessage: vi.fn(),
    retryOwnerCheck: vi.fn(),
    signOut: vi.fn(),
  })
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
})

describe('AuthGate — private app mount boundary', () => {
  it('mounts neither TabBar nor any private Supabase query while booting', async () => {
    authState.status = 'booting'
    await renderGate()
    expect(container.querySelector('.app-tab-bar')).toBeNull()
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('mounts neither TabBar nor any private Supabase query while unauthenticated (Login only)', async () => {
    authState.status = 'unauthenticated'
    await renderGate()
    expect(container.querySelector('.app-tab-bar')).toBeNull()
    expect(container.textContent).toContain('Continue with Google')
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('mounts neither TabBar nor any private Supabase query while unauthorized', async () => {
    authState.status = 'unauthorized'
    authState.message = "You're not the owner."
    await renderGate()
    expect(container.querySelector('.app-tab-bar')).toBeNull()
    expect(container.textContent).toContain("You're not the owner.")
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('shows a retry action and never queries private data while offline-auth-unavailable', async () => {
    authState.status = 'offline-auth-unavailable'
    await renderGate()
    expect(container.querySelector('.app-tab-bar')).toBeNull()
    expect(fromSpy).not.toHaveBeenCalled()

    const retryButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')
    expect(retryButton).not.toBeUndefined()
    await act(async () => { retryButton.click() })
    expect(authState.retryOwnerCheck).toHaveBeenCalledOnce()
  })

  it('mounts the private app (TabBar + Watching queries) only once authenticated-owner', async () => {
    authState.status = 'authenticated-owner'
    await renderGate()
    await flush()

    expect(container.querySelector('.app-tab-bar')).not.toBeNull()
    expect(container.querySelector('a[aria-label="Discover"]')).not.toBeNull()
    expect(container.querySelector('a[aria-label="Watching"]')).not.toBeNull()
    expect(container.querySelector('a[aria-label="Settings"]')).not.toBeNull()
    expect(fromSpy).toHaveBeenCalledWith('tracked_shows')
  })

  it('keeps the mounted private app stable (same DOM node) across an ordinary session refresh', async () => {
    authState.status = 'authenticated-owner'
    authState.session = { access_token: 'tok-1' }
    await renderGate()
    await flush()

    const tabBarBefore = container.querySelector('.app-tab-bar')
    expect(tabBarBefore).not.toBeNull()

    // Simulate a token refresh: session identity changes, status does not.
    authState.session = { access_token: 'tok-2' }
    await rerenderGate()
    await flush()

    const tabBarAfter = container.querySelector('.app-tab-bar')
    expect(tabBarAfter).toBe(tabBarBefore)
  })
})
