// iOS/iPadOS Safari only exposes `navigator.standalone` (a boolean), never
// `undefined` — no other engine defines it. It's also the only signal
// available in a plain browser tab that this device *could* support push
// once Rerun is added to the Home Screen: pre-install, WebKit doesn't expose
// `PushManager` or a usable `serviceWorker.ready` at all, so feature
// detection alone can't tell "never supported" apart from "supported after
// install" on iOS.
function isIosSafari(nav) {
  return typeof nav?.standalone === 'boolean'
}

function isRunningAsInstalledPwa(win, nav) {
  const standaloneMedia =
    typeof win?.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches
  return Boolean(standaloneMedia || nav?.standalone === true)
}

export function isPushApiSupported(nav = globalThis.navigator, win = globalThis.window) {
  return Boolean(
    nav && 'serviceWorker' in nav && win && 'PushManager' in win && 'Notification' in win,
  )
}

// One of: 'supported' (push can be used right now), 'needs-install' (this is
// iOS Safari outside the installed Home Screen app, where the Push API is
// hidden until installed), or 'unsupported' (this browser/OS has no Web Push
// support at all).
export function getPushSupportState({ nav = globalThis.navigator, win = globalThis.window } = {}) {
  if (isPushApiSupported(nav, win)) return 'supported'
  if (isIosSafari(nav) && !isRunningAsInstalledPwa(win, nav)) return 'needs-install'
  return 'unsupported'
}
