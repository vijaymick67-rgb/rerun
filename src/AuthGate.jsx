import { useEffect } from 'react'
import { useAuth } from './lib/AuthContext'
import { removeStaticLoadingShell } from './pwa/appShell'
import AuthBootShell from './components/AuthBootShell'
import OfflineAuthState from './components/OfflineAuthState'
import Login from './routes/Login'
import App from './App.jsx'

// The owner authorization boundary. This is the ONLY place that decides
// whether <App/> — and with it PersistentWatching, every private route,
// TabBar, and ReloadPrompt — is allowed to mount. App.jsx itself stays
// completely auth-unaware (and its existing tests keep rendering it
// directly, unaffected) — the gate lives one level above it instead of
// woven through it.
//
// Removes the static #app-loading shell itself (rather than leaving that to
// App's own mount effect) because App may now not mount for a long time —
// or ever, for a rejected session. Idempotent, so App's own call (unchanged)
// is a harmless no-op once this has already run.
export default function AuthGate() {
  const { status, retryOwnerCheck } = useAuth()

  useEffect(() => {
    removeStaticLoadingShell()
  }, [])

  switch (status) {
    case 'authenticated-owner':
      return <App />
    case 'offline-auth-unavailable':
      return <OfflineAuthState onRetry={retryOwnerCheck} />
    case 'booting':
    case 'checking-owner':
      return <AuthBootShell />
    case 'unauthenticated':
    case 'oauth-error':
    case 'unauthorized':
    default:
      return <Login />
  }
}
