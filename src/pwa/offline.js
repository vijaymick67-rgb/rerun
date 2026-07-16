export function retryOffline(onRetry = () => globalThis.location?.reload()) {
  return onRetry()
}
