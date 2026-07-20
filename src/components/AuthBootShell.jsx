// Rendered by AuthGate while auth status is 'booting' or 'checking-owner' —
// the React-owned continuation of the static #app-loading shell in
// index.html. Visually matched to it (same icon, same wordmark, same
// canvas background — see .auth-boot-shell in src/index.css, kept in sync
// with the inline <style> in index.html) so there is no flash between the
// static shell being removed and this taking over. Renders no app content
// of any kind — just a neutral "loading" mark, same as the static shell.
export default function AuthBootShell() {
  return (
    <div className="auth-boot-shell" role="status" aria-live="polite" aria-label="Loading Rerun">
      <div className="auth-boot-shell__mark">
        <img src="/rerun-icon.svg" alt="" className="auth-boot-shell__icon" />
        <span className="auth-boot-shell__wordmark">Rerun</span>
      </div>
    </div>
  )
}
