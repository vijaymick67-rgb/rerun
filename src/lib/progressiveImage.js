export function getImageStatus({ src, complete, naturalWidth }) {
  if (!src) return 'error'
  if (!complete) return 'loading'
  return naturalWidth > 0 ? 'loaded' : 'error'
}

export function reduceImageStatus(eventType, naturalWidth = 0) {
  if (eventType === 'load') return naturalWidth > 0 ? 'loaded' : 'error'
  if (eventType === 'error') return 'error'
  return 'loading'
}
