export const MAIN_TAB_PATHS = new Set(['/browse', '/watching', '/stats', '/settings'])
export const MAX_RESTORE_ATTEMPTS = 4
export const RESTORE_RETRY_DELAY_MS = 50

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

export function isNestedParentPath(fromPathname, toPathname) {
  const seasonMatch = fromPathname.match(/^\/watching\/([^/]+)\/season\/[^/]+$/)
  if (seasonMatch) return toPathname === `/watching/${seasonMatch[1]}`

  if (/^\/watching\/[^/]+$/.test(fromPathname)) {
    return toPathname === '/watching' || toPathname === '/'
  }

  return false
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
  maxAttempts = MAX_RESTORE_ATTEMPTS,
  retryDelay = RESTORE_RETRY_DELAY_MS,
}) {
  let attempts = 0
  let cancelled = false
  let timerId = null

  const run = () => {
    if (cancelled) return

    attempts += 1
    const reachablePosition = Math.max(0, getMaxScroll())
    const position = Math.min(target, reachablePosition)
    scrollTo(position)

    if (position >= target || attempts >= maxAttempts) return
    timerId = schedule(run, retryDelay)
  }

  run()

  return () => {
    cancelled = true
    if (timerId !== null) cancelSchedule(timerId)
  }
}
