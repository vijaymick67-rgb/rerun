import { describe, it, expect } from 'vitest'
import {
  FRANCHISE_CATALOGUE_CACHE_KEY, FRANCHISE_CATALOGUE_SCHEMA, FRANCHISE_CATALOGUE_TTL_MS,
  MAX_CACHED_ITEMS, catalogueConfigKey, readFranchiseCatalogue, writeFranchiseCatalogue,
} from './franchiseCatalogueStore.js'

const NOW = Date.parse('2026-07-23T00:00:00.000Z')

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    _raw: (k) => store.get(k),
  }
}

const MEDIA = [{ mediaType: 'movie', mediaId: 1, title: 'A', franchise: 'marvel' }]

describe('catalogueConfigKey', () => {
  it('is deterministic regardless of seed order', () => {
    expect(catalogueConfigKey({ seedCompanyIds: [420, 128064] }))
      .toBe(catalogueConfigKey({ seedCompanyIds: [128064, 420] }))
  })

  it('changes when the seed set changes', () => {
    expect(catalogueConfigKey({ seedCompanyIds: [420] }))
      .not.toBe(catalogueConfigKey({ seedCompanyIds: [420, 128064] }))
  })
})

describe('read/write franchise catalogue cache (Part 8)', () => {
  it('reads back a fresh entry within TTL with the same config', () => {
    const storage = memoryStorage()
    const key = catalogueConfigKey({ seedCompanyIds: [420] })
    writeFranchiseCatalogue({ media: MEDIA }, storage, NOW, { configKey: key })
    const read = readFranchiseCatalogue(storage, NOW, { configKey: key })
    expect(read.fresh).toBe(true)
    expect(read.stale).toBe(false)
    expect(read.media).toEqual(MEDIA)
  })

  it('marks an expired entry stale (still returned for SWR display)', () => {
    const storage = memoryStorage()
    const key = catalogueConfigKey({ seedCompanyIds: [420] })
    writeFranchiseCatalogue({ media: MEDIA }, storage, NOW, { configKey: key })
    const read = readFranchiseCatalogue(storage, NOW + FRANCHISE_CATALOGUE_TTL_MS + 1, { configKey: key })
    expect(read.fresh).toBe(false)
    expect(read.stale).toBe(true)
    expect(read.media).toEqual(MEDIA) // still usable
  })

  it('invalidates (stale) when the seed configuration changes', () => {
    const storage = memoryStorage()
    writeFranchiseCatalogue({ media: MEDIA }, storage, NOW, { configKey: catalogueConfigKey({ seedCompanyIds: [420] }) })
    const read = readFranchiseCatalogue(storage, NOW, { configKey: catalogueConfigKey({ seedCompanyIds: [420, 128064] }) })
    expect(read.fresh).toBe(false)
    expect(read.stale).toBe(true)
  })

  it('resets safely on corrupt JSON', () => {
    const storage = memoryStorage({ [FRANCHISE_CATALOGUE_CACHE_KEY]: '{not json' })
    expect(readFranchiseCatalogue(storage, NOW)).toBe(null)
  })

  it('resets on a wrong/old schema', () => {
    const storage = memoryStorage({
      [FRANCHISE_CATALOGUE_CACHE_KEY]: JSON.stringify({ schema: FRANCHISE_CATALOGUE_SCHEMA + 99, cachedAt: NOW, media: MEDIA }),
    })
    expect(readFranchiseCatalogue(storage, NOW)).toBe(null)
  })

  it('bounds the cached item count', () => {
    const storage = memoryStorage()
    const many = Array.from({ length: MAX_CACHED_ITEMS + 50 }, (_, i) => ({ mediaType: 'movie', mediaId: i, title: `M${i}`, franchise: 'marvel' }))
    writeFranchiseCatalogue({ media: many }, storage, NOW)
    const read = readFranchiseCatalogue(storage, NOW)
    expect(read.media.length).toBe(MAX_CACHED_ITEMS)
  })
})
