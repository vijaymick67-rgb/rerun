import { mergeNews, readNewsCache, writeNewsCache } from './newsStore.js'

export const NEWS_REFRESH_MS = 30 * 60 * 1000

export function createNewsClient() {
  let request = null
  let attempted = false
  return {
    load({ trackedShows = [], storage = globalThis.localStorage, fetchImpl = globalThis.fetch,
      now = Date.now(), force = false } = {}) {
      const cached = readNewsCache(storage)
      const fresh = cached.lastSuccess !== null && now - cached.lastSuccess < NEWS_REFRESH_MS
      if (request) return { cached, refresh: request }
      if (!force && (fresh || attempted)) return { cached, refresh: null }
      attempted = true
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
