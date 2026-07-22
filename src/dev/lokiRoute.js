export const LOKI_PROTOTYPE_PATH = '/dev/loki'

export function isLokiPrototypePath(pathname) {
  return pathname === LOKI_PROTOTYPE_PATH || pathname === `${LOKI_PROTOTYPE_PATH}/`
}
