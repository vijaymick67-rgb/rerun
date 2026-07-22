import { BrowserRouter } from 'react-router-dom'
import AuthGate from './AuthGate.jsx'
import { AuthProvider } from './lib/AuthContext'

export default function ProductionRoot() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </BrowserRouter>
  )
}
