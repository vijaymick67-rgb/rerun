import { useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { requestServiceWorkerUpdate } from '../pwa/updateLifecycle'

export function UpdatePrompt({ onUpdate, onDismiss, updating = false }) {
  return (
    <div className="update-prompt motion-banner" role="status" aria-live="polite">
      <p className="min-w-0 flex-1 text-sm text-(--color-text)">
        A new version of RERUN is ready.
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
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()
  const [dismissed, setDismissed] = useState(false)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    if (needRefresh) setDismissed(false)
  }, [needRefresh])

  if (!needRefresh || dismissed) return null

  async function handleUpdate() {
    setUpdating(true)
    try {
      await requestServiceWorkerUpdate(updateServiceWorker)
    } catch {
      setUpdating(false)
    }
  }

  function handleDismiss() {
    setDismissed(true)
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
