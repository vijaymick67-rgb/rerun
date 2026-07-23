import { describe, it, expect, vi } from 'vitest'
import {
  createPlanStore, createMemoryPlanStore, createKvRestPlanStore,
  PLAN_STORE_TTL_MS, PLAN_STORE_MAX_ENTRIES,
} from './announcementPlanStore.js'

describe('memory plan store (best-effort fallback)', () => {
  it('round-trips a stored plan by id', async () => {
    const store = createMemoryPlanStore()
    await store.set('id1', { c: ['From'], a: [] })
    expect(await store.get('id1')).toEqual({ c: ['From'], a: [] })
  })

  it('returns null for a missing / forged id', async () => {
    const store = createMemoryPlanStore()
    expect(await store.get('nope')).toBe(null)
  })

  it('expires an entry past the TTL', async () => {
    let now = 1000
    const store = createMemoryPlanStore({ ttlMs: 100, now: () => now })
    await store.set('id', { c: [], a: [] })
    expect(await store.get('id')).toBeTruthy()
    now += 101
    expect(await store.get('id')).toBe(null)
  })

  it('bounds storage, evicting the oldest entry past the cap', async () => {
    const store = createMemoryPlanStore({ max: 2 })
    await store.set('a', { c: ['a'], a: [] })
    await store.set('b', { c: ['b'], a: [] })
    await store.set('c', { c: ['c'], a: [] }) // evicts 'a'
    expect(await store.get('a')).toBe(null)
    expect(await store.get('b')).toBeTruthy()
    expect(await store.get('c')).toBeTruthy()
  })
})

describe('KV REST plan store (durable backend)', () => {
  it('SET posts the JSON value with an EX ttl and the bearer token; GET parses { result }', async () => {
    const calls = []
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url: String(url), options })
      if (String(url).includes('/set/')) return { ok: true, json: async () => ({ result: 'OK' }) }
      return { ok: true, json: async () => ({ result: JSON.stringify({ c: ['From'], a: [] }) }) }
    })
    const store = createKvRestPlanStore({ url: 'https://kv.example', token: 'secret', fetchImpl, ttlMs: 60_000 })
    await store.set('id1', { c: ['From'], a: [] })
    const setCall = calls.find((c) => c.url.includes('/set/'))
    expect(setCall.url).toContain('EX=60')
    expect(setCall.options.method).toBe('POST')
    expect(setCall.options.headers.Authorization).toBe('Bearer secret')
    expect(JSON.parse(setCall.options.body)).toEqual({ c: ['From'], a: [] })

    const value = await store.get('id1')
    expect(value).toEqual({ c: ['From'], a: [] })
  })

  it('GET returns null on a missing key (result:null) or a non-ok response', async () => {
    const missing = createKvRestPlanStore({ url: 'https://kv.example', token: 't', fetchImpl: async () => ({ ok: true, json: async () => ({ result: null }) }) })
    expect(await missing.get('x')).toBe(null)
    const errored = createKvRestPlanStore({ url: 'https://kv.example', token: 't', fetchImpl: async () => ({ ok: false, json: async () => ({}) }) })
    expect(await errored.get('x')).toBe(null)
  })

  it('a network throw is swallowed (get -> null, set -> no-op) rather than crashing', async () => {
    const store = createKvRestPlanStore({ url: 'https://kv.example', token: 't', fetchImpl: async () => { throw new Error('down') } })
    expect(await store.get('x')).toBe(null)
    await expect(store.set('x', { c: [], a: [] })).resolves.toBeUndefined()
  })
})

describe('createPlanStore backend selection', () => {
  it('uses the in-memory fallback when no KV env is configured', () => {
    expect(createPlanStore({ env: {} }).backend).toBe('memory')
  })

  it('uses the durable KV REST backend when Vercel KV env vars are present', () => {
    const store = createPlanStore({ env: { KV_REST_API_URL: 'https://kv', KV_REST_API_TOKEN: 't' } })
    expect(store.backend).toBe('kv-rest')
  })

  it('uses the durable KV REST backend when Upstash env vars are present', () => {
    const store = createPlanStore({ env: { UPSTASH_REDIS_REST_URL: 'https://up', UPSTASH_REDIS_REST_TOKEN: 't' } })
    expect(store.backend).toBe('kv-rest')
  })

  it('exposes sane bounds', () => {
    expect(PLAN_STORE_TTL_MS).toBeGreaterThan(0)
    expect(PLAN_STORE_MAX_ENTRIES).toBeGreaterThan(0)
  })
})
