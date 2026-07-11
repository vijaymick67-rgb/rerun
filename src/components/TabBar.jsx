import { NavLink } from 'react-router-dom'

const TABS = [
  { to: '/', label: 'Browse' },
  { to: '/watching', label: 'Watching' },
  { to: '/log', label: 'Log' },
  { to: '/stats', label: 'Stats' },
]

export default function TabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 flex border-t border-(--color-border) bg-(--color-surface)">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === '/'}
          className={({ isActive }) =>
            `flex-1 py-3 text-center text-sm ${
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
