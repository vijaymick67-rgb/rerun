import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { removeStaticLoadingShell } from './pwa/appShell'

const removeShellOnStartupFailure = () => removeStaticLoadingShell()

window.addEventListener('error', removeShellOnStartupFailure, { once: true })
window.addEventListener('unhandledrejection', removeShellOnStartupFailure, { once: true })

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
