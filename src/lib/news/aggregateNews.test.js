import { describe, expect, it } from 'vitest'
import { aggregateProviders } from './aggregateNews.js'
import { createNewsProvider, NewsProviderError } from './provider.js'

function okProvider(name, articles) {
  return createNewsProvider({ name, async fetchArticles() { return articles } })
}

function failingProvider(name, code = 'NETWORK_ERROR') {
  return createNewsProvider({
    name,
    async fetchArticles() { throw new NewsProviderError(code, 'boom') },
  })
}

describe('provider aggregation', () => {
  it('merges results from every successful provider in order', async () => {
    const result = await aggregateProviders([
      okProvider('TVLine', [{ id: 1 }]),
      okProvider('Deadline', [{ id: 2 }, { id: 3 }]),
    ])

    expect(result.providersUsed).toEqual(['TVLine', 'Deadline'])
    expect(result.failureCount).toBe(0)
    expect(result.results.map((r) => r.articles.flat())).toEqual([[{ id: 1 }], [{ id: 2 }, { id: 3 }]])
  })

  it('isolates one failing provider without losing the others', async () => {
    const result = await aggregateProviders([
      okProvider('TVLine', [{ id: 1 }]),
      failingProvider('Deadline'),
      okProvider('GoodSource', [{ id: 2 }]),
    ])

    expect(result.providersUsed).toEqual(['TVLine', 'GoodSource'])
    expect(result.failureCount).toBe(1)
    const failed = result.results.find((r) => r.name === 'Deadline')
    expect(failed.ok).toBe(false)
    expect(failed.error).toBeInstanceOf(NewsProviderError)
  })

  it('reports total failure when every provider fails, without throwing', async () => {
    const result = await aggregateProviders([failingProvider('A'), failingProvider('B')])

    expect(result.providersUsed).toEqual([])
    expect(result.failureCount).toBe(2)
  })

  it('never produces an unhandled rejection even with many failing providers', async () => {
    const providers = Array.from({ length: 5 }, (_, i) => failingProvider(`P${i}`))
    await expect(aggregateProviders(providers)).resolves.toBeDefined()
  })

  it('forwards a shared limit to every provider call', async () => {
    const seen = []
    const provider = createNewsProvider({
      name: 'X',
      async fetchArticles({ limit } = {}) { seen.push(limit); return [] },
    })

    await aggregateProviders([provider], { limit: 5 })
    expect(seen).toEqual([5])
  })
})
