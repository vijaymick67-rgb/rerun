import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getImageStatus, reduceImageStatus } from '../lib/progressiveImage'

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export default function ProgressiveImage({
  src,
  alt,
  className = '',
  fallbackLabel = 'No image',
  loading = 'lazy',
  fetchPriority,
}) {
  const imageRef = useRef(null)
  const mountedRef = useRef(true)
  const [imageState, setImageState] = useState(() => ({
    src,
    status: getImageStatus({ src, complete: false, naturalWidth: 0 }),
  }))
  const status = imageState.src === src
    ? imageState.status
    : getImageStatus({ src, complete: false, naturalWidth: 0 })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useIsomorphicLayoutEffect(() => {
    let active = true
    const nextStatus = !src
      ? 'error'
      : getImageStatus({
          src,
          complete: imageRef.current?.complete ?? false,
          naturalWidth: imageRef.current?.naturalWidth ?? 0,
        })

    if (active) {
      setImageState({ src, status: nextStatus })
    }

    return () => {
      active = false
    }
  }, [src])

  function setStatus(nextStatus) {
    if (!mountedRef.current) return
    setImageState((current) => (
      current.src === src ? { src, status: nextStatus } : current
    ))
  }

  const isError = status === 'error'
  const wrapperClass = [
    'progressive-image',
    `progressive-image--${status}`,
    className,
  ].filter(Boolean).join(' ')

  return (
    <span
      className={wrapperClass}
      role={isError ? 'img' : undefined}
      aria-label={isError ? (alt || fallbackLabel) : undefined}
    >
      <span className="progressive-image__placeholder" aria-hidden="true" />
      {!isError && src && (
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          loading={loading}
          decoding="async"
          fetchPriority={fetchPriority}
          className="progressive-image__img"
          onLoad={(event) => setStatus(reduceImageStatus('load', event.currentTarget.naturalWidth))}
          onError={() => setStatus(reduceImageStatus('error'))}
        />
      )}
      {isError && (
        <span className="progressive-image__fallback" aria-hidden="true">
          {fallbackLabel}
        </span>
      )}
    </span>
  )
}
