import { retryOffline } from '../pwa/offline'

export default function OfflineFallback({ onRetry }) {
  return (
    <main className="app-page flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-(--color-border) bg-(--color-surface) text-xl font-semibold text-(--color-accent)">
        R
      </div>
      <h1 className="mt-5 text-lg font-semibold text-(--color-text)">
        RERUN is offline
      </h1>
      <p className="mt-2 max-w-xs text-sm leading-6 text-(--color-text-muted)">
        Live TV data and tracking updates need an internet connection. Try again when you are back online.
      </p>
      <button
        type="button"
        onClick={() => retryOffline(onRetry)}
        className="motion-press mt-5 min-h-11 rounded-lg bg-(--color-accent) px-5 text-sm font-semibold text-(--color-bg)"
      >
        Retry
      </button>
    </main>
  )
}
