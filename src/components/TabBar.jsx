import { Link, useLocation } from 'react-router-dom'
import { getRouteShellKey } from '../lib/scrollRestoration'

function DiscoverIcon() {
  return (
    <svg viewBox="0 0 24 24" className="tab-icon" aria-hidden="true">
      <circle cx="12" cy="12" r="8.25" />
      <path d="M14.6 9.4 12.9 12.9 9.4 14.6 11.1 11.1Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

function WatchingIcon() {
  return (
    <svg viewBox="0 0 24 24" className="tab-icon" aria-hidden="true">
      <rect x="3.75" y="5.5" width="16.5" height="11" rx="2.25" />
      <path d="M8.25 18.75h7.5" />
      <path d="M10 9.25 15 12l-5 2.75V9.25Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

function InsightsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="tab-icon tab-icon--solid" aria-hidden="true">
      <rect x="5" y="12" width="3.5" height="7" rx="1" />
      <rect x="10.25" y="8" width="3.5" height="11" rx="1" />
      <rect x="15.5" y="4.5" width="3.5" height="14.5" rx="1" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="tab-icon" aria-hidden="true">
      <path d="M4.5 7.5h9.5M16.5 7.5h3" />
      <path d="M4.5 12h2M9.5 12h10" />
      <path d="M4.5 16.5h10.5M17.5 16.5h2" />
      <circle cx="14" cy="7.5" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="12" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="16.5" r="1.75" fill="currentColor" stroke="none" />
    </svg>
  )
}

const TABS = [
  { to: '/browse', label: 'Discover', Icon: DiscoverIcon },
  { to: '/watching', label: 'Watching', Icon: WatchingIcon },
  { to: '/stats', label: 'Insights', Icon: InsightsIcon },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
]

export default function TabBar() {
  const { pathname } = useLocation()
  const activeTabPath = getRouteShellKey(pathname)

  return (
    <nav
      aria-label="Primary"
      className="app-tab-bar fixed inset-x-0 bottom-0 flex border-t border-(--color-border) bg-(--color-surface)"
    >
      {TABS.map(({ to, label, Icon }) => {
        const isActive = activeTabPath === to
        return (
          <Link
            key={to}
            to={to}
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            className="app-tab-bar__link motion-press flex-1"
          >
            <Icon />
          </Link>
        )
      })}
    </nav>
  )
}
