export function requestServiceWorkerUpdate(updateServiceWorker) {
  // vite-plugin-pwa 1.3.0 ignores this argument and only sends SKIP_WAITING.
  // Passing false documents that RERUN owns the controllerchange reload.
  return updateServiceWorker(false)
}

const DEFAULT_WAITING_WORKER = 'waiting-worker'

function isOnlineByDefault() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export function createUpdateLifecycle({
  activateAndReload,
  reload = () => globalThis.location?.reload?.(),
  isOnline = isOnlineByDefault,
} = {}) {
  let state = 'idle'
  let promptCount = 0
  let waitingWorker = null
  let dismissedWorker = null
  let reloadStarted = false
  let updatePromise = null

  function workerKey(worker) {
    return worker ?? DEFAULT_WAITING_WORKER
  }

  return {
    getState: () => state,
    getPromptCount: () => promptCount,
    announceReady(worker) {
      const key = workerKey(worker)
      if (!isOnline() || state === 'ready' || state === 'updating' || state === 'reloading') return false
      if (state === 'dismissed' && dismissedWorker === key) return false
      waitingWorker = key
      dismissedWorker = null
      reloadStarted = false
      state = 'ready'
      promptCount += 1
      return true
    },
    dismiss() {
      if (state !== 'ready') return false
      dismissedWorker = waitingWorker
      state = 'dismissed'
      return true
    },
    async update() {
      if (updatePromise) return updatePromise
      if (!isOnline() || state !== 'ready' || typeof activateAndReload !== 'function') return false
      state = 'updating'
      let activation
      try {
        activation = activateAndReload()
      } catch {
        state = 'ready'
        return false
      }
      updatePromise = Promise.resolve(activation)
        .then(() => {
          if (!reloadStarted) state = 'updated'
          return true
        })
        .catch(() => {
          if (!reloadStarted) state = 'ready'
          return false
        })
        .finally(() => {
          updatePromise = null
        })
      return updatePromise
    },
    handleControllerChange() {
      if (reloadStarted || !['ready', 'dismissed', 'updating', 'updated'].includes(state)) return false
      reloadStarted = true
      state = 'reloading'
      try {
        reload()
        return true
      } catch {
        reloadStarted = false
        state = 'updated'
        return false
      }
    },
  }
}

export const PWA_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

export function installControllerChangeListener({
  serviceWorkerContainer = globalThis.navigator?.serviceWorker,
  onControllerChange,
} = {}) {
  if (typeof serviceWorkerContainer?.addEventListener !== 'function') return () => {}

  const handleControllerChange = () => onControllerChange?.()
  serviceWorkerContainer.addEventListener('controllerchange', handleControllerChange)
  let removed = false

  return () => {
    if (removed) return
    removed = true
    serviceWorkerContainer.removeEventListener?.('controllerchange', handleControllerChange)
  }
}

export function createUpdateChecker({
  registration,
  intervalMs = PWA_UPDATE_CHECK_INTERVAL_MS,
  isOnline = isOnlineByDefault,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) {
  let timer = null
  let inFlight = null
  let stopped = false

  function check() {
    if (stopped || typeof registration?.update !== 'function' || !isOnline()) return Promise.resolve(false)
    if (inFlight) return inFlight
    inFlight = Promise.resolve()
      .then(() => registration.update())
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  function start() {
    if (timer !== null || typeof registration?.update !== 'function') return false
    stopped = false
    timer = setIntervalFn(check, intervalMs)
    return true
  }

  function stop() {
    stopped = true
    if (timer !== null) {
      clearIntervalFn(timer)
      timer = null
    }
  }

  return {
    check,
    start,
    stop,
    isRunning: () => timer !== null,
  }
}
