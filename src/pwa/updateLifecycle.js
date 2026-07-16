export function requestServiceWorkerUpdate(updateServiceWorker) {
  return updateServiceWorker(true)
}

export function createUpdateLifecycle({ activateAndReload } = {}) {
  let state = 'idle'
  let promptCount = 0

  return {
    getState: () => state,
    getPromptCount: () => promptCount,
    announceReady() {
      if (state !== 'idle') return false
      state = 'ready'
      promptCount += 1
      return true
    },
    dismiss() {
      if (state !== 'ready') return false
      state = 'idle'
      return true
    },
    async update() {
      if (state !== 'ready' || typeof activateAndReload !== 'function') return false
      state = 'updating'
      try {
        await activateAndReload()
        state = 'updated'
        return true
      } catch {
        state = 'ready'
        return false
      }
    },
  }
}
