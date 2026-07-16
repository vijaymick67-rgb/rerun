import { useRef, useState } from 'react'
import { importWatchHistory } from '../lib/importWatchHistory'

export default function Settings() {
  const [file, setFile] = useState(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  function handleFileChange(e) {
    setFile(e.target.files?.[0] ?? null)
    setSummary(null)
    setError(null)
    setProgress(null)
  }

  async function handleImport() {
    if (!file || running) return
    setRunning(true)
    setSummary(null)
    setError(null)
    setProgress({ label: 'Reading file…', current: 0, total: 0 })

    try {
      const text = await file.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error("Couldn't read that file — it isn't valid JSON.")
      }

      const result = await importWatchHistory(json, {
        onProgress: (p) => setProgress(p),
      })
      setSummary(result)
    } catch (err) {
      setError(err.message || 'Import failed.')
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : null

  return (
    <div className="app-page px-4 pb-4">
      <section>
        <h2 className="text-base font-semibold text-(--color-text)">
          Import watch history
        </h2>
        <p className="mt-1 text-sm text-(--color-text-muted)">
          Import a JSON backup from another TV-tracking app. Shows and watched
          episodes are added to Rerun — nothing you already have is overwritten,
          and running it twice is safe.
        </p>

        <div className="mt-4 space-y-3">
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            disabled={running}
            className="block w-full text-sm text-(--color-text-muted) file:mr-3 file:rounded-md file:border-0 file:bg-(--color-surface-raised) file:px-3 file:py-2 file:text-sm file:font-medium file:text-(--color-text) disabled:opacity-60"
          />

          <button
            type="button"
            onClick={handleImport}
            disabled={!file || running}
            className="motion-press w-full rounded-md bg-(--color-accent) py-2 text-sm font-medium text-(--color-bg) disabled:opacity-60"
          >
            {running ? 'Importing…' : 'Import'}
          </button>
        </div>

        {progress && (
          <div className="mt-4">
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

        {error && (
          <p className="motion-banner mt-4 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        {summary && <ImportSummary summary={summary} />}
      </section>
    </div>
  )
}

function ImportSummary({ summary }) {
  return (
    <div className="motion-banner mt-5 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
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
            {summary.errors.length} issue{summary.errors.length === 1 ? '' : 's'}{' '}
            (import continued):
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
