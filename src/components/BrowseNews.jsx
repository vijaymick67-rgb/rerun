import { useEffect, useMemo, useState } from 'react'
import { newsClient } from '../lib/news/client.js'
import {
  dismissMyShowsArticle, mergeNews, readNewsCache, selectGeneralNews,
  visibleMyShowsArticles, writeNewsCache,
} from '../lib/news/newsStore.js'
import { formatRelativeTime } from '../lib/news/relativeTime.js'

function NewsImage({ article }) {
  const [failed, setFailed] = useState(false)
  return article.imageUrl && !failed ? (
    <img src={article.imageUrl} alt="" onError={() => setFailed(true)}
      className="h-18 w-22 shrink-0 rounded-md object-cover" loading="lazy" />
  ) : (
    <div data-news-image-fallback="true" aria-hidden="true"
      className="flex h-18 w-22 shrink-0 items-center justify-center rounded-md bg-(--color-surface-raised) text-[10px] font-medium uppercase tracking-wide text-(--color-text-muted)">
      TV news
    </div>
  )
}

export function NewsStoryCard({ article, onDismiss }) {
  return (
    <article className="content-surface relative min-w-0">
      <a href={article.url} target="_blank" rel="noopener noreferrer"
        aria-label={`Read ${article.title} from ${article.sourceName}`}
        className={`motion-press flex min-w-0 gap-3 rounded-lg p-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent) ${onDismiss ? 'pr-13' : ''}`}>
        <NewsImage article={article} />
        <div className="min-w-0 self-center">
          {article.matchedShowName && <p className="truncate text-[11px] font-medium text-(--color-accent)">{article.matchedShowName}</p>}
          <h3 className="line-clamp-3 break-words text-sm font-medium leading-5 text-(--color-text)">{article.title}</h3>
          <p className="mt-1 truncate text-xs text-(--color-text-muted)">
            {article.sourceName} · {formatRelativeTime(article.publishedAt)}
          </p>
        </div>
      </a>
      {onDismiss && (
        <button type="button" aria-label={`Dismiss ${article.title}`}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onDismiss(article.id) }}
          className="motion-press absolute right-1 top-1 min-h-11 min-w-11 rounded-md text-lg leading-none text-(--color-text-muted) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--color-accent)">
          ×
        </button>
      )}
    </article>
  )
}

function NewsSkeleton() {
  return <div aria-label="Loading TV news" className="space-y-2">
    {[0, 1].map((id) => <div key={id} className="h-22 animate-pulse rounded-lg bg-(--color-surface)" />)}
  </div>
}

export function BrowseNewsView({ state, trackedShows = [], loading = false, error = false,
  refreshing = false, onDismiss = () => {}, onRetry = () => {} }) {
  const mine = visibleMyShowsArticles(state).slice(0, 10)
  const general = selectGeneralNews(state, trackedShows).slice(0, 6)
  const hasUsableCache = mine.length > 0 || general.length > 0
  return (
    <section aria-label="Discover news" className="mt-6 min-w-0">
      {loading && !hasUsableCache ? <NewsSkeleton /> : <>
        {error && !hasUsableCache && <div className="mt-3 rounded-lg bg-(--color-surface) p-3 text-sm text-(--color-text-muted)">
          News is temporarily unavailable. <button type="button" onClick={onRetry}
            className="motion-press min-h-11 font-medium text-(--color-accent)">Retry</button>
        </div>}
        {error && hasUsableCache && <p role="status" className="mt-3 text-xs text-(--color-text-muted)">
          Showing saved stories — refresh failed. <button type="button" onClick={onRetry}
            className="motion-press min-h-11 font-medium text-(--color-accent)">Retry</button>
        </p>}
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold text-(--color-text)">Latest from your shows</h2>
            <span aria-live="polite" className="text-xs text-(--color-text-muted)">{refreshing ? 'Refreshing…' : ''}</span>
          </div>
          {mine.length ? <div className="mt-2 space-y-2">{mine.map((article) =>
            <NewsStoryCard key={article.id} article={article} onDismiss={onDismiss} />)}</div>
            : <p className="mt-2 text-sm text-(--color-text-muted)">No new updates from your shows.</p>}
        </div>
        <div className="mt-6">
          <h2 className="text-base font-semibold text-(--color-text)">TV headlines</h2>
          {general.length ? <div className="mt-2 space-y-2">{general.map((article) =>
            <NewsStoryCard key={article.id} article={article} />)}</div>
            : <p className="mt-2 text-sm text-(--color-text-muted)">No TV news available right now.</p>}
        </div>
      </>}
    </section>
  )
}

export default function BrowseNews({ trackedShows = [], trackedShowsReady = true }) {
  const [state, setState] = useState(() => readNewsCache())
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  // Includes name, not just tmdb_id, so a rename (same show, same session, no id change)
  // still triggers the reclassification merge below — otherwise a renamed show's already-
  // matched articles would keep displaying the old matchedShowName indefinitely.
  const trackedKey = useMemo(
    () => trackedShows.map((show) => `${show.tmdb_id}:${show.name}`).join('|'),
    [trackedShows],
  )

  function refresh(force = false) {
    const { cached, refresh: pending } = newsClient.load({ trackedShows, force })
    setState(cached)
    if (!pending) return
    setLoading(Object.keys(cached.articles).length === 0)
    setRefreshing(Object.keys(cached.articles).length > 0)
    setError(false)
    pending.then(setState).catch(() => setError(true)).finally(() => { setLoading(false); setRefreshing(false) })
  }

  useEffect(() => {
    if (!trackedShowsReady) return
    setState((current) => writeNewsCache(mergeNews(
      current, Object.values(current.articles), trackedShows, current.lastSuccess,
    )))
    refresh(false)
  }, [trackedKey, trackedShowsReady]) // eslint-disable-line react-hooks/exhaustive-deps

  function dismiss(id) {
    setState((current) => writeNewsCache(dismissMyShowsArticle(current, id)))
  }

  return <BrowseNewsView state={state} trackedShows={trackedShows} loading={loading}
    refreshing={refreshing} error={error} onDismiss={dismiss} onRetry={() => refresh(true)} />
}
