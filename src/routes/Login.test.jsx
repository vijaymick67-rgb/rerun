// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const signInWithOAuthMock = vi.fn()
const signInWithPasswordMock = vi.fn()

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOAuth: (...args) => signInWithOAuthMock(...args),
      signInWithPassword: (...args) => signInWithPasswordMock(...args),
    },
  },
}))

const authState = { message: null, clearMessage: vi.fn(), signOutError: null, clearSignOutError: vi.fn() }
vi.mock('../lib/AuthContext', () => ({
  useAuth: () => authState,
}))

import Login from './Login'

let container = null
let root = null

async function mountLogin() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<Login />) })
}

// Directly setting `input.value` then dispatching a plain 'input' event is
// silently ignored by React's controlled-input value tracker (the DOM value
// already matches what React thinks it set). Going through the native
// setter bypasses that tracker so onChange actually fires — same fix RTL's
// fireEvent.change uses internally.
function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function getByText(text) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT)
  let node = walker.currentNode
  while (node) {
    if (node.textContent.trim() === text && node.children.length === 0) return node
    node = walker.nextNode()
  }
  return null
}

beforeEach(() => {
  signInWithOAuthMock.mockReset().mockResolvedValue({ error: null })
  signInWithPasswordMock.mockReset().mockResolvedValue({ error: null })
  authState.message = null
  authState.clearMessage.mockReset()
  authState.signOutError = null
  authState.clearSignOutError.mockReset()
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
})

describe('Login', () => {
  it('renders Continue with Google as the primary action and no signup action', async () => {
    await mountLogin()
    expect(getByText('Continue with Google')).not.toBeNull()
    expect(container.textContent).not.toMatch(/sign up|create an account|register/i)
  })

  it('invokes Google OAuth with the origin root as the redirect target', async () => {
    await mountLogin()
    await act(async () => { getByText('Continue with Google').click() })
    expect(signInWithOAuthMock).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/` },
    })
  })

  it('shows a connecting/disabled state immediately on tap', async () => {
    let resolveOAuth
    signInWithOAuthMock.mockReturnValue(new Promise((resolve) => { resolveOAuth = resolve }))
    await mountLogin()
    const button = getByText('Continue with Google')
    await act(async () => { button.click() })

    const connectingButton = getByText('Connecting to Google…')
    expect(connectingButton).not.toBeNull()
    expect(connectingButton.closest('button').disabled).toBe(true)

    await act(async () => { resolveOAuth({ error: null }) })
  })

  it('shows an inline error when Google sign-in itself fails to start', async () => {
    signInWithOAuthMock.mockResolvedValue({ error: new Error('provider misconfigured') })
    await mountLogin()
    await act(async () => { getByText('Continue with Google').click() })
    expect(container.textContent).toContain('Google sign-in failed. Please try again.')
    expect(getByText('Continue with Google').closest('button').disabled).toBe(false)
  })

  it('shows the exact unauthorized rejection message from context', async () => {
    authState.message = "You're not the owner."
    await mountLogin()
    expect(container.textContent).toContain("You're not the owner.")
  })

  it('surfaces an OAuth callback error from context the same way', async () => {
    authState.message = 'Google sign-in was cancelled or failed. Please try again.'
    await mountLogin()
    expect(container.textContent).toContain('Google sign-in was cancelled or failed. Please try again.')
  })

  it('reveals the recovery form only on explicit disclosure, with no recovery UI by default', async () => {
    await mountLogin()
    expect(container.querySelector('input[type="email"]')).toBeNull()
    expect(container.querySelector('input[type="password"]')).toBeNull()

    await act(async () => { getByText('Use recovery login').click() })
    expect(container.querySelector('input[type="email"]')).not.toBeNull()
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
    expect(container.querySelector('input[type="email"]').autocomplete).toBe('email')
    expect(container.querySelector('input[type="password"]').autocomplete).toBe('current-password')
  })

  it('clears the context message when opening recovery', async () => {
    authState.message = "You're not the owner."
    await mountLogin()
    await act(async () => { getByText('Use recovery login').click() })
    expect(authState.clearMessage).toHaveBeenCalled()
  })

  it('submits recovery credentials via signInWithPassword', async () => {
    await mountLogin()
    await act(async () => { getByText('Use recovery login').click() })

    await act(async () => {
      typeInto(container.querySelector('input[type="email"]'), 'owner@example.com')
      typeInto(container.querySelector('input[type="password"]'), 'correct horse battery staple')
    })
    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      email: 'owner@example.com',
      password: 'correct horse battery staple',
    })
  })

  it('shows a calm inline error on bad recovery credentials', async () => {
    signInWithPasswordMock.mockResolvedValue({ error: new Error('Invalid login credentials') })
    await mountLogin()
    await act(async () => { getByText('Use recovery login').click() })
    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(container.textContent).toContain('Incorrect email or password.')
  })

  it('the Back action returns to the Google-primary screen', async () => {
    await mountLogin()
    await act(async () => { getByText('Use recovery login').click() })
    await act(async () => { getByText('Back to Google sign-in').click() })
    expect(getByText('Continue with Google')).not.toBeNull()
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })

  it('shows an informational (non-alert) notice when sign-out could not be confirmed with the server', async () => {
    authState.signOutError =
      'Sign-out could not be confirmed with the server, but local access has been revoked on this device.'
    await mountLogin()
    const notice = container.querySelector('[role="status"]')
    expect(notice).not.toBeNull()
    expect(notice.textContent).toContain('Sign-out could not be confirmed')
    // This is informational, not a blocking error — it must not steal the
    // role="alert" region reserved for the rejection/OAuth-error message.
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('the rejection message takes priority over the sign-out notice when both are present', async () => {
    authState.message = "You're not the owner."
    authState.signOutError = 'Sign-out could not be confirmed with the server, but local access has been revoked on this device.'
    await mountLogin()
    expect(container.querySelector('[role="alert"]').textContent).toContain("You're not the owner.")
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('clears the sign-out notice when starting a fresh Google sign-in attempt', async () => {
    authState.signOutError = 'Sign-out could not be confirmed with the server, but local access has been revoked on this device.'
    await mountLogin()
    await act(async () => { getByText('Continue with Google').click() })
    expect(authState.clearSignOutError).toHaveBeenCalled()
  })

  it('reserves an inert demo slot that renders nothing interactive', async () => {
    await mountLogin()
    const slot = container.querySelector('[data-testid="login-demo-slot"]')
    expect(slot).not.toBeNull()
    expect(slot.querySelector('button, a, input')).toBeNull()
    expect(slot.textContent).toBe('')
  })
})
