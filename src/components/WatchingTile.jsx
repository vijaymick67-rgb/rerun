import { Link } from 'react-router-dom'
import { POSTER_BASE } from '../lib/tmdb'

// Countdown copy differs for a true premiere (series debut or new season)
// vs. the next episode of a season that's already airing weekly.
function countdownLabel(status) {
  const isPremiere = status.subtype === 'premiere'
  if (status.airsSoon) return isPremiere ? 'Airs soon' : 'New episode soon'
  return isPremiere
    ? `Airs in ${status.daysUntil} days`
    : `New episode in ${status.daysUntil} days`
}

// A single poster tile in the Watching grid. The whole tile is a link into
// ShowDetail; the corner "×" (hover-revealed on desktop, always visible on
// touch via the .watching-tile-remove CSS gating) starts the remove/confirm
// flow. Status copy from computeWatchingStatus() renders as a compact caption
// under the poster so it stays legible at a narrow tile width.
export default function WatchingTile({ show, isRemoving, onRemove }) {
  return (
    <div className="watching-tile relative">
      <Link to={`/watching/${show.tmdb_id}`} className="block">
        {show.poster_path ? (
          <img
            src={POSTER_BASE + show.poster_path}
            alt={show.name}
            className="aspect-[2/3] w-full rounded-lg border border-(--color-border) object-cover"
          />
        ) : (
          <div className="flex aspect-[2/3] w-full items-center justify-center rounded-lg border border-(--color-border) bg-(--color-surface-raised) text-xs text-(--color-text-muted)">
            No poster
          </div>
        )}

        <div className="mt-1.5">
          <p className="truncate text-xs font-medium text-(--color-text)">{show.name}</p>

          {show.loadError ? (
            <p className="mt-0.5 text-[11px] text-red-400">Couldn't load</p>
          ) : show.status?.type === 'nextUp' ? (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-(--color-accent)">
              Up next: S{show.status.season_number}E{show.status.episode_number}
              {show.status.name ? ` · ${show.status.name}` : ''}
            </p>
          ) : show.status?.type === 'countdown' ? (
            <span className="mt-1 inline-flex w-fit items-center rounded-full bg-(--color-upcoming-muted) px-1.5 py-0.5 text-[10px] font-medium leading-snug text-(--color-upcoming)">
              {countdownLabel(show.status)}
            </span>
          ) : (
            <p className="mt-0.5 text-[11px] text-(--color-text-muted)">Caught up</p>
          )}
        </div>
      </Link>

      <button
        type="button"
        onClick={() => onRemove(show)}
        disabled={isRemoving}
        aria-label={`Remove ${show.name}`}
        className="watching-tile-remove absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-red-500/90 disabled:opacity-60"
      >
        {isRemoving ? (
          <span className="text-xs">…</span>
        ) : (
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>
    </div>
  )
}
