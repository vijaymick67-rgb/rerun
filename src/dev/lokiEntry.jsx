import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../fonts.css'
import '../index.css'
import { isLokiPrototypePath } from './lokiRoute'

if (isLokiPrototypePath(window.location.pathname)) {
  import('./LokiShowcase.jsx').then(({ default: LokiShowcase }) => {
    createRoot(document.getElementById('root')).render(
      <StrictMode>
        <LokiShowcase />
      </StrictMode>,
    )
  })
} else {
  import('../main.jsx')
}
