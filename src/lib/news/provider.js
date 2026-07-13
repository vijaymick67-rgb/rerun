export class NewsProviderError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'NewsProviderError'
    this.code = code
    this.cause = cause
  }
}

export function createNewsProvider({ name, fetchArticles }) {
  if (!name || typeof fetchArticles !== 'function') {
    throw new TypeError('A provider name and fetchArticles function are required')
  }

  return { name, fetchArticles }
}

export function isNewsProviderError(error) {
  return error instanceof NewsProviderError
}
