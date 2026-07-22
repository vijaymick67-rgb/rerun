import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './fonts.css'
import './index.css'
import { removeStaticLoadingShell } from './pwa/appShell'
import { isLokiPrototypePath } from './dev/lokiRoute'

const removeShellOnStartupFailure = () => removeStaticLoadingShell()

window.addEventListener('error', removeShellOnStartupFailure, { once: true })
window.addEventListener('unhandledrejection', removeShellOnStartupFailure, { once: true })

const root = createRoot(document.getElementById('root'))

if (isLokiPrototypePath(window.location.pathname, import.meta.env.DEV)) {
  import(/* @vite-ignore */ '/src/dev/LokiShowcase.jsx').then(({ default: LokiShowcase }) => {
    root.render(
      <StrictMode>
        <LokiShowcase />
      </StrictMode>,
    )
  })
} else {
  import('./ProductionRoot.jsx').then(({ default: ProductionRoot }) => {
    root.render(
      <StrictMode>
        <ProductionRoot />
      </StrictMode>,
    )
  })
}
