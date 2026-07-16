import { useEffect } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import TabBar from './components/TabBar'
import NotFound from './components/NotFound'
import ReloadPrompt from './components/ReloadPrompt'
import GlobalTopScrim from './components/GlobalTopScrim'
import ScrollRestorationManager from './components/ScrollRestorationManager'
import Browse from './routes/Browse'
import Watching from './routes/Watching'
import ShowDetail from './routes/ShowDetail'
import SeasonDetail from './routes/SeasonDetail'
import Stats from './routes/Stats'
import Settings from './routes/Settings'
import { removeStaticLoadingShell } from './pwa/appShell'
import { getRouteLevel } from './lib/scrollRestoration'

function RouteContent() {
  const location = useLocation()
  const transitionClass = getRouteLevel(location.pathname) > 0
    ? 'route-content route-content--nested'
    : 'route-content route-content--tab'

  return (
    <div key={location.key} className={transitionClass}>
      <Routes>
        <Route path="/" element={<Watching />} />
        <Route path="/browse" element={<Browse />} />
        <Route path="/watching" element={<Watching />} />
        <Route path="/watching/:tmdbId" element={<ShowDetail />} />
        <Route path="/watching/:tmdbId/season/:seasonNumber" element={<SeasonDetail />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </div>
  )
}

function App() {
  useEffect(() => {
    removeStaticLoadingShell()
  }, [])

  return (
    <div className="app-shell">
      <GlobalTopScrim />
      <ScrollRestorationManager />
      <RouteContent />
      <TabBar />
      <ReloadPrompt />
    </div>
  )
}

export default App
