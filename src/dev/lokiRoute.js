export const LOKI_PROTOTYPE_PATH = '/dev/loki'

export function isLokiPrototypePath(pathname, isDevelopment = import.meta.env.DEV) {
  if (!isDevelopment) return false
  return pathname === LOKI_PROTOTYPE_PATH || pathname === `${LOKI_PROTOTYPE_PATH}/`
}
