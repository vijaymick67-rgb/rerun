import { NavLink } from 'react-router-dom'

const TABS = [
  { to: '/browse', label: 'Discover' },
  { to: '/watching', label: 'Watching' },
  { to: '/stats', label: 'Insights' },
  { to: '/settings', label: 'Settings' },
]

export default function TabBar() {
  return (
    <nav className="app-tab-bar fixed inset-x-0 bottom-0 flex border-t border-(--color-border) bg-(--color-surface)">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            `motion-press flex-1 py-3 text-center text-sm ${
              isActive
                ? 'text-(--color-accent)'
                : 'text-(--color-text-muted)'
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
