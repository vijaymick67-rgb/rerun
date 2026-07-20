// Rendered by AuthGate when a session exists locally but ownership could
// not be confirmed because the current_user_is_owner() RPC failed (almost
// always: device is offline). Deliberately distinct from the unauthorized
// screen — this is neither "not the owner" nor "signed out". The session is
// left untouched and private routes stay unmounted until the check
// succeeds.
export default function OfflineAuthState({ onRetry }) {
  return (
    <div className="auth-screen">
      <div className="auth-screen__panel">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <img src="/rerun-icon.svg" alt="" className="h-16 w-16" />
          <h1 className="type-page-title text-(--color-text)">Rerun</h1>
        </div>

        <div className="surface-card p-5 text-center">
          <p className="type-body text-(--color-text)">Can't verify your account right now.</p>
          <p className="type-caption mt-2 text-(--color-text-muted)">
            Rerun needs a connection to confirm this is the owner's device before it can open your data.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="focus-ring motion-press mt-4 min-h-11 w-full rounded-md bg-(--color-accent) px-4 py-2.5 text-sm font-semibold text-(--color-canvas)"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  )
}
