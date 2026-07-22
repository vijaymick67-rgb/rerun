import { useEffect, useRef } from 'react'
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
import { getRouteLevel, getRouteShellKey } from './lib/scrollRestoration'
import { advanceWatchingRefreshState } from './lib/watchingNavigation'
import usePressIntent from './hooks/usePressIntent'

// The Watching list is mounted exactly once for the whole app lifetime and kept
// mounted across BOTH its nested detail subtree AND genuine main-tab switches.
// Only its visibility toggles (display:none) — it never remounts on tab return.
//
// Why: the outer tab wrapper (RouteContent below) is keyed per shell and carries
// the `.route-content--tab` opacity fade. If Watching lived inside that wrapper,
// switching into it from another tab would change the key, remount every
// WatchingRow, and replay the fade over freshly-built rows. On iOS WebKit that
// remount+fade briefly exposes the red swipe-to-remove layer beneath the opaque
// row fronts (the "red flash"). PR #77 removed that precondition for detail
// round-trips (one shared shell key) but not for main-tab returns, which still
// remounted. Hosting Watching as a persistent sibling here removes the remount
// precondition for every route into Watching — cold entry, tab return, and
// detail Back alike — instead of masking the red color for a frame.
//
// `active`/`showing` (not "mounted") gates all visible-only and network work:
// while another tab or a detail overlay is on screen the list is inert (no open
// swipe row, no eager first load), and a quiet background refresh runs once each
// time the list comes back into view so data changed elsewhere still appears.
function PersistentWatching({ hidden }) {
  const location = useLocation()
  const detailOpen = getRouteLevel(location.pathname) > 0
  const showing = !hidden && !detailOpen

  // Bumps once each time the list transitions back into view (from a detail
  // overlay OR from another main tab), never on the initial reveal — that first
  // paint is served by Watching's own mount-time load.
  const refreshStateRef = useRef({ showing, hasShown: showing, refreshToken: 0 })
  refreshStateRef.current = advanceWatchingRefreshState(refreshStateRef.current, showing)
  const refreshToken = refreshStateRef.current.refreshToken

  return (
    <div
      className="route-content"
      style={hidden ? { display: 'none' } : undefined}
      aria-hidden={hidden || undefined}
    >
      <div style={detailOpen ? { display: 'none' } : undefined}>
        <Watching active={showing} refreshSignal={refreshToken} />
      </div>
      {detailOpen && (
        <div key={location.pathname} className="route-content route-content--nested">
          <Routes>
            <Route path="/watching/:tmdbId" element={<ShowDetail />} />
            <Route path="/watching/:tmdbId/season/:seasonNumber" element={<SeasonDetail />} />
          </Routes>
        </div>
      )}
    </div>
  )
}

// The non-Watching tabs keep the original behaviour exactly: a wrapper keyed by
// shell identity so each genuine tab switch remounts the destination and replays
// the `.route-content--tab` fade. These screens have no persistent swipe layer,
// so the fade is harmless for them and is intentionally preserved.
function OtherRoutes() {
  const location = useLocation()

  return (
    <div key={getRouteShellKey(location.pathname)} className="route-content route-content--tab">
      <Routes>
        <Route path="/browse" element={<Browse />} />
        <Route path="/stats/*" element={<Stats />} />
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

  usePressIntent()

  const location = useLocation()
  // getRouteShellKey resolves the whole Watching subtree (`/`, `/watching`, and
  // both nested detail depths) to the single `/watching` identity, so this is
  // true for exactly the routes the persistent list owns and false for every
  // other tab and for unknown (NotFound) paths.
  const isWatchingRoute = getRouteShellKey(location.pathname) === '/watching'

  return (
    <div className="app-shell">
      <GlobalTopScrim />
      <ScrollRestorationManager />
      <PersistentWatching hidden={!isWatchingRoute} />
      {!isWatchingRoute && <OtherRoutes />}
      <TabBar />
      <ReloadPrompt />
    </div>
  )
}

export default App
