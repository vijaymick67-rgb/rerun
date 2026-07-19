import { describe, expect, it } from 'vitest'
import { getPushSupportState, isPushApiSupported } from './pushSupport.js'

function fakeNav({ standalone } = {}) {
  const nav = { serviceWorker: {} }
  if (standalone !== undefined) nav.standalone = standalone
  return nav
}

function fakeWin({ standaloneMedia = false } = {}) {
  return {
    PushManager: function PushManager() {},
    Notification: function Notification() {},
    matchMedia: () => ({ matches: standaloneMedia }),
  }
}

describe('isPushApiSupported', () => {
  it('is true when serviceWorker, PushManager, and Notification are all present', () => {
    expect(isPushApiSupported(fakeNav(), fakeWin())).toBe(true)
  })

  it('is false when any piece is missing', () => {
    expect(isPushApiSupported({}, fakeWin())).toBe(false)
    expect(isPushApiSupported(fakeNav(), { Notification: function () {} })).toBe(false)
    expect(isPushApiSupported(fakeNav(), { PushManager: function () {} })).toBe(false)
  })
})

describe('getPushSupportState', () => {
  it('returns "supported" when the Push API is available', () => {
    expect(getPushSupportState({ nav: fakeNav(), win: fakeWin() })).toBe('supported')
  })

  it('returns "needs-install" for iOS Safari (has navigator.standalone) outside the installed app', () => {
    const nav = fakeNav({ standalone: false })
    const win = { matchMedia: () => ({ matches: false }) } // no PushManager/Notification pre-install
    expect(getPushSupportState({ nav, win })).toBe('needs-install')
  })

  it('returns "supported" for the installed iOS Home Screen app (navigator.standalone true) once Push API appears', () => {
    const nav = fakeNav({ standalone: true })
    expect(getPushSupportState({ nav, win: fakeWin() })).toBe('supported')
  })

  it('returns "unsupported" for a desktop browser without Push API and without navigator.standalone', () => {
    const nav = { serviceWorker: {} } // no `standalone` property at all
    const win = { matchMedia: () => ({ matches: false }) }
    expect(getPushSupportState({ nav, win })).toBe('unsupported')
  })

  it('returns "unsupported" when there is no navigator at all (SSR-style guard)', () => {
    expect(getPushSupportState({ nav: undefined, win: undefined })).toBe('unsupported')
  })
})
