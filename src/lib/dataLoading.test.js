import { describe, expect, it, vi } from 'vitest'
import {
  classifyDataError,
  safeDataDiagnostic,
  withTimeout,
} from './dataLoading.js'

describe('portable data loading', () => {
  it('times out a permanently pending request and cleans its timer', async () => {
    vi.useFakeTimers()
    const clearTimeoutImpl = vi.fn(clearTimeout)
    const pending = withTimeout(() => new Promise(() => {}), {
      timeoutMs: 50,
      stage: 'test-pending',
      setTimeoutImpl: setTimeout,
      clearTimeoutImpl,
    })
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'DATA-TIMEOUT',
      stage: 'test-pending',
    })
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    expect(clearTimeoutImpl).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('cleans its timer after success', async () => {
    const clearTimeoutImpl = vi.fn(clearTimeout)
    await expect(withTimeout(() => Promise.resolve('ok'), { clearTimeoutImpl })).resolves.toBe('ok')
    expect(clearTimeoutImpl).toHaveBeenCalledOnce()
  })

  it('works without AbortController or AbortSignal.timeout', async () => {
    vi.useFakeTimers()
    const pending = withTimeout(() => new Promise(() => {}), {
      timeoutMs: 25,
      AbortControllerImpl: undefined,
    })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'DATA-TIMEOUT' })
    await vi.advanceTimersByTimeAsync(25)
    await assertion
    vi.useRealTimers()
  })

  it('classifies network, Supabase, TMDB, TVmaze, and storage failures', () => {
    expect(classifyDataError(new TypeError('Load failed'))).toBe('DATA-NETWORK')
    expect(classifyDataError({ code: 'PGRST116', message: 'row error' })).toBe('DATA-SUPABASE')
    expect(classifyDataError(new Error('TMDB request failed: 503'))).toBe('DATA-TMDB')
    expect(classifyDataError(new Error('unavailable'), 'tvmaze')).toBe('DATA-TVMAZE')
    expect(classifyDataError(new Error('localStorage quota exceeded'))).toBe('DATA-STORAGE')
  })

  it('produces non-sensitive diagnostics', () => {
    const diagnostic = safeDataDiagnostic({
      name: 'PostgrestError',
      status: 401,
      message: 'Authorization: Bearer secret watched_history=private',
      url: 'https://example.supabase.co/rest/v1/watched_episodes?apikey=secret',
    }, { stage: 'stats-watched-episodes', source: 'supabase' })
    expect(diagnostic).toEqual({
      code: 'DATA-SUPABASE',
      stage: 'stats-watched-episodes',
      name: 'PostgrestError',
      status: 401,
    })
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|watched_history|apikey|Authorization/)
  })
})
