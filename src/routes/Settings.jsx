import { useRef, useState } from 'react'
import {
  buildBackup,
  backupFilename,
  downloadBackupFile,
  importBackupFile,
} from '../lib/backup'

function plural(count, singular, pluralWord = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralWord}`
}

function Chevron() {
  return (
    <svg viewBox="0 0 8 14" className="h-3.5 w-2 shrink-0 text-(--color-text-muted)" aria-hidden="true">
      <path
        d="M1 1l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SettingsSection({ title, children }) {
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-(--color-text-muted)">
        {title}
      </h2>
      <div className="divide-y divide-(--color-border) overflow-hidden rounded-xl border border-(--color-border) bg-(--color-surface)">
        {children}
      </div>
    </section>
  )
}

function SettingsActionRow({ label, onPress, disabled, busyLabel }) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      className="motion-press flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm font-medium text-(--color-text) disabled:opacity-60"
    >
      <span>{label}</span>
      {busyLabel ? (
        <span className="text-xs font-normal text-(--color-text-muted)">{busyLabel}</span>
      ) : (
        <Chevron />
      )}
    </button>
  )
}

function SettingsInfoRow({ label, status }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5 text-sm">
      <span className="font-medium text-(--color-text-muted)">{label}</span>
      <span className="rounded-full bg-(--color-surface-raised) px-2.5 py-1 text-xs font-medium text-(--color-text-muted)">
        {status}
      </span>
    </div>
  )
}

function Banner({ tone, children }) {
  const toneClass =
    tone === 'error'
      ? 'border-red-400/40 bg-red-400/10 text-red-400'
      : 'border-(--color-accent) bg-(--color-accent-muted) text-(--color-text)'
  return (
    <p className={`motion-banner mt-3 rounded-lg border px-3 py-2 text-sm ${toneClass}`}>
      {children}
    </p>
  )
}

export default function Settings() {
  return (
    <div className="app-page px-4 pb-6">
      <BackupRestoreSection />
      <NotificationsSection />
    </div>
  )
}

function BackupRestoreSection() {
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState(null)
  const [exportError, setExportError] = useState(null)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [summary, setSummary] = useState(null)
  const [importError, setImportError] = useState(null)
  const inputRef = useRef(null)

  const busy = exporting || running

  async function handleExport() {
    if (busy) return
    setExporting(true)
    setExportNotice(null)
    setExportError(null)
    try {
      const backup = await buildBackup()
      downloadBackupFile(backup, backupFilename())
      const { trackedShows, watchedEpisodes } = backup.data
      setExportNotice(
        `Exported ${plural(trackedShows.length, 'show')} and ${plural(watchedEpisodes.length, 'watched episode')}.`,
      )
    } catch (err) {
      setExportError(err.message || 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  function handleImportRowPress() {
    if (busy) return
    inputRef.current?.click()
  }

  async function handleFileSelected(e) {
    const selected = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!selected || busy) return

    setRunning(true)
    setSummary(null)
    setImportError(null)
    setProgress({ phase: 'reading', current: 0, total: 0, label: 'Reading file…' })

    try {
      const text = await selected.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error("Couldn't read that file — it isn't valid JSON.")
      }

      const result = await importBackupFile(json, { onProgress: setProgress })
      setSummary(result)
    } catch (err) {
      setImportError(err.message || 'Import failed.')
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const progressPct =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : null

  return (
    <>
      <SettingsSection title="Backup & Restore">
        <SettingsActionRow
          label="Export backup"
          onPress={handleExport}
          disabled={busy}
          busyLabel={exporting ? 'Exporting…' : null}
        />
        <SettingsActionRow
          label="Import backup"
          onPress={handleImportRowPress}
          disabled={busy}
          busyLabel={running ? 'Importing…' : null}
        />
      </SettingsSection>

      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleFileSelected}
        disabled={busy}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
      />

      {exportNotice && <Banner tone="success">{exportNotice}</Banner>}
      {exportError && <Banner tone="error">{exportError}</Banner>}

      {progress && (
        <div className="mt-3">
          <p className="text-sm text-(--color-text-muted)">{progress.label}</p>
          {progressPct !== null && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-(--color-surface-raised)">
              <div
                className="h-full rounded-full bg-(--color-accent) transition-[width] duration-200"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
        </div>
      )}

      {importError && <Banner tone="error">{importError}</Banner>}

      {summary?.kind === 'native' && <NativeImportSummary summary={summary} />}
      {summary?.kind === 'external' && <ExternalImportSummary summary={summary} />}
    </>
  )
}

function NativeImportSummary({ summary }) {
  return (
    <div className="motion-banner mt-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
      <p className="text-sm font-semibold text-(--color-text)">Import complete</p>

      <dl className="mt-3 space-y-1.5 text-sm">
        <SummaryRow
          label="Shows added"
          value={`${summary.showsAdded} new · ${summary.showsAlreadyTracked} already tracked`}
        />
        <SummaryRow
          label="Watched episodes added"
          value={`${summary.episodesAdded} new · ${summary.episodesAlreadyLogged} already logged`}
        />
        {summary.showsDuplicateInFile > 0 && (
          <SummaryRow label="Duplicate shows in file" value={summary.showsDuplicateInFile} />
        )}
        {summary.episodesDuplicateInFile > 0 && (
          <SummaryRow label="Duplicate episodes in file" value={summary.episodesDuplicateInFile} />
        )}
        {summary.showsFailed > 0 && (
          <SummaryRow label="Shows failed to write" value={summary.showsFailed} />
        )}
        {summary.episodesFailed > 0 && (
          <SummaryRow label="Episodes failed to write" value={summary.episodesFailed} />
        )}
      </dl>

      {summary.errors.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="font-medium text-red-400">
            {plural(summary.errors.length, 'issue')} (import continued):
          </p>
          <ul className="mt-1 list-inside list-disc text-(--color-text-muted)">
            {summary.errors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ExternalImportSummary({ summary }) {
  return (
    <div className="motion-banner mt-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
      <p className="text-sm font-semibold text-(--color-text)">Import complete</p>

      <dl className="mt-3 space-y-1.5 text-sm">
        <SummaryRow
          label="Shows tracked"
          value={`${summary.showsNewlyTracked} new · ${summary.showsTotal} total`}
        />
        <SummaryRow label="Episodes imported" value={summary.episodesImported} />
        {summary.seasonMarkersApplied > 0 && (
          <SummaryRow
            label="Seasons filled from markers"
            value={summary.seasonMarkersApplied}
          />
        )}
      </dl>

      {summary.fallbackShows.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="text-(--color-text-muted)">
            Marked fully watched (no per-episode data in the backup):
          </p>
          <ul className="mt-1 list-inside list-disc text-(--color-text)">
            {summary.fallbackShows.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.errors.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="font-medium text-red-400">
            {plural(summary.errors.length, 'issue')} (import continued):
          </p>
          <ul className="mt-1 list-inside list-disc text-(--color-text-muted)">
            {summary.errors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function SummaryRow({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-(--color-text-muted)">{label}</dt>
      <dd className="font-medium text-(--color-text)">{value}</dd>
    </div>
  )
}

function NotificationsSection() {
  return (
    <SettingsSection title="Notifications">
      <SettingsInfoRow label="Episode notifications" status="Coming soon" />
    </SettingsSection>
  )
}
