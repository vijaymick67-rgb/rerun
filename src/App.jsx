import { Routes, Route } from 'react-router-dom'
import TabBar from './components/TabBar'
import Browse from './routes/Browse'
import Watching from './routes/Watching'
import ShowDetail from './routes/ShowDetail'
import SeasonDetail from './routes/SeasonDetail'
import Log from './routes/Log'
import Stats from './routes/Stats'

function App() {
  return (
    <div className="min-h-screen pb-16">
      <Routes>
        <Route path="/" element={<Browse />} />
        <Route path="/watching" element={<Watching />} />
        <Route path="/watching/:tmdbId" element={<ShowDetail />} />
        <Route path="/watching/:tmdbId/season/:seasonNumber" element={<SeasonDetail />} />
        <Route path="/log" element={<Log />} />
        <Route path="/stats" element={<Stats />} />
      </Routes>
      <TabBar />
    </div>
  )
}

export default App
