export const DATA_TIMEOUT_MS = 12_000

export class DataLoadError extends Error {
  constructor(message, { code = 'DATA-UNKNOWN', stage = 'unknown', source = 'unknown', cause } = {}) {
    super(message, { cause })
    this.name = 'DataLoadError'
    this.code = code
    this.stage = stage
    this.source = source
  }
}

export function classifyDataError(error, source = 'unknown') {
  if (error instanceof DataLoadError) return error.code
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'DATA-TIMEOUT'
  if (source === 'tmdb' || /TMDB request failed/i.test(error?.message ?? '')) return 'DATA-TMDB'
  if (source === 'tvmaze') return 'DATA-TVMAZE'
  if (source === 'storage' || /localStorage|quota|storage/i.test(error?.message ?? '')) return 'DATA-STORAGE'
  if (
    source === 'supabase'
    || typeof error?.status === 'number'
    || typeof error?.code === 'string' && (/^PGRST/.test(error.code) || /^[0-9A-Z]{5}$/.test(error.code))
  ) return 'DATA-SUPABASE'
  if (error instanceof TypeError) return 'DATA-NETWORK'
  return 'DATA-UNKNOWN'
}

export function safeDataDiagnostic(error, { stage = 'unknown', source = 'unknown' } = {}) {
  return {
    code: classifyDataError(error, source),
    stage,
    name: typeof error?.name === 'string' ? error.name : 'Error',
    status: typeof error?.status === 'number' ? error.status : undefined,
  }
}

export function reportDataError(error, context) {
  const diagnostic = safeDataDiagnostic(error, context)
  if (import.meta.env.DEV) console.warn('[data-load]', diagnostic)
  return diagnostic
}

export async function withTimeout(operation, {
  timeoutMs = DATA_TIMEOUT_MS,
  stage = 'unknown',
  source = 'unknown',
  AbortControllerImpl = globalThis.AbortController,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  const controller = typeof AbortControllerImpl === 'function' ? new AbortControllerImpl() : null
  let timer
  let settled = false
  const work = Promise.resolve().then(() => operation(controller?.signal))
  const guardedWork = work.catch((error) => {
    if (settled) return undefined
    throw error
  })
  const timeout = new Promise((_, reject) => {
    timer = setTimeoutImpl(() => {
      controller?.abort()
      reject(new DataLoadError(`Data load timed out at ${stage}`, {
        code: 'DATA-TIMEOUT', stage, source,
      }))
    }, timeoutMs)
  })

  try {
    return await Promise.race([guardedWork, timeout])
  } catch (error) {
    if (error instanceof DataLoadError) throw error
    throw new DataLoadError(`Data load failed at ${stage}`, {
      code: classifyDataError(error, source), stage, source, cause: error,
    })
  } finally {
    settled = true
    clearTimeoutImpl(timer)
  }
}
