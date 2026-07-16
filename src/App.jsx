import { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import TabBar from './components/TabBar'
import NotFound from './components/NotFound'
import ReloadPrompt from './components/ReloadPrompt'
import Browse from './routes/Browse'
import Watching from './routes/Watching'
import ShowDetail from './routes/ShowDetail'
import SeasonDetail from './routes/SeasonDetail'
import Stats from './routes/Stats'
import Settings from './routes/Settings'
import { removeStaticLoadingShell } from './pwa/appShell'

function App() {
  useEffect(() => {
    removeStaticLoadingShell()
  }, [])

  return (
    <div className="app-shell">
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
      <TabBar />
      <ReloadPrompt />
    </div>
  )
}

export default App
