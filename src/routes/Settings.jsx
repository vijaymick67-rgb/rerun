import { useRef, useState } from 'react'
import { importWatchHistory } from '../lib/importWatchHistory'
import { supabase } from '../lib/supabase'
import ConfirmDialog from '../components/ConfirmDialog'
import {
  EXCEPTION_SHOWS,
  planBulkMark,
  bulkMarkShows,
} from '../lib/bulkMarkWatched'
import { countWatchedEpisodes } from '../lib/watchedEpisodes'
import { finishTrackedShows } from '../lib/finishedShows'
import { clearWatchingCache } from '../lib/watchingCache'

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
    <div className="p-4">
      <h1 className="text-xl font-semibold text-(--color-text)">Settings</h1>

      <section className="mt-6">
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
            className="w-full rounded-md bg-(--color-accent) py-2 text-sm font-medium text-(--color-bg) disabled:opacity-60"
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
          <p className="mt-4 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        {summary && <ImportSummary summary={summary} />}
      </section>

      <div className="my-8 h-px bg-(--color-border)" />

      <BulkMarkTool />

      <div className="my-8 h-px bg-(--color-border)" />

      <FinishedRepairTool />
    </div>
  )
}

// The original bulk operation happened before finished_at existed. This repair
// has the same exception list and only updates tracked_shows; it never touches
// watched_episodes or their historical timestamps.
function FinishedRepairTool() {
  const [plan, setPlan] = useState(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)

  async function preview() {
    if (running) return
    setError(null)
    setResults(null)
    try {
      const { data, error: fetchError } = await supabase
        .from('tracked_shows')
        .select('tmdb_id, name, finished_at')
      if (fetchError) throw fetchError
      const base = planBulkMark(data ?? [])
      setPlan({ ...base, affected: base.affected.filter((show) => !show.finished_at) })
    } catch (err) {
      setError(err.message || 'Could not load the repair preview.')
    }
  }

  async function repair() {
    if (!plan || running) return
    setConfirmOpen(false)
    setRunning(true)
    setError(null)
    try {
      const rows = await finishTrackedShows(plan.affected, { supabase })
      setResults(rows)
      clearWatchingCache()
    } catch (err) {
      setError(err.message || 'Could not apply the repair.')
    } finally {
      setRunning(false)
    }
  }

  const failed = results?.filter((row) => row.error) ?? []
  const completed = results?.filter((row) => !row.error) ?? []

  return (
    <section>
      <h2 className="text-base font-semibold text-(--color-text)">Archive earlier bulk-marked shows</h2>
      <p className="mt-1 text-sm text-(--color-text-muted)">
        One-time repair for the earlier bulk-mark run. It marks the same non-exception
        shows finished, without changing any watched episodes or timestamps.
      </p>

      {!results && (
        <button type="button" onClick={preview} disabled={running} className="mt-4 w-full rounded-md border border-(--color-border) py-2 text-sm font-medium text-(--color-text) disabled:opacity-60">
          {plan ? 'Refresh repair preview' : 'Preview archive repair'}
        </button>
      )}

      {plan && !results && (
        <div className="mt-4 rounded-lg border border-(--color-border) bg-(--color-surface) p-3 text-sm">
          <p className="font-medium text-(--color-text)">Will mark finished ({plan.affected.length})</p>
          <p className="mt-1 text-(--color-text-muted)">
            Exception-list shows remain untouched ({plan.skipped.length} matched).
          </p>
          {plan.affected.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-(--color-text-muted)">
              {plan.affected.map((show) => <li key={show.tmdb_id}>{show.name}</li>)}
            </ul>
          )}
          <button type="button" onClick={() => setConfirmOpen(true)} disabled={running || plan.affected.length === 0} className="mt-4 w-full rounded-md bg-(--color-accent) py-2 text-sm font-medium text-(--color-bg) disabled:opacity-60">
            Archive {plan.affected.length} show{plan.affected.length === 1 ? '' : 's'}
          </button>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      {results && (
        <div className="mt-4 rounded-lg border border-(--color-border) bg-(--color-surface) p-3 text-sm">
          <p className="font-medium text-(--color-text)">{completed.length} show{completed.length === 1 ? '' : 's'} archived.</p>
          {failed.length > 0 && <p className="mt-1 text-red-400">{failed.length} show{failed.length === 1 ? '' : 's'} could not be archived.</p>}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={`Archive ${plan?.affected.length ?? 0} shows?`}
        message="This only sets the personal finished state. It does not delete shows or change watched episodes, timestamps, or Stats."
        confirmLabel="Archive shows"
        cancelLabel="Cancel"
        onConfirm={repair}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  )
}

// One-time maintenance tool: mark every aired episode of every tracked show
// watched, EXCEPT a fixed exception list. Deliberately cautious — a preview you
// must eyeball, then an explicit confirmation, before any write happens.
function BulkMarkTool() {
  // Lifecycle: idle → preview (plan loaded) → confirming → running → done.
  const [plan, setPlan] = useState(null)
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)

  function reset() {
    setPlan(null)
    setResults(null)
    setError(null)
    setProgress(null)
  }

  async function loadPlan() {
    if (loadingPlan || running) return
    reset()
    setLoadingPlan(true)
    try {
      const { data, error: fetchError } = await supabase
        .from('tracked_shows')
        .select('tmdb_id, name, finished_at')
      if (fetchError) throw fetchError
      if (!data || data.length === 0) {
        setError('No tracked shows found.')
        return
      }
      const base = planBulkMark(data)
      setPlan({ ...base, affected: base.affected.filter((show) => !show.finished_at) })
    } catch (err) {
      setError(err.message || 'Could not load your tracked shows.')
    } finally {
      setLoadingPlan(false)
    }
  }

  async function runBulkMark() {
    if (!plan || running) return
    setConfirmOpen(false)
    setRunning(true)
    setError(null)
    setProgress({ current: 0, total: plan.affected.length, label: 'Starting…' })
    try {
      const res = await bulkMarkShows(plan.affected, {
        onProgress: (p) => setProgress(p),
      })
      let readableCount = null
      let readBackError = null
      try {
        readableCount = await countWatchedEpisodes(
          supabase,
          plan.affected.map((show) => show.tmdb_id),
        )
      } catch (readError) {
        readBackError = readError.message || 'Unknown error'
      }
      setResults({ rows: res, readableCount, readBackError })
    } catch (err) {
      setError(err.message || 'Bulk-mark failed.')
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
    <section>
      <h2 className="text-base font-semibold text-(--color-text)">
        Bulk-mark watched
        <span className="ml-2 rounded-full bg-(--color-surface-raised) px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-(--color-text-muted)">
          One-time tool
        </span>
      </h2>
      <p className="mt-1 text-sm text-(--color-text-muted)">
        Marks every already-aired episode watched for all tracked shows{' '}
        <em>except</em> a fixed exception list ({EXCEPTION_SHOWS.length} shows,
        left completely untouched). Existing watched episodes are never
        overwritten, and re-running is harmless. This writes to a lot of shows at
        once — review the preview carefully before confirming.
      </p>

      {!results && (
        <button
          type="button"
          onClick={loadPlan}
          disabled={loadingPlan || running}
          className="mt-4 w-full rounded-md border border-(--color-border) py-2 text-sm font-medium text-(--color-text) disabled:opacity-60"
        >
          {loadingPlan ? 'Loading…' : plan ? 'Refresh preview' : 'Preview affected shows'}
        </button>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      {plan && !results && (
        <BulkPreview
          plan={plan}
          running={running}
          onConfirm={() => setConfirmOpen(true)}
        />
      )}

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

      {results && <BulkSummary results={results} plan={plan} onReset={reset} />}

      <ConfirmDialog
        open={confirmOpen}
        danger
        title={`Mark ${plan?.affected.length ?? 0} shows as watched?`}
        message={
          `This marks every aired episode watched for ${plan?.affected.length ?? 0} show${
            plan?.affected.length === 1 ? '' : 's'
          }. The ${plan?.skipped.length ?? 0} exception-list show${
            plan?.skipped.length === 1 ? '' : 's'
          } will not be touched. Existing watched episodes are never overwritten.`
        }
        confirmLabel="Yes, mark them"
        cancelLabel="Cancel"
        onConfirm={runBulkMark}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  )
}

function BulkPreview({ plan, running, onConfirm }) {
  return (
    <div className="mt-4 space-y-4">
      {plan.unmatchedExceptions.length > 0 && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-sm">
          <p className="font-medium text-amber-400">
            {plan.unmatchedExceptions.length} exception show
            {plan.unmatchedExceptions.length === 1 ? '' : 's'} not found in your
            tracked shows
          </p>
          <p className="mt-1 text-(--color-text-muted)">
            This usually means a naming mismatch (a stored title with a year
            suffix, different spelling, etc.). If any of these are actually
            tracked under a slightly different name, they would be marked below —
            check the affected list before confirming.
          </p>
          <ul className="mt-2 list-inside list-disc text-(--color-text)">
            {plan.unmatchedExceptions.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border border-(--color-border) bg-(--color-surface) p-3 text-sm">
        <p className="font-medium text-(--color-text)">
          Exceptions matched ({plan.matchedExceptions.length} of{' '}
          {EXCEPTION_SHOWS.length}) — will NOT be touched
        </p>
        {plan.matchedExceptions.length > 0 ? (
          <ul className="mt-2 list-inside list-disc text-(--color-text-muted)">
            {plan.matchedExceptions.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-(--color-text-muted)">None matched.</p>
        )}
      </div>

      <div className="rounded-lg border border-(--color-border) bg-(--color-surface) p-3 text-sm">
        <p className="font-medium text-(--color-text)">
          Would be marked watched ({plan.affected.length} show
          {plan.affected.length === 1 ? '' : 's'})
        </p>
        {plan.affected.length > 0 ? (
          <ul className="mt-2 list-inside list-disc text-(--color-text)">
            {plan.affected.map((show) => (
              <li key={show.tmdb_id}>{show.name}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-(--color-text-muted)">
            Nothing to mark — every tracked show is on the exception list.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={onConfirm}
        disabled={running || plan.affected.length === 0}
        className="w-full rounded-md bg-(--color-accent) py-2 text-sm font-medium text-(--color-bg) disabled:opacity-60"
      >
        Mark {plan.affected.length} show{plan.affected.length === 1 ? '' : 's'} as
        watched…
      </button>
    </div>
  )
}

function BulkSummary({ results, plan, onReset }) {
  const marked = results.rows.filter((r) => !r.error)
  const failed = results.rows.filter((r) => r.error)
  const totalInserted = marked.reduce((sum, r) => sum + r.insertedCount, 0)

  return (
    <div className="mt-5 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
      <p className="text-sm font-semibold text-(--color-text)">Bulk-mark complete</p>
      <p className="mt-1 text-sm text-(--color-text-muted)">
        {totalInserted} new episode{totalInserted === 1 ? '' : 's'} marked across{' '}
        {marked.length} show{marked.length === 1 ? '' : 's'}.
      </p>

      <p className="mt-3 rounded-md bg-(--color-surface-raised) px-3 py-2 text-xs text-(--color-text-muted)">
        {results.readBackError
          ? `Live read-back could not be verified: ${results.readBackError}`
          : `Live read-back: the app can now see ${results.readableCount} watched episode${
              results.readableCount === 1 ? '' : 's'
            } across the affected shows.`}
      </p>

      {marked.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="text-(--color-text-muted)">Marked:</p>
          <ul className="mt-1 space-y-0.5">
            {marked.map((r) => (
              <li
                key={r.tmdb_id}
                className="flex items-baseline justify-between gap-3 text-(--color-text)"
              >
                <span className="truncate">{r.name}</span>
                <span className="shrink-0 text-(--color-text-muted)">
                  {r.insertedCount} new
                  {r.insertedCount !== r.airedCount
                    ? ` · ${r.airedCount} aired`
                    : ''}
                  {r.failedSeasons > 0 ? ` · ${r.failedSeasons} season(s) skipped` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {failed.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="font-medium text-red-400">
            {failed.length} show{failed.length === 1 ? '' : 's'} skipped due to
            errors:
          </p>
          <ul className="mt-1 list-inside list-disc text-(--color-text-muted)">
            {failed.map((r) => (
              <li key={r.tmdb_id}>
                {r.name}: {r.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 rounded-md bg-(--color-surface-raised) px-3 py-2 text-xs text-(--color-text-muted)">
        Exception list left untouched ({plan?.skipped.length ?? 0} show
        {plan?.skipped.length === 1 ? '' : 's'}):{' '}
        {plan?.skipped.length > 0
          ? plan.skipped.map((s) => s.name).join(', ')
          : 'none tracked'}
      </p>

      <button
        type="button"
        onClick={onReset}
        className="mt-4 w-full rounded-md border border-(--color-border) py-2 text-sm font-medium text-(--color-text-muted)"
      >
        Done
      </button>
    </div>
  )
}

function ImportSummary({ summary }) {
  return (
    <div className="mt-5 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
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
