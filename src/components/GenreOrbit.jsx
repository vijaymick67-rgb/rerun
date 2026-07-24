import { useId } from 'react'
import {
  buildGenreOrbitDistribution,
  formatGenreMinutes,
} from '../lib/insights/genreDistribution.js'

function segmentGeometry(entries) {
  let offset = 0
  return entries.map((entry) => {
    const percentage = entry.percentage
    const gap = entries.length > 1 ? Math.min(0.8, percentage * 0.18) : 0
    const visiblePercentage = Math.max(0, percentage - gap)
    const geometry = {
      ...entry,
      dashArray: `${visiblePercentage} ${100 - visiblePercentage}`,
      dashOffset: -(offset + gap / 2),
    }
    offset += percentage
    return geometry
  })
}

export default function GenreOrbit({ distribution }) {
  const titleId = useId()
  const descriptionId = useId()
  const orbit = buildGenreOrbitDistribution(distribution)
  if (orbit.entries.length === 0) return null

  const segments = segmentGeometry(orbit.entries)
  const summary = orbit.entries
    .map((entry) => `${entry.genre} ${entry.displayPercentage}%`)
    .join(', ')

  return (
    <section className="genre-orbit content-surface" aria-labelledby={titleId}>
      <div className="genre-orbit__heading">
        <div>
          <p className="genre-orbit__eyebrow type-badge">Your genre universe</p>
          <h2 id={titleId} className="genre-orbit__title type-section-title">
            Genre orbit
          </h2>
        </div>
        <p className="genre-orbit__basis type-caption">By watched runtime</p>
      </div>

      <p id={descriptionId} className="sr-only">
        Genre distribution based on watched episode runtime. {summary}.
      </p>

      <div className="genre-orbit__body">
        <figure
          className="genre-orbit__figure"
          role="img"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
        >
          <div className="genre-orbit__halo" aria-hidden="true" />
          <svg
            className="genre-orbit__chart"
            viewBox="0 0 120 120"
            aria-hidden="true"
          >
            <circle className="genre-orbit__track genre-orbit__track--outer" cx="60" cy="60" r="54" />
            <circle className="genre-orbit__track" cx="60" cy="60" r="44" />
            {segments.map((segment) => (
              <circle
                key={segment.genre}
                className={`genre-orbit__segment genre-color-${segment.colorIndex}`}
                cx="60"
                cy="60"
                r="44"
                pathLength="100"
                strokeDasharray={segment.dashArray}
                strokeDashoffset={segment.dashOffset}
              />
            ))}
            <circle className="genre-orbit__inner-ring" cx="60" cy="60" r="31" />
          </svg>
          <figcaption className="genre-orbit__centre">
            <span className="genre-orbit__dominant-name">{orbit.dominant.genre}</span>
            <strong className="genre-orbit__dominant-percent">
              {orbit.dominant.displayPercentage}%
            </strong>
          </figcaption>
        </figure>

        <ol className="genre-orbit__list" aria-label="Genre percentages">
          {orbit.entries.map((entry) => (
            <li key={entry.genre} className="genre-orbit__item">
              <span
                className={`genre-orbit__swatch genre-color-bg-${entry.colorIndex}`}
                aria-hidden="true"
              />
              <span className="genre-orbit__genre">{entry.genre}</span>
              <span className="genre-orbit__runtime type-caption">
                {formatGenreMinutes(entry.minutes)}
              </span>
              <strong className="genre-orbit__percent">
                {entry.displayPercentage}%
              </strong>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
