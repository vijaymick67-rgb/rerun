import { useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import {
  createUpdateChecker,
  createUpdateLifecycle,
  installControllerChangeListener,
  requestServiceWorkerUpdate,
} from '../pwa/updateLifecycle'

export function UpdatePrompt({ onUpdate, onDismiss, updating = false }) {
  return (
    <div className="update-prompt motion-banner" role="status" aria-live="polite">
      <p className="min-w-0 flex-1 text-sm text-(--color-text)">
        A new version of Rerun is ready.
      </p>
      <button
        type="button"
        onClick={onUpdate}
        disabled={updating}
        className="motion-press min-h-11 shrink-0 rounded-md bg-(--color-accent) px-3 text-sm font-semibold text-(--color-bg) disabled:opacity-60"
      >
        {updating ? 'Updating...' : 'Update'}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss update"
        className="motion-press min-h-11 min-w-11 shrink-0 rounded-md text-lg leading-none text-(--color-text-muted)"
      >
        ×
      </button>
    </div>
  )
}

export default function ReloadPrompt() {
  const registrationRef = useRef(null)
  const updateServiceWorkerRef = useRef(null)
  const updateCheckerRef = useRef(null)
  const mountedRef = useRef(true)
  const lifecycleRef = useRef(null)
  const [promptVisible, setPromptVisible] = useState(false)
  const [updating, setUpdating] = useState(false)

  if (!lifecycleRef.current) {
    lifecycleRef.current = createUpdateLifecycle({
      activateAndReload: () => {
        if (registrationRef.current && !registrationRef.current.waiting) {
          throw new Error('No waiting service worker is available')
        }
        return requestServiceWorkerUpdate(updateServiceWorkerRef.current)
      },
    })
  }

  const {
    needRefresh: [, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onNeedRefresh() {
      if (!mountedRef.current) return
      const waitingWorker = registrationRef.current?.waiting
      if (lifecycleRef.current.announceReady(waitingWorker)) setPromptVisible(true)
    },
    onNeedReload() {
      if (!mountedRef.current) return
      // vite-plugin-pwa 1.3.0 calls this from its Workbox `controlling`
      // listener. Route that signal through the same owner as the native
      // controllerchange listener so repeated Workbox listeners cannot reload
      // more than once.
      lifecycleRef.current.handleControllerChange()
    },
    onRegisteredSW(_swUrl, registration) {
      if (!mountedRef.current) return
      registrationRef.current = registration ?? null
      updateCheckerRef.current?.stop()
      updateCheckerRef.current = createUpdateChecker({ registration })
      updateCheckerRef.current.start()
    },
  })

  updateServiceWorkerRef.current = updateServiceWorker

  useEffect(() => {
    mountedRef.current = true
    const checkForUpdate = () => {
      if (globalThis.navigator?.onLine === false) return
      updateCheckerRef.current?.check()
      const waitingWorker = registrationRef.current?.waiting
      if (waitingWorker && lifecycleRef.current.announceReady(waitingWorker)) {
        setPromptVisible(true)
      }
    }
    const handleVisibilityChange = () => {
      if (globalThis.document?.visibilityState === 'visible') checkForUpdate()
    }

    globalThis.addEventListener?.('online', checkForUpdate)
    globalThis.document?.addEventListener?.('visibilitychange', handleVisibilityChange)
    const removeControllerChangeListener = installControllerChangeListener({
      onControllerChange: () => lifecycleRef.current.handleControllerChange(),
    })
    updateCheckerRef.current?.start()

    return () => {
      mountedRef.current = false
      globalThis.removeEventListener?.('online', checkForUpdate)
      globalThis.document?.removeEventListener?.('visibilitychange', handleVisibilityChange)
      removeControllerChangeListener()
      updateCheckerRef.current?.stop()
    }
  }, [])

  if (!promptVisible) return null

  async function handleUpdate() {
    if (updating) return
    setUpdating(true)
    const accepted = await lifecycleRef.current.update()
    if (!accepted && mountedRef.current) {
      setUpdating(false)
    }
  }

  function handleDismiss() {
    lifecycleRef.current.dismiss()
    setPromptVisible(false)
    setNeedRefresh(false)
  }

  return (
    <UpdatePrompt
      onUpdate={handleUpdate}
      onDismiss={handleDismiss}
      updating={updating}
    />
  )
}
