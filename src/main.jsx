import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './fonts.css'
import './index.css'
import AuthGate from './AuthGate.jsx'
import { AuthProvider } from './lib/AuthContext'
import { removeStaticLoadingShell } from './pwa/appShell'

const removeShellOnStartupFailure = () => removeStaticLoadingShell()

window.addEventListener('error', removeShellOnStartupFailure, { once: true })
window.addEventListener('unhandledrejection', removeShellOnStartupFailure, { once: true })

const root = createRoot(document.getElementById('root'))

if (
  import.meta.env.DEV &&
  (window.location.pathname === '/dev/loki' || window.location.pathname === '/dev/loki/')
) {
  import(/* @vite-ignore */ '/src/dev/LokiShowcase.jsx').then(({ default: LokiShowcase }) => {
    root.render(
      <StrictMode>
        <LokiShowcase />
      </StrictMode>,
    )
  })
} else {
  root.render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <AuthGate />
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  )
}
