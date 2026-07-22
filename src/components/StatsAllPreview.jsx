import { Link } from 'react-router-dom'
import { POSTER_BASE } from '../lib/tmdb'
import ProgressiveImage from './ProgressiveImage'

// Bounded so a long watch history never mounts every poster in the clipped
// preview row — CSS clips whatever doesn't fit on screen, this just caps how
// many exist in the DOM at all, regardless of total show count.
const PREVIEW_LIMIT = 6

// The narrowest supported width (~390px iPhone) only guarantees 3 full
// posters before the row clips — see .stats-all-preview__poster's width
// calc() in index.css. Below that count nothing is actually hidden, so the
// "more" affordance must stay off; at or above it, content is always clipped
// even though up to PREVIEW_LIMIT posters may be mounted in the DOM.
const MIN_SHOWS_WITHOUT_CLIPPING = 3

// Compact single-row entry point into /stats/all. The posters themselves are
// a passive visual preview inside an aria-hidden row — tapping a poster does
// nothing. The visible sliver of the 4th poster is covered by a separate
// "continuation" overlay: a decorative shade (pointer-events: none) plus one
// small ">>" link. That overlay carries an explicit z-index ABOVE the poster
// <img> (.progressive-image__img is position:relative; z-index:1, so without
// this the loaded artwork paints over the shade and ">>" — the exact reason
// the prior static-harness "fix" looked correct but vanished on a real device
// once the posters actually loaded). No circular button, no SVG, no card-wide
// overlay. The ">>" link is the only interactive element.
export default function StatsAllPreview({ shows }) {
  if (shows.length === 0) return null

  const previewShows = shows.slice(0, PREVIEW_LIMIT)
  const hasMore = shows.length > MIN_SHOWS_WITHOUT_CLIPPING

  return (
    <section className="stats-archive-preview" aria-labelledby="stats-all-title">
      <div className="stats-archive-preview__heading">
        <div>
          <p className="type-badge text-(--color-gold-accent)">Show history</p>
          <h2 id="stats-all-title" className="type-section-title">All({shows.length})</h2>
        </div>
        <span className="stats-archive-preview__hint type-caption" aria-hidden="true">Archive</span>
      </div>
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
          <div className="stats-all-preview__continuation">
            <div className="stats-all-preview__continuation-shade" aria-hidden="true" />
            <Link
              to="/stats/all"
              aria-label={`View all ${shows.length} shows`}
              className="stats-all-preview__more-link"
            >
              <span className="stats-all-preview__more-text" aria-hidden="true">{'>>'}</span>
            </Link>
          </div>
        )}
      </div>
    </section>
  )
}
