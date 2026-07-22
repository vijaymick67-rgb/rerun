import { useEffect, useState } from 'react'
import { removeStaticLoadingShell } from '../pwa/appShell'
import './loki-showcase.css'

const posters = {
  severance: '/loki-prototype/severance.svg',
  diplomat: '/loki-prototype/the-diplomat.svg',
  silo: '/loki-prototype/silo.svg',
  slowHorses: '/loki-prototype/slow-horses.svg',
}

const views = [
  { id: 'showcase', label: 'System' },
  { id: 'watching', label: 'Watching' },
  { id: 'detail', label: 'Show detail' },
  { id: 'insights', label: 'Insights' },
  { id: 'settings', label: 'Settings' },
]

function Icon({ name }) {
  const paths = {
    check: <path d="m6 12 4 4 8-9" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    clock: <><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" /></>,
    play: <path d="m9 7 8 5-8 5Z" />,
    close: <path d="m7 7 10 10M17 7 7 17" />,
    spark: <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7Z" />,
  }
  return <svg className="loki-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">{paths[name]}</svg>
}

function Poster({ src, alt, className = '' }) {
  return <img className={`loki-poster ${className}`} src={src} alt={alt} />
}

function StatusControl({ state = 'available', label }) {
  return (
    <button
      type="button"
      className="loki-status-control"
      data-state={state}
      disabled={state === 'disabled' || state === 'complete'}
      aria-label={label}
    >
      <Icon name="check" />
    </button>
  )
}

function Progress({ value, label }) {
  return (
    <div className="loki-progress" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin="0" aria-valuemax="100">
      <span style={{ width: `${value}%` }} />
    </div>
  )
}

function PrototypeTabBar({ selected = 'Watching' }) {
  return (
    <nav className="loki-tab-bar" aria-label="Prototype navigation">
      {['Discover', 'Watching', 'Insights', 'Settings'].map((item) => (
        <button key={item} type="button" aria-current={item === selected ? 'page' : undefined}>
          <span className="loki-tab-bar__rune" aria-hidden="true" />
          {item}
        </button>
      ))}
    </nav>
  )
}

function CompositionShell({ title, eyebrow, selectedTab, children }) {
  return (
    <article className="loki-composition" aria-label={`${title} visual composition`}>
      <div className="loki-composition__safe-area" aria-hidden="true" />
      <header className="loki-page-header">
        <div>
          <p className="loki-gold-label">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <span className="loki-header-sigil" aria-hidden="true"><Icon name="spark" /></span>
      </header>
      <div className="loki-composition__body">{children}</div>
      <PrototypeTabBar selected={selectedTab} />
    </article>
  )
}

function WatchingComposition() {
  const rows = [
    { title: 'Severance', meta: 'S2 E7 · Chikhai Bardo', when: 'Ready to watch', poster: posters.severance, state: 'available' },
    { title: 'The Diplomat', meta: 'S3 E4 · The Other Army', when: 'Caught up', poster: posters.diplomat, state: 'complete' },
    { title: 'Silo', meta: 'S2 E10 · Into the Fire', when: 'Friday · 1:30 PM', poster: posters.silo, state: 'disabled' },
  ]
  return (
    <CompositionShell title="Watching" eyebrow="Tonight’s queue" selectedTab="Watching">
      <section className="loki-forest-panel loki-next-panel" aria-labelledby="next-up-title">
        <div>
          <p className="loki-gold-label">Next in line</p>
          <h3 id="next-up-title">A measured return to Lumon</h3>
          <p className="loki-metadata">Three episodes are ready across your active shows.</p>
        </div>
        <span className="loki-chip">3 ready</span>
      </section>
      <div className="loki-watch-list">
        {rows.map((row) => (
          <article className="loki-watch-row" key={row.title}>
            <Poster src={row.poster} alt={`${row.title} abstract poster`} />
            <div className="loki-watch-row__copy">
              <h3>{row.title}</h3>
              <p>{row.meta}</p>
              <span className={row.state === 'disabled' ? 'loki-countdown' : ''}>{row.when}</span>
            </div>
            <StatusControl state={row.state} label={`${row.when}: ${row.title}`} />
          </article>
        ))}
      </div>
    </CompositionShell>
  )
}

function ShowDetailComposition() {
  return (
    <CompositionShell title="Severance" eyebrow="Show detail" selectedTab="Watching">
      <section className="loki-armour-card loki-detail-hero">
        <Poster src={posters.severance} alt="Severance abstract poster" />
        <div className="loki-detail-hero__copy">
          <span className="loki-chip">Returning series</span>
          <h3>Your innie has been waiting.</h3>
          <p className="loki-metadata">2 seasons · 17 released episodes</p>
          <Progress value={71} label="Severance watch progress" />
          <p className="loki-progress-copy">12 of 17 watched</p>
        </div>
      </section>
      <div className="loki-section-heading">
        <div><p className="loki-gold-label">Episode ledger</p><h3>Seasons</h3></div>
        <button className="loki-quiet-button" type="button">Show info</button>
      </div>
      <section className="loki-raised-card loki-season-row">
        <div><span className="loki-season-number">01</span><h3>Season one</h3><p>9 of 9 watched</p></div>
        <StatusControl state="complete" label="Season one complete" />
      </section>
      <section className="loki-raised-card loki-season-row">
        <div><span className="loki-season-number">02</span><h3>Season two</h3><p>3 of 8 watched</p></div>
        <span className="loki-row-chevron"><Icon name="chevron" /></span>
      </section>
    </CompositionShell>
  )
}

function InsightsComposition() {
  return (
    <CompositionShell title="Insights" eyebrow="Your viewing ledger" selectedTab="Insights">
      <section className="loki-armour-card loki-stat-hero">
        <p className="loki-gold-label">Time with your shows</p>
        <strong>6d 14h</strong>
        <p className="loki-metadata">Across 214 episodes since you began tracking.</p>
      </section>
      <section className="loki-forest-panel loki-insight-copy">
        <Icon name="spark" />
        <p>Your most patient watch was <strong>Slow Horses</strong> — never more than two episodes in one night.</p>
      </section>
      <div className="loki-section-heading">
        <div><p className="loki-gold-label">Collected stories</p><h3>All shows <span>12</span></h3></div>
      </div>
      <section className="loki-poster-rail" aria-label="Show history preview">
        {[posters.severance, posters.diplomat, posters.silo, posters.slowHorses].map((src, index) => (
          <Poster key={src} src={src} alt={['Severance', 'The Diplomat', 'Silo', 'Slow Horses'][index]} />
        ))}
        <button type="button" aria-label="View all shows" className="loki-rail-more">&gt;&gt;</button>
      </section>
    </CompositionShell>
  )
}

function SettingRow({ label, value, toggle, danger }) {
  return (
    <div className={`loki-setting-row${danger ? ' loki-setting-row--danger' : ''}`}>
      <div><h3>{label}</h3>{value && <p>{value}</p>}</div>
      {toggle ? <button type="button" role="switch" aria-checked="true" aria-label={label} className="loki-toggle"><span /></button> : <span className="loki-row-chevron"><Icon name="chevron" /></span>}
    </div>
  )
}

function SettingsComposition() {
  return (
    <CompositionShell title="Settings" eyebrow="Rerun preferences" selectedTab="Settings">
      <section className="loki-settings-group" aria-labelledby="notifications-title">
        <p className="loki-gold-label" id="notifications-title">Notifications</p>
        <SettingRow label="Episode reminders" value="At release time" toggle />
        <SettingRow label="Delivery window" value="Quiet after 11:00 PM" />
      </section>
      <section className="loki-settings-group" aria-labelledby="library-title">
        <p className="loki-gold-label" id="library-title">Library</p>
        <SettingRow label="Export watch history" value="Last backup · 12 July" />
        <SettingRow label="Import backup" value="JSON or CSV" />
      </section>
      <section className="loki-settings-group" aria-labelledby="account-title">
        <p className="loki-gold-label" id="account-title">Account</p>
        <SettingRow label="Sign out" value="vijay@rerun.app" danger />
      </section>
    </CompositionShell>
  )
}

function StateShowcase() {
  const [dialogOpen, setDialogOpen] = useState(
    () => new URLSearchParams(window.location.search).get('dialog') === 'open',
  )
  return (
    <CompositionShell title="Loki Armour" eyebrow="Prototype foundation" selectedTab="Watching">
      <section className="loki-armour-card loki-intro-card">
        <p className="loki-gold-label">Material study · Phase 0A</p>
        <h3>Leather, forest fabric, aged armour.</h3>
        <p className="loki-metadata">A semantic, low-light visual language for Rerun — not a production theme.</p>
      </section>
      <div className="loki-card-grid">
        <section className="loki-leather-card"><p className="loki-gold-label">Leather card</p><h3>Quiet foundation</h3><p>Near-black grain and a warm inner edge.</p></section>
        <section className="loki-raised-card"><p className="loki-gold-label">Raised panel</p><h3>Layered hierarchy</h3><p>For groups that need measured elevation.</p></section>
        <section className="loki-forest-panel"><p className="loki-gold-label">Forest tonal</p><h3>Atmosphere, not status</h3><p>A passive field for contextual emphasis.</p></section>
        <section className="loki-armour-card"><p className="loki-gold-label">Armour trim</p><h3>Structural emphasis</h3><p>Use sparingly for hero moments.</p></section>
      </div>
      <section className="loki-component-group" aria-labelledby="controls-title">
        <div className="loki-section-heading"><div><p className="loki-gold-label">Controls</p><h3 id="controls-title">Action hierarchy</h3></div></div>
        <div className="loki-button-grid">
          <button type="button" className="loki-button loki-button--primary"><Icon name="play" />Mark watched</button>
          <button type="button" className="loki-button loki-button--secondary">View season</button>
          <button type="button" className="loki-quiet-button">Not now</button>
          <button type="button" className="loki-button loki-button--destructive">Remove show</button>
        </div>
        <div className="loki-status-line">
          <div><StatusControl state="available" label="Episode unwatched" /><span>Unwatched</span></div>
          <div><StatusControl state="complete" label="Episode complete" /><span>Complete</span></div>
          <div><StatusControl state="disabled" label="Episode not ready" /><span>Not ready</span></div>
        </div>
      </section>
      <section className="loki-component-group">
        <p className="loki-gold-label">Progress & metadata</p>
        <div className="loki-progress-demo"><span>S2 · 7 of 10 watched</span><span className="loki-chip">Friday 1:30 PM</span></div>
        <Progress value={70} label="Example season progress" />
        <SettingRow label="Automatic episode reminders" value="Uses your release-time preference" toggle />
      </section>
      <section className="loki-state-grid">
        <div className="loki-state-card" role="status"><span className="loki-spinner" aria-hidden="true" /><h3>Loading your queue</h3><p>Reading the latest episode ledger.</p></div>
        <div className="loki-state-card"><span className="loki-state-mark">◇</span><h3>Nothing waiting</h3><p>Your active shows are caught up.</p></div>
        <div className="loki-state-card loki-state-card--error" role="alert"><span className="loki-state-mark">!</span><h3>Couldn’t refresh</h3><p>Your saved queue is still available.</p></div>
      </section>
      <section className="loki-skeleton-card" aria-label="Loading show preview" role="status">
        <span className="loki-skeleton loki-skeleton--poster" />
        <span><i className="loki-skeleton" /><i className="loki-skeleton loki-skeleton--short" /><i className="loki-skeleton" /></span>
      </section>
      <button type="button" className="loki-button loki-button--secondary loki-dialog-trigger" onClick={() => setDialogOpen(true)}>Open action sheet</button>
      {dialogOpen && (
        <div className="loki-dialog-backdrop">
          <section className="loki-dialog" role="dialog" aria-modal="true" aria-labelledby="loki-dialog-title">
            <button type="button" className="loki-dialog__close" onClick={() => setDialogOpen(false)} aria-label="Close action sheet"><Icon name="close" /></button>
            <p className="loki-gold-label">Show actions</p>
            <h3 id="loki-dialog-title">Remove Severance?</h3>
            <p>It leaves Watching, but your episode history remains in Insights.</p>
            <div><button type="button" className="loki-button loki-button--destructive">Remove show</button><button type="button" className="loki-button loki-button--secondary" onClick={() => setDialogOpen(false)}>Cancel</button></div>
          </section>
        </div>
      )}
    </CompositionShell>
  )
}

const compositions = { showcase: StateShowcase, watching: WatchingComposition, detail: ShowDetailComposition, insights: InsightsComposition, settings: SettingsComposition }

function initialView() {
  const requested = new URLSearchParams(window.location.search).get('view')
  return compositions[requested] ? requested : 'showcase'
}

export default function LokiShowcase() {
  const [activeView, setActiveView] = useState(initialView)
  const ActiveComposition = compositions[activeView]

  useEffect(() => {
    removeStaticLoadingShell()
  }, [])

  function selectView(view) {
    setActiveView(view)
    const url = new URL(window.location.href)
    url.searchParams.set('view', view)
    window.history.replaceState({}, '', url)
  }

  return (
    <main className="loki-prototype">
      <aside className="loki-prototype-nav">
        <div><p className="loki-gold-label">Rerun · Phase 0A</p><h1>Loki Armour</h1><p>Isolated visual prototype</p></div>
        <nav aria-label="Prototype views">
          {views.map((view) => <button type="button" key={view.id} aria-current={activeView === view.id ? 'page' : undefined} onClick={() => selectView(view.id)}>{view.label}</button>)}
        </nav>
        <p className="loki-prototype-nav__note">Development only · static fixtures · no product data</p>
      </aside>
      <section className="loki-stage" data-view={activeView}>
        <ActiveComposition />
      </section>
    </main>
  )
}
