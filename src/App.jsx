import { Routes, Route } from 'react-router-dom'
import TabBar from './components/TabBar'
import Browse from './routes/Browse'
import Watching from './routes/Watching'
import ShowDetail from './routes/ShowDetail'
import SeasonDetail from './routes/SeasonDetail'
import Stats from './routes/Stats'
import Settings from './routes/Settings'

function App() {
  return (
    <div className="min-h-screen pb-16">
      <Routes>
        <Route path="/" element={<Watching />} />
        <Route path="/browse" element={<Browse />} />
        <Route path="/watching" element={<Watching />} />
        <Route path="/watching/:tmdbId" element={<ShowDetail />} />
        <Route path="/watching/:tmdbId/season/:seasonNumber" element={<SeasonDetail />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
      <TabBar />
    </div>
  )
}

export default App
