import { Link, useNavigate } from 'react-router-dom'
import { POSTER_BASE } from '../lib/tmdb'
import { handleTapNavigateClick } from '../lib/pressIntent'
import ProgressiveImage from './ProgressiveImage'

// Poster + three-dot action control + title, as used in the All Shows grid.
// Extracted from Stats.jsx unchanged so the expanded page and the (now
// removed) inline grid share exactly one rendering path.
export default function StatsShowCard({ show, busy, actionsOpen, onOpenActions }) {
  const navigate = useNavigate()

  return (
    <article className="stats-show-card min-w-0">
      <div className="stats-show-card__poster relative">
        <Link
          to={`/watching/${show.tmdb_id}`}
          onClick={(e) => handleTapNavigateClick(e, navigate, `/watching/${show.tmdb_id}`)}
          className="motion-press block"
        >
          <ProgressiveImage
            src={show.poster_path ? POSTER_BASE + show.poster_path : null}
            alt={show.name}
            fallbackLabel="No poster"
            className="poster-card aspect-[2/3] w-full"
          />
        </Link>

        <button
          type="button"
          aria-label={`Actions for ${show.name}`}
          aria-expanded={actionsOpen}
          aria-controls="stats-actions-sheet"
          onClick={() => onOpenActions(show.tmdb_id)}
          disabled={busy}
          className="motion-press absolute left-0 top-0 z-10 flex h-11 w-11 items-start justify-start p-1.5 stats-show-card__actions disabled:opacity-60"
        >
          <svg
            viewBox="0 0 14 4"
            className="h-2 w-3.5"
            aria-hidden="true"
          >
            <circle cx="2" cy="2" r="1.5" />
            <circle cx="7" cy="2" r="1.5" />
            <circle cx="12" cy="2" r="1.5" />
          </svg>
        </button>
      </div>

      <p className="type-show-title mt-1.5 truncate text-(--color-text)">
        {show.name}
      </p>
    </article>
  )
}
