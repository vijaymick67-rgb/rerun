import { Link, useLocation } from 'react-router-dom'
import { getRouteShellKey } from '../lib/scrollRestoration'

const TABS = [
  { to: '/browse', label: 'Discover' },
  { to: '/watching', label: 'Watching' },
  { to: '/stats', label: 'Insights' },
  { to: '/settings', label: 'Settings' },
]

export default function TabBar() {
  const { pathname } = useLocation()
  const activeTabPath = getRouteShellKey(pathname)

  return (
    <nav className="app-tab-bar fixed inset-x-0 bottom-0 flex border-t border-(--color-border) bg-(--color-surface)">
      {TABS.map((tab) => {
        const isActive = activeTabPath === tab.to
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={isActive ? 'page' : undefined}
            className={`app-tab-bar__link motion-press flex-1 py-3 text-center ${
              isActive
                ? 'text-(--color-accent)'
                : 'text-(--color-text-muted)'
            }`}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
