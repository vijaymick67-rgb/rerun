import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <main className="app-page flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-(--color-border) bg-(--color-surface) text-xl font-semibold text-(--color-accent)">
        R
      </div>
      <h1 className="mt-5 text-lg font-semibold text-(--color-text)">
        Page not found
      </h1>
      <p className="mt-2 max-w-xs text-sm leading-6 text-(--color-text-muted)">
        That Rerun page does not exist.
      </p>
      <Link
        to="/"
        className="motion-press mt-5 flex min-h-11 items-center rounded-lg bg-(--color-accent) px-5 text-sm font-semibold text-(--color-bg)"
      >
        Go to Watching
      </Link>
    </main>
  )
}
