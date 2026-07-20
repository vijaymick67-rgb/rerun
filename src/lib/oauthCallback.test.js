// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { consumeOAuthCallbackError } from './oauthCallback'

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('consumeOAuthCallbackError', () => {
  it('returns null when there is no error param', () => {
    window.history.replaceState({}, '', '/')
    expect(consumeOAuthCallbackError()).toBeNull()
  })

  it('returns a calm message and strips error params when present', () => {
    window.history.replaceState({}, '', '/?error=access_denied&error_code=user_cancelled&error_description=nope')
    const message = consumeOAuthCallbackError()
    expect(message).toBe('Google sign-in was cancelled or failed. Please try again.')
    expect(window.location.search).toBe('')
  })

  it('a refresh after consumption does not replay the same error', () => {
    window.history.replaceState({}, '', '/?error=access_denied')
    expect(consumeOAuthCallbackError()).not.toBeNull()
    expect(consumeOAuthCallbackError()).toBeNull()
  })

  it('preserves unrelated query params while stripping only the OAuth error keys', () => {
    window.history.replaceState({}, '', '/?foo=bar&error_code=user_cancelled')
    consumeOAuthCallbackError()
    expect(window.location.search).toBe('?foo=bar')
  })

  it('preserves an existing hash', () => {
    window.history.replaceState({}, '', '/?error=access_denied#section')
    consumeOAuthCallbackError()
    expect(window.location.hash).toBe('#section')
    expect(window.location.search).toBe('')
  })

  it('maps error_code=signup_disabled to the owner-rejection message', () => {
    window.history.replaceState({}, '', '/?error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance')
    const message = consumeOAuthCallbackError()
    expect(message).toBe("You're not the owner.")
  })

  it('strips callback params for the signup_disabled case too', () => {
    window.history.replaceState({}, '', '/?error=access_denied&error_code=signup_disabled')
    consumeOAuthCallbackError()
    expect(window.location.search).toBe('')
  })

  it('a refresh after consuming signup_disabled does not replay the message', () => {
    window.history.replaceState({}, '', '/?error=access_denied&error_code=signup_disabled')
    expect(consumeOAuthCallbackError()).toBe("You're not the owner.")
    expect(consumeOAuthCallbackError()).toBeNull()
  })

  it('a non-signup_disabled error_code still maps to the generic message', () => {
    window.history.replaceState({}, '', '/?error=access_denied&error_code=user_cancelled')
    expect(consumeOAuthCallbackError()).toBe('Google sign-in was cancelled or failed. Please try again.')
  })

  it('an error with no error_code at all still maps to the generic message', () => {
    window.history.replaceState({}, '', '/?error=access_denied')
    expect(consumeOAuthCallbackError()).toBe('Google sign-in was cancelled or failed. Please try again.')
  })
})
