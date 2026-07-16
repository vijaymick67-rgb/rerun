import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import {
  createBoundedScrollRestorer,
  flushPendingScrollPosition,
  getScrollNavigationAction,
  getScrollRouteKey,
} from '../lib/scrollRestoration'

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export default function ScrollRestorationManager() {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()
  const positionsRef = useRef(new Map())
  const previousPathnameRef = useRef(pathname)
  const currentRouteKeyRef = useRef(getScrollRouteKey(pathname))
  const initialRef = useRef(true)
  const captureFrameRef = useRef(null)
  const captureFrameKeyRef = useRef(null)
  const pendingPositionsRef = useRef(new Map())
  const cancelRestoreRef = useRef(null)
  const programmaticScrollRef = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleScroll = () => {
      if (programmaticScrollRef.current) return

      const routeKey = currentRouteKeyRef.current
      pendingPositionsRef.current.set(routeKey, window.scrollY)
      if (captureFrameRef.current !== null) return

      captureFrameRef.current = window.requestAnimationFrame(() => {
        captureFrameRef.current = null
        const pendingRouteKey = captureFrameKeyRef.current
        captureFrameKeyRef.current = null
        const pendingPosition = pendingPositionsRef.current.get(pendingRouteKey)
        if (pendingPosition !== undefined) {
          positionsRef.current.set(pendingRouteKey, pendingPosition)
          pendingPositionsRef.current.delete(pendingRouteKey)
        }
      })
      captureFrameKeyRef.current = routeKey
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (captureFrameRef.current !== null) {
        window.cancelAnimationFrame(captureFrameRef.current)
      }
    }
  }, [])

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined

    if (captureFrameRef.current !== null) {
      window.cancelAnimationFrame(captureFrameRef.current)
      captureFrameRef.current = null
      captureFrameKeyRef.current = null
    }

    const previousPathname = previousPathnameRef.current
    const isInitial = initialRef.current
    if (previousPathname !== pathname) {
      const previousRouteKey = getScrollRouteKey(previousPathname)
      flushPendingScrollPosition(
        positionsRef.current,
        pendingPositionsRef.current,
        previousRouteKey,
      )
    }

    const action = getScrollNavigationAction({
      isInitial,
      navigationType,
      previousPathname,
      pathname,
    })

    previousPathnameRef.current = pathname
    currentRouteKeyRef.current = action.key
    initialRef.current = false

    cancelRestoreRef.current?.()
    cancelRestoreRef.current = null
    programmaticScrollRef.current = false

    const target = action.type === 'restore'
      ? positionsRef.current.get(action.key) ?? 0
      : 0

    if (target <= 0) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      return undefined
    }

    let restorationFrame = null
    let cancelRestorer = null
    let active = true
    const handleUserInput = () => {
      cleanup()
    }
    const handleKeyDown = (event) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
        handleUserInput()
      }
    }

    const cleanup = () => {
      if (!active) return
      active = false
      cancelRestorer?.()
      window.removeEventListener('wheel', handleUserInput)
      window.removeEventListener('touchstart', handleUserInput)
      window.removeEventListener('pointerdown', handleUserInput)
      window.removeEventListener('keydown', handleKeyDown)
      if (restorationFrame !== null) window.cancelAnimationFrame(restorationFrame)
      programmaticScrollRef.current = false
    }

    window.addEventListener('wheel', handleUserInput, { passive: true })
    window.addEventListener('touchstart', handleUserInput, { passive: true })
    window.addEventListener('pointerdown', handleUserInput, { passive: true })
    window.addEventListener('keydown', handleKeyDown)
    cancelRestorer = createBoundedScrollRestorer({
      target,
      getMaxScroll: () => document.documentElement.scrollHeight - window.innerHeight,
      scrollTo: (position) => {
        programmaticScrollRef.current = true
        window.scrollTo({ top: position, left: 0, behavior: 'auto' })
      },
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancelSchedule: (timerId) => window.clearTimeout(timerId),
      onFinish: () => {
        restorationFrame = window.requestAnimationFrame(() => {
          programmaticScrollRef.current = false
          restorationFrame = null
        })
      },
    })
    cancelRestoreRef.current = cleanup

    return cleanup
  }, [navigationType, pathname])

  return null
}
