import { mergeNews, readNewsCache, writeNewsCache } from './newsStore.js'

export const NEWS_REFRESH_MS = 30 * 60 * 1000

export function createNewsClient() {
  let request = null
  let lastAttemptAt = null
  return {
    load({ trackedShows = [], storage = globalThis.localStorage, fetchImpl = globalThis.fetch,
      now = Date.now(), force = false } = {}) {
      const cached = readNewsCache(storage)
      const fresh = cached.lastSuccess !== null && now - cached.lastSuccess < NEWS_REFRESH_MS
      // An attempt (successful or failed) is not retried automatically until a full
      // refresh window has passed since it was made - this is what stops a failing
      // endpoint from being hit again on every unrelated re-render or remount. Unlike
      // a one-time "have we ever tried" latch, this cools down rather than latching
      // forever: once the window elapses, an automatic refresh is allowed again even
      // if the very first attempt never succeeded, or the cache has simply gone stale
      // since a success that happened long ago in the same session.
      const onCooldown = lastAttemptAt !== null && now - lastAttemptAt < NEWS_REFRESH_MS
      if (request) return { cached, refresh: request }
      if (!force && (fresh || onCooldown)) return { cached, refresh: null }
      lastAttemptAt = now
      request = Promise.resolve().then(() => fetchImpl('/api/news?limit=10', { headers: { Accept: 'application/json' } }))
        .then(async (response) => {
          if (!response?.ok) throw new Error('news unavailable')
          const payload = await response.json()
          const next = mergeNews(readNewsCache(storage), payload?.articles, trackedShows, now)
          return writeNewsCache(next, storage)
        }).finally(() => { request = null })
      return { cached, refresh: request }
    },
  }
}

export const newsClient = createNewsClient()
