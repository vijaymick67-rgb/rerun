import { useEffect, useRef } from 'react'
import { Routes, Route, Outlet, useLocation } from 'react-router-dom'
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
import { getRouteLevel, getRouteShellKey } from './lib/scrollRestoration'
import { advanceWatchingRefreshState } from './lib/watchingNavigation'
import usePressIntent from './hooks/usePressIntent'

// The Watching list is a persistent layout parent for its whole subtree (the
// list plus the nested Show/Season detail routes). Because the single
// <Watching> instance lives above the <Outlet>, opening a detail route does
// NOT unmount it — it's only hidden while the detail overlay is on screen, then
// revealed untouched on Back: same scroll, same rows, same content, no
// skeleton, no page fade, no red Remove-layer flash. Detail routes render in a
// nested-entry wrapper via <Outlet>, keyed by pathname so each detail entry
// keeps its slide-in animation. When we return from a detail route the list is
// asked to refresh in the background (`refreshSignal`) so freshly-marked
// watched episodes are reflected without visibly reconstructing the screen.
function WatchingSubtree() {
  const location = useLocation()
  const detailOpen = getRouteLevel(location.pathname) > 0

  const refreshStateRef = useRef({ detailOpen, refreshToken: 0 })
  refreshStateRef.current = advanceWatchingRefreshState(
    refreshStateRef.current,
    detailOpen,
  )

  return (
    <>
      <div style={detailOpen ? { display: 'none' } : undefined}>
        <Watching
          active={!detailOpen}
          refreshSignal={refreshStateRef.current.refreshToken}
        />
      </div>
      {detailOpen && (
        <div key={location.pathname} className="route-content route-content--nested">
          <Outlet />
        </div>
      )}
    </>
  )
}

function RouteContent() {
  const location = useLocation()

  return (
    <div key={getRouteShellKey(location.pathname)} className="route-content route-content--tab">
      <Routes>
        <Route path="/browse" element={<Browse />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/settings" element={<Settings />} />
        <Route element={<WatchingSubtree />}>
          <Route path="/" element={null} />
          <Route path="/watching" element={null} />
          <Route path="/watching/:tmdbId" element={<ShowDetail />} />
          <Route path="/watching/:tmdbId/season/:seasonNumber" element={<SeasonDetail />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </div>
  )
}

function App() {
  useEffect(() => {
    removeStaticLoadingShell()
  }, [])

  usePressIntent()

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
