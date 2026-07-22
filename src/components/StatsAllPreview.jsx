import { Link } from 'react-router-dom'
import { POSTER_BASE } from '../lib/tmdb'
import ProgressiveImage from './ProgressiveImage'

// Bounded so a long watch history never mounts every poster in the clipped
// preview row — CSS clips whatever doesn't fit on screen, this just caps how
// many exist in the DOM at all, regardless of total show count.
const PREVIEW_LIMIT = 6

// The narrowest supported width (~390px iPhone) only guarantees 3 full
// posters before the row clips — see .stats-all-preview__poster's clamp() in
// index.css. Below that count nothing is actually hidden, so the "more"
// affordance must stay off; at or above it, content is always clipped even
// though up to PREVIEW_LIMIT posters may be mounted in the DOM.
const MIN_SHOWS_WITHOUT_CLIPPING = 3

// Compact single-row entry point into /stats/all. The posters themselves are
// a passive visual preview — not a link — so tapping a poster does nothing.
// Only the right-edge overlay is interactive: one Link with a generous touch
// target, anchored to the card's right edge, doubling as the "more" gradient
// + chevron affordance. No nested interactive controls.
export default function StatsAllPreview({ shows }) {
  if (shows.length === 0) return null

  const previewShows = shows.slice(0, PREVIEW_LIMIT)
  const hasMore = shows.length > MIN_SHOWS_WITHOUT_CLIPPING

  return (
    <section className="mt-6" aria-labelledby="stats-all-title">
      <h2 id="stats-all-title" className="type-section-title mb-3">All({shows.length})</h2>
      <div className="stats-all-preview content-surface">
        <div className="stats-all-preview__row" aria-hidden="true">
          {previewShows.map((show) => (
            <div key={show.tmdb_id} className="stats-all-preview__poster">
              <ProgressiveImage
                src={show.poster_path ? POSTER_BASE + show.poster_path : null}
                alt=""
                fallbackLabel=""
                className="h-full w-full"
              />
            </div>
          ))}
        </div>
        {hasMore && (
          <Link
            to="/stats/all"
            aria-label={`View all ${shows.length} show${shows.length === 1 ? '' : 's'}`}
            className="stats-all-preview__more-link motion-press"
          >
            <span className="stats-all-preview__chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </Link>
        )}
      </div>
    </section>
  )
}
