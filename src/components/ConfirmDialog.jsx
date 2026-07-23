import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}) {
  const panelRef = useRef(null)
  const cancelButtonRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onCancel()
        return
      }
      // Simple focus trap: Tab/Shift+Tab cycle within the dialog panel
      // instead of escaping to the page behind the overlay.
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll(FOCUSABLE_SELECTOR)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  // Initial focus lands on Cancel (the non-destructive default) rather than
  // the confirm/destructive action, and background scroll is locked for the
  // lifetime of the dialog. Both revert automatically on close/unmount.
  useEffect(() => {
    if (!open) return
    cancelButtonRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="safe-area-overlay fixed inset-0 z-50 flex items-center justify-center bg-(--color-overlay)"
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={message ? 'confirm-dialog-message' : undefined}
        className="confirm-dialog-panel motion-banner w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="type-body font-semibold text-(--color-text-primary)">
          {title}
        </h2>
        {message && (
          <p id="confirm-dialog-message" className="type-metadata mt-2 text-(--color-text-secondary)">
            {message}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2.5">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            className="confirm-dialog-cancel focus-ring motion-press min-h-11 rounded-md px-4 py-1.5 text-sm font-medium"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`focus-ring motion-press min-h-11 rounded-md px-4 py-1.5 text-sm font-semibold ${
              danger ? 'confirm-dialog-confirm confirm-dialog-confirm--danger' : 'confirm-dialog-confirm'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
