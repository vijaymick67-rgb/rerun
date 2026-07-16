// Every provider call is caught here, so a rejected promise never escapes —
// Promise.all below can never reject because of a single bad provider. The raw
// error is kept (not just a code) so callers can log the same safe, redacted
// diagnostics they would have for a single-provider failure.
async function runProviderSafely(provider, options) {
  try {
    const articles = await provider.fetchArticles(options)
    return { name: provider.name, ok: true, articles: Array.isArray(articles) ? articles : [] }
  } catch (error) {
    return { name: provider.name, ok: false, articles: [], error }
  }
}

// Runs every provider in parallel (bounded by however many providers the caller
// passes in — callers are responsible for keeping that list small and fixed),
// in deterministic (array) order, and never lets one failure blank the rest.
// `limit` is forwarded to every provider's fetchArticles — a curated RSS provider
// ignores it (its per-source cap is fixed at creation time); GNews uses it to
// avoid over-fetching when the caller asked for fewer than its max.
export async function aggregateProviders(providers, { limit } = {}) {
  const results = await Promise.all(providers.map((provider) => runProviderSafely(provider, { limit })))
  const providersUsed = results.filter((result) => result.ok).map((result) => result.name)
  const failureCount = results.filter((result) => !result.ok).length
  return { results, providersUsed, failureCount }
}
