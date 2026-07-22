import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import StatsShowCard from '../components/StatsShowCard'
import { isStatsShowBusy, statsActionItems } from '../lib/showState'

function StatsActionSheet({ show, busy, onClose, onRestore, onRemove }) {
  useEffect(() => {
    if (!show) return undefined
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, show])

  if (!show) return null

  const titleId = `stats-actions-title-${show.tmdb_id}`

  return (
    <div
      className="stats-action-sheet-backdrop safe-area-overlay fixed inset-0 z-40 flex items-end justify-center px-4"
      onClick={onClose}
    >
      <div
        id="stats-actions-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="stats-action-sheet max-h-[calc(100dvh-6rem)] w-full max-w-md overflow-y-auto p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="min-w-0 break-words text-base font-semibold text-(--color-text)">
            Actions for {show.name}
          </h2>
          <button
            type="button"
            aria-label="Close actions"
            onClick={onClose}
            className="motion-press min-h-11 min-w-11 shrink-0 rounded-lg text-xl leading-none text-(--color-text-muted)"
          >
            ×
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          {statsActionItems(show).map((item) => {
            if (item.id === 'details') {
              return (
                <Link
                  key={item.id}
                  to={`/watching/${show.tmdb_id}`}
                  aria-disabled={busy}
                  onClick={(event) => {
                    if (busy) {
                      event.preventDefault()
                      return
                    }
                    onClose()
                  }}
                  className="surface-interactive motion-press flex min-h-11 w-full items-center px-3 text-left text-sm font-medium text-(--color-text)"
                >
                  {item.label}
                </Link>
              )
            }

            if (item.id === 'cancel') {
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={onClose}
                  className="motion-press min-h-11 w-full rounded-lg px-3 text-left text-sm font-medium text-(--color-text-muted)"
                >
                  {item.label}
                </button>
              )
            }

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onClose()
                  if (item.id === 'restore') onRestore()
                  if (item.id === 'remove') onRemove()
                }}
                disabled={busy}
                  className={`motion-press stats-action-${item.destructive ? 'destructive' : 'secondary'} min-h-11 w-full rounded-lg px-3 text-left text-sm font-medium disabled:opacity-60 ${
                  item.destructive ? 'text-(--color-destructive)' : 'text-(--color-text-secondary)'
                }`}
              >
                {busy && item.id === 'restore' ? 'Restoring…' : item.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// Dedicated /stats/all route — the full represented-show grid, reading state
// owned and loaded by the parent Stats route (see App.jsx / Stats.jsx) so
// entering this page never triggers a second TMDB/Supabase load.
export default function StatsAllShows({
  loading,
  error,
  shows,
  busyIds,
  openActionId,
  actionError,
  actionSuccess,
  confirmingShow,
  onOpenActions,
  onCloseActions,
  onRestore,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
  onRetry,
}) {
  const navigate = useNavigate()

  const isEmptyResult = !loading && !error && shows.length === 0

  useEffect(() => {
    // Covers both a genuinely empty history (direct URL entry) and removing
    // the last remaining show while on this page — either way there is
    // nothing left to show here, so hand back to the main Insights empty
    // state rather than leaving a stale, count-less grid on screen.
    if (isEmptyResult) navigate('/stats', { replace: true })
  }, [isEmptyResult, navigate])

  if (isEmptyResult) return null

  const actionShow = openActionId === null
    ? null
    : shows.find((show) => show.tmdb_id === openActionId) ?? null

  const showSkeleton = loading && shows.length === 0 && !error

  return (
    <div className="stats-all-page nested-page px-4 pb-4">
      <div className="nested-header">
        <Link
          to="/stats"
          aria-label="Back to Insights"
          className="nested-header__back motion-press min-h-11 min-w-11"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m15 5-7 7 7 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <h1 className="nested-header__copy nested-header__title type-nested-title text-(--color-text)">All Shows</h1>
      </div>

      {error && shows.length === 0 && (
        <div className="status-banner status-banner--destructive motion-banner mt-4 flex items-center justify-between gap-3 text-sm">
          <span>{error.message} <span className="whitespace-nowrap">({error.code})</span></span>
          <button
            type="button"
            onClick={onRetry}
            className="focus-ring motion-press min-h-11 shrink-0 rounded-md px-3 font-semibold text-(--color-destructive)"
          >
            Retry
          </button>
        </div>
      )}

      {actionError && (
        <div role="alert" className="status-banner status-banner--destructive motion-banner mt-4 min-w-0 break-words text-sm">
          {actionError}
        </div>
      )}

      {actionSuccess && (
        <div role="status" className="status-banner status-banner--success motion-banner mt-4 min-w-0 break-words text-sm">
          {actionSuccess}
        </div>
      )}

      {showSkeleton && (
        <div className="stats-all-grid stats-all-grid--loading" aria-label="Loading shows" role="status">
          {Array.from({ length: 9 }).map((_, index) => (
            <div key={index} className="skeleton-block aspect-[2/3] w-full rounded-[var(--radius-poster)]" />
          ))}
        </div>
      )}

      {shows.length > 0 && (
        <div className="stats-all-grid grid grid-cols-3">
          {shows.map((show) => (
            <StatsShowCard
              key={show.tmdb_id}
              show={show}
              busy={isStatsShowBusy(busyIds, show.tmdb_id)}
              actionsOpen={openActionId === show.tmdb_id}
              onOpenActions={onOpenActions}
            />
          ))}
        </div>
      )}

      <StatsActionSheet
        show={actionShow}
        busy={actionShow ? isStatsShowBusy(busyIds, actionShow.tmdb_id) : false}
        onClose={onCloseActions}
        onRestore={() => actionShow && onRestore(actionShow)}
        onRemove={() => actionShow && onRequestRemove(actionShow)}
      />

      <ConfirmDialog
        open={confirmingShow !== null}
        title={confirmingShow ? `Remove ${confirmingShow.name} from Rerun?` : 'Remove show?'}
        message={
          confirmingShow
            ? `It will disappear from Insights and Watching, but your watched episodes and watch dates will be preserved. Adding it again later will restore your progress.`
            : ''
        }
        confirmLabel="Remove from Insights"
        cancelLabel="Cancel"
        danger
        onConfirm={onConfirmRemove}
        onCancel={onCancelRemove}
      />
    </div>
  )
}
