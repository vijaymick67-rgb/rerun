import { useEffect, useMemo, useRef, useState } from 'react'
import ProgressiveImage from './ProgressiveImage'
import { POSTER_BASE } from '../lib/tmdb'
import {
  announcementItemsForTrackedShows,
  loadDiscover,
  trailerItemsForTrackedShows,
} from '../lib/discover/discoverClient.js'
import {
  dismissAnnouncement,
  readAnnouncementsCache,
  writeAnnouncementsCache,
} from '../lib/discover/announcementStore.js'
import {
  dismissTrailer,
  readTrailersCache,
  writeTrailersCache,
} from '../lib/discover/trailerStore.js'

const MAX_VISIBLE_ANNOUNCEMENTS = 10
const MAX_VISIBLE_TRAILERS = 8

function safeExternalUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function artworkUrl({ imageUrl, posterPath, backdropPath }) {
  const direct = safeExternalUrl(imageUrl)
  if (direct) return direct
  const path = posterPath ?? backdropPath
  return typeof path === 'string' && path.startsWith('/') ? POSTER_BASE + path : null
}

function formatDiscoverFreshness(value, now = Date.now()) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  const days = Math.max(0, Math.floor((now - timestamp) / (24 * 60 * 60 * 1000)))
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 14) return `${days}d ago`
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
    .format(new Date(timestamp))
}

function formatReleaseContext(value, now = Date.now()) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
    .format(new Date(timestamp))
  return timestamp >= now ? `Releases ${date}` : `Released ${date}`
}

function initialFeed(items, lastSuccess) {
  return {
    items,
    loading: items.length === 0,
    refreshing: items.length > 0,
    error: null,
    lastSuccess,
  }
}

function createInitialDiscoverState({
  trackedShows = [],
  trackedShowsReady = false,
  storage = globalThis.localStorage,
  now = Date.now(),
} = {}) {
  if (!trackedShowsReady) {
    return {
      announcements: initialFeed([], null),
      trailers: initialFeed([], null),
    }
  }
  const announcements = readAnnouncementsCache(storage, now)
  const trailers = readTrailersCache(storage, now)
  const announcementItems = announcementItemsForTrackedShows(announcements.items, trackedShows)
  const trailerItems = trailerItemsForTrackedShows(trailers.items, trackedShows)
  return {
    announcements: initialFeed(announcementItems, announcements.lastSuccess),
    trailers: initialFeed(trailerItems, trailers.lastSuccess),
  }
}

function beginRefresh(trackedShows, storage) {
  return createInitialDiscoverState({
    trackedShows,
    trackedShowsReady: true,
    storage,
  })
}

function finishRefresh(result, trackedShows, storage, now) {
  const announcementCache = readAnnouncementsCache(storage, now)
  const trailerCache = readTrailersCache(storage, now)
  const dismissedAnnouncementIds = new Set(announcementCache.dismissedIds)
  const dismissedTrailerKeys = new Set(trailerCache.dismissedKeys)
  return {
    announcements: {
      ...result.announcements,
      items: announcementItemsForTrackedShows(
        result.announcements.items.filter((item) => !dismissedAnnouncementIds.has(item.id)),
        trackedShows,
      ),
      loading: false,
      refreshing: false,
    },
    trailers: {
      ...result.trailers,
      items: trailerItemsForTrackedShows(
        result.trailers.items.filter((item) => !dismissedTrailerKeys.has(item.videoKey)),
        trackedShows,
      ),
      loading: false,
      refreshing: false,
    },
  }
}

function AnnouncementCard({ announcement, onDismiss }) {
  const headline = announcement.articleHeadline ?? announcement.headline ?? announcement.detail
  const url = safeExternalUrl(announcement.sourceUrl)
  const LinkSurface = url ? 'a' : 'div'
  const freshness = formatDiscoverFreshness(announcement.publishedAt)
  return (
    <article className="discover-card">
      <LinkSurface
        {...(url ? {
          href: url,
          target: '_blank',
          rel: 'noopener noreferrer',
          'aria-label': `Read ${headline} from ${announcement.sourceName ?? 'source'}`,
        } : {})}
        className="motion-press discover-card__link"
      >
        <ProgressiveImage
          src={artworkUrl(announcement)}
          alt={`${announcement.showName} artwork`}
          fallbackLabel="No artwork"
          className="discover-card__artwork"
        />
        <div className="discover-card__copy">
          <p className="discover-card__identity">{announcement.showName}</p>
          <h3 className="discover-card__title">{headline}</h3>
          <p className="discover-card__meta">
            <span>{announcement.sourceName ?? 'Source'}</span>
            {freshness && <><span aria-hidden="true">&middot;</span><span>{freshness}</span></>}
          </p>
        </div>
      </LinkSurface>
      <button
        type="button"
        onClick={() => onDismiss(announcement.id)}
        aria-label={`Dismiss ${headline}`}
        className="motion-press discover-card__dismiss"
      >
        <span aria-hidden="true">&times;</span>
      </button>
    </article>
  )
}

function TrailerCard({ trailer, onDismiss }) {
  const url = safeExternalUrl(trailer.youtubeUrl)
  const freshness = formatDiscoverFreshness(trailer.publishedAt)
  const release = formatReleaseContext(trailer.releaseDate)
  const franchise = trailer.franchise
    ? trailer.franchise.charAt(0).toUpperCase() + trailer.franchise.slice(1)
    : null
  return (
    <article className="discover-card">
      <a
        href={url ?? undefined}
        target={url ? '_blank' : undefined}
        rel={url ? 'noopener noreferrer' : undefined}
        aria-label={`Play ${trailer.videoName ?? 'trailer'} for ${trailer.title}`}
        className="motion-press discover-card__link"
      >
        <ProgressiveImage
          src={artworkUrl(trailer)}
          alt={`${trailer.title} artwork`}
          fallbackLabel="No artwork"
          className="discover-card__artwork"
        />
        <div className="discover-card__copy">
          <p className="discover-card__identity">{trailer.title}</p>
          <h3 className="discover-card__title">{trailer.videoName ?? 'Official trailer'}</h3>
          {(franchise || release || freshness) && (
            <p className="discover-card__meta">
              {[franchise, release, freshness].filter(Boolean).map((part, index) => (
                <span key={part}>
                  {index > 0 && <span aria-hidden="true"> &middot; </span>}
                  {part}
                </span>
              ))}
            </p>
          )}
          <span className="discover-card__play">Play trailer</span>
        </div>
      </a>
      <button
        type="button"
        onClick={() => onDismiss(trailer.videoKey)}
        aria-label={`Dismiss ${trailer.videoName ?? 'trailer'} for ${trailer.title}`}
        className="motion-press discover-card__dismiss"
      >
        <span aria-hidden="true">&times;</span>
      </button>
    </article>
  )
}

function FeedSkeleton({ label }) {
  return (
    <div aria-label={label} role="status" className="discover-feed__list">
      {[0, 1].map((id) => (
        <div key={id} aria-hidden="true" className="discover-card discover-card--skeleton">
          <span className="discover-card__skeleton-artwork" />
          <span className="discover-card__skeleton-copy" />
        </div>
      ))}
    </div>
  )
}

function FeedState({ feed, name, emptyCopy, children }) {
  const hasItems = feed.items.length > 0
  if (feed.loading && !hasItems) return <FeedSkeleton label={`Loading ${name.toLowerCase()}`} />
  return (
    <>
      {feed.error && hasItems && (
        <p role="status" className="discover-feed__notice">
          Showing saved {name.toLowerCase()}. Couldn&apos;t refresh.
        </p>
      )}
      {feed.error && !hasItems && (
        <p role="alert" className="discover-feed__empty">{name} are unavailable right now.</p>
      )}
      {!feed.error && !hasItems && (
        <p className="discover-feed__empty">{emptyCopy}</p>
      )}
      {hasItems && children}
    </>
  )
}

export function BrowseDiscoverView({
  state,
  hidden = false,
  onDismissAnnouncement = () => {},
  onDismissTrailer = () => {},
}) {
  const announcements = state.announcements.items.slice(0, MAX_VISIBLE_ANNOUNCEMENTS)
  const trailers = state.trailers.items.slice(0, MAX_VISIBLE_TRAILERS)
  return (
    <div hidden={hidden} className="discover-feeds">
      <section aria-labelledby="announcements-heading" className="discover-feed">
        <div className="discover-feed__heading">
          <h2 id="announcements-heading">Announcements</h2>
          {state.announcements.refreshing && announcements.length > 0 && (
            <span aria-live="polite">Updating&hellip;</span>
          )}
        </div>
        <FeedState
          feed={{ ...state.announcements, items: announcements }}
          name="Announcements"
          emptyCopy="No announcements from your shows right now."
        >
          <div className="discover-feed__list">
            {announcements.map((announcement) => (
              <AnnouncementCard
                key={announcement.id}
                announcement={announcement}
                onDismiss={onDismissAnnouncement}
              />
            ))}
          </div>
        </FeedState>
      </section>

      <section aria-labelledby="trailers-heading" className="discover-feed">
        <div className="discover-feed__heading">
          <h2 id="trailers-heading">Trailers</h2>
          {state.trailers.refreshing && trailers.length > 0 && (
            <span aria-live="polite">Updating&hellip;</span>
          )}
        </div>
        <FeedState
          feed={{ ...state.trailers, items: trailers }}
          name="Trailers"
          emptyCopy="No new trailers right now."
        >
          <div className="discover-feed__list">
            {trailers.map((trailer) => (
              <TrailerCard
                key={trailer.videoKey}
                trailer={trailer}
                onDismiss={onDismissTrailer}
              />
            ))}
          </div>
        </FeedState>
      </section>
    </div>
  )
}

export default function BrowseDiscover({
  trackedShows = [],
  trackedShowsReady = true,
  hidden = false,
  storage = globalThis.localStorage,
  loadDiscoverImpl = loadDiscover,
}) {
  const [state, setState] = useState(() => createInitialDiscoverState({
    trackedShows,
    trackedShowsReady,
    storage,
  }))
  const requestRef = useRef(null)
  const trackedShowsKey = useMemo(() => trackedShows
    .map((show) => `${show.tmdb_id ?? show.id}:${show.name ?? show.title ?? ''}`)
    .sort()
    .join('|'), [trackedShows])

  useEffect(() => {
    if (!trackedShowsReady) return undefined
    let cancelled = false
    setState(beginRefresh(trackedShows, storage))

    const requestKey = trackedShowsKey
    let request = requestRef.current?.key === requestKey
      ? requestRef.current.promise
      : null
    if (!request) {
      request = loadDiscoverImpl({ trackedShows, storage })
      requestRef.current = { key: requestKey, promise: request }
    }

    Promise.resolve(request)
      .then((result) => {
        if (!cancelled) {
          setState(finishRefresh(result, trackedShows, storage, Date.now()))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState((current) => ({
            announcements: {
              ...current.announcements,
              loading: false,
              refreshing: false,
              error: 'unavailable',
            },
            trailers: {
              ...current.trailers,
              loading: false,
              refreshing: false,
              error: 'unavailable',
            },
          }))
        }
      })

    return () => {
      cancelled = true
    }
  }, [loadDiscoverImpl, storage, trackedShows, trackedShowsKey, trackedShowsReady])

  function handleDismissAnnouncement(announcementId) {
    writeAnnouncementsCache(
      dismissAnnouncement(readAnnouncementsCache(storage), announcementId),
      storage,
    )
    setState((current) => ({
      ...current,
      announcements: {
        ...current.announcements,
        items: current.announcements.items.filter((item) => item.id !== announcementId),
      },
    }))
  }

  function handleDismissTrailer(videoKey) {
    writeTrailersCache(
      dismissTrailer(readTrailersCache(storage), videoKey),
      storage,
    )
    setState((current) => ({
      ...current,
      trailers: {
        ...current.trailers,
        items: current.trailers.items.filter((item) => item.videoKey !== videoKey),
      },
    }))
  }

  return (
    <BrowseDiscoverView
      state={trackedShowsReady
        ? state
        : createInitialDiscoverState({ trackedShowsReady: false })}
      hidden={hidden}
      onDismissAnnouncement={handleDismissAnnouncement}
      onDismissTrailer={handleDismissTrailer}
    />
  )
}
