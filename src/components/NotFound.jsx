import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <main className="app-page flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="system-state-mark surface-card flex h-14 w-14 items-center justify-center text-xl font-semibold text-(--color-accent-strong)">
        R
      </div>
      <h1 className="type-section-title mt-5 text-(--color-text)">
        Page not found
      </h1>
      <p className="type-body mt-2 max-w-xs text-(--color-text-muted)">
        That Rerun page does not exist.
      </p>
      <Link
        to="/"
        className="motion-press focus-ring mt-5 flex min-h-11 items-center rounded-lg bg-(--color-accent) px-5 text-sm font-semibold text-(--color-canvas)"
      >
        Go to Watching
      </Link>
    </main>
  )
}
