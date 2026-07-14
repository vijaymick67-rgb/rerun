import { createNewsProvider, NewsProviderError } from './provider.js'

const GNEWS_ENDPOINT = 'https://gnews.io/api/v4/search'
const DEFAULT_TIMEOUT_MS = 8000
const GNEWS_MAX_ARTICLES = 10
const TV_NEWS_QUERY = '"TV series" OR television OR "season 2" OR renewed OR cancelled OR showrunner -movie -sports -music -gossip'

async function readJsonResponse(response) {
  const body = await response.text()
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new NewsProviderError('MALFORMED_RESPONSE', 'The news provider returned malformed data', error)
  }
}

function safeDiagnostic(value, apiKey) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  let text = String(value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500)
  if (!text) return null
  if (apiKey) text = text.split(apiKey).join('[REDACTED]')
  return text.replace(/https?:\/\/\S+/gi, '[REDACTED_URL]')
}

function upstreamDiagnostics(response, payload, apiKey) {
  const providerError = payload?.error
  const code = providerError && typeof providerError === 'object'
    ? providerError.code
    : payload?.code
  const message = providerError && typeof providerError === 'object'
    ? providerError.message
    : providerError ?? payload?.message ?? payload?.errors?.[0]
  return {
    status: Number.isInteger(response?.status) ? response.status : null,
    code: safeDiagnostic(code, apiKey),
    message: safeDiagnostic(message, apiKey),
  }
}

export function createGnewsProvider({
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return createNewsProvider({
    name: 'gnews',
    async fetchArticles({ limit = GNEWS_MAX_ARTICLES } = {}) {
      if (!apiKey) {
        throw new NewsProviderError('MISSING_API_KEY', 'The news provider is not configured')
      }
      if (typeof fetchImpl !== 'function') {
        throw new NewsProviderError('FETCH_UNAVAILABLE', 'The news provider is unavailable')
      }

      const url = new URL(GNEWS_ENDPOINT)
      url.searchParams.set('q', TV_NEWS_QUERY)
      url.searchParams.set('lang', 'en')
      url.searchParams.set('sortby', 'publishedAt')
      url.searchParams.set('max', String(Math.min(GNEWS_MAX_ARTICLES, Math.max(1, limit))))
      url.searchParams.set('apikey', apiKey)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new NewsProviderError('TIMEOUT', 'The news provider timed out', error)
        }
        throw new NewsProviderError('NETWORK_ERROR', 'The news provider could not be reached', error)
      } finally {
        clearTimeout(timer)
      }

      const payload = await readJsonResponse(response)
      if (!response.ok) {
        throw new NewsProviderError(
          'UPSTREAM_ERROR',
          'The news provider returned an error',
          payload,
          upstreamDiagnostics(response, payload, apiKey),
        )
      }
      if (!Array.isArray(payload?.articles)) {
        throw new NewsProviderError('MALFORMED_RESPONSE', 'The news provider returned malformed data')
      }

      return payload.articles
    },
  })
}

export {
  DEFAULT_TIMEOUT_MS, GNEWS_ENDPOINT, GNEWS_MAX_ARTICLES, TV_NEWS_QUERY, upstreamDiagnostics,
}
