export const MAIN_TAB_PATHS = new Set(['/browse', '/watching', '/stats', '/settings'])
// The initial attempt plus 19 bounded retries spans about 1.4 seconds.
export const MAX_RESTORE_ATTEMPTS = 20
export const RESTORE_RETRY_DELAY_MS = 75

export function isMainTabPath(pathname) {
  return MAIN_TAB_PATHS.has(pathname) || pathname === '/'
}

export function getScrollRouteKey(pathname) {
  return pathname === '/' ? '/watching' : pathname || '/'
}

export function getRouteLevel(pathname) {
  if (/^\/watching\/[^/]+\/season\/[^/]+$/.test(pathname)) return 2
  if (/^\/watching\/[^/]+$/.test(pathname)) return 1
  return 0
}

// Identity of the on-screen "shell" a path belongs to. The route wrapper is
// keyed by this, so it only remounts (and replays its tab-entry fade) when the
// identity changes — i.e. on a genuine tab switch. Every Watching-subtree path
// (the list plus its nested Show/Season detail routes) shares one identity, so
// navigating into a detail route and back never remounts the persistent
// Watching list nor replays the page fade. This is distinct from
// `location.key`, which changes on every history entry (including Back).
export function getRouteShellKey(pathname) {
  if (pathname === '/' || pathname === '/watching' || getRouteLevel(pathname) > 0) {
    return '/watching'
  }
  return pathname || '/'
}

export function isNestedParentPath(fromPathname, toPathname) {
  const seasonMatch = fromPathname.match(/^\/watching\/([^/]+)\/season\/[^/]+$/)
  if (seasonMatch) return toPathname === `/watching/${seasonMatch[1]}`

  if (/^\/watching\/[^/]+$/.test(fromPathname)) {
    return toPathname === '/watching' || toPathname === '/'
  }

  return false
}

export function flushPendingScrollPosition(positions, pendingPositions, routeKey) {
  const pendingPosition = pendingPositions.get(routeKey)
  if (pendingPosition === undefined) return

  positions.set(routeKey, pendingPosition)
  pendingPositions.delete(routeKey)
}

export function getScrollNavigationAction({
  isInitial,
  navigationType,
  previousPathname,
  pathname,
}) {
  const key = getScrollRouteKey(pathname)

  if (isInitial) return { type: 'top', key }
  if (isMainTabPath(pathname)) return { type: 'restore', key }
  if (isNestedParentPath(previousPathname, pathname)) return { type: 'restore', key }

  if (
    navigationType === 'POP' &&
    getRouteLevel(pathname) <= getRouteLevel(previousPathname)
  ) {
    return { type: 'restore', key }
  }

  return { type: 'top', key }
}

export function createBoundedScrollRestorer({
  target,
  getMaxScroll,
  scrollTo,
  schedule,
  cancelSchedule,
  onFinish,
  maxAttempts = MAX_RESTORE_ATTEMPTS,
  retryDelay = RESTORE_RETRY_DELAY_MS,
}) {
  let attempts = 0
  let cancelled = false
  let finished = false
  let timerId = null

  const finish = () => {
    if (finished) return
    finished = true
    onFinish?.()
  }

  const run = () => {
    if (cancelled || finished) return

    attempts += 1
    const reachablePosition = Math.max(0, getMaxScroll())
    const position = Math.min(target, reachablePosition)
    scrollTo(position)

    if (position >= target || attempts >= maxAttempts) {
      finish()
      return
    }
    timerId = schedule(run, retryDelay)
  }

  run()

  return () => {
    cancelled = true
    if (timerId !== null) cancelSchedule(timerId)
  }
}
