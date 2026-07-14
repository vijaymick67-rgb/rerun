import { RELEASE_PLATFORMS } from './releasePlatforms.js'

export const RELEASE_HOUR_IST = RELEASE_PLATFORMS.unknown.thresholdHourIST
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidISODate(value) {
  if (!ISO_DATE_RE.test(value ?? '')) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function timestampFromISTDate(istDate, hour = RELEASE_HOUR_IST, minute = 0) {
  if (
    !isValidISODate(istDate) ||
    !Number.isInteger(hour) || hour < 0 || hour > 23 ||
    !Number.isInteger(minute) || minute < 0 || minute > 59
  ) return null
  const [year, month, day] = istDate.split('-').map(Number)
  return Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MS
}

export function releaseTimestamp(airDate) {
  return timestampFromISTDate(airDate)
}

export function releaseDateInIST(airDate) {
  return isValidISODate(airDate) ? airDate : null
}

export function istDateISO(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function timeLabel(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function instantToISTParts(value) {
  const timestamp = coerceInstant(value)
  if (timestamp === null) return null
  const shifted = new Date(timestamp + IST_OFFSET_MS)
  return {
    timestamp,
    istDate: istDateISO(new Date(timestamp)),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

function normalizedOverride(override) {
  if (!override) return null
  if (typeof override === 'object' && isValidISODate(override.date)) {
    const hour = Number.isInteger(override.thresholdHourIST) ? override.thresholdHourIST : 0
    const minute = Number.isInteger(override.thresholdMinuteIST) ? override.thresholdMinuteIST : 0
    return { date: override.date, hour, minute }
  }
  const parts = instantToISTParts(override)
  return parts ? { date: parts.istDate, hour: parts.hour, minute: parts.minute } : null
}

export function resolveReleaseInfo(airDate, sources = {}, platformInfo = {}) {
  const override = normalizedOverride(sources.manualOverride ?? sources.newsOverride)
  const platform = platformInfo.platform ?? 'unknown'
  const confidence = platformInfo.confidence ?? 'fallback'
  if (override) {
    return {
      timestamp: timestampFromISTDate(override.date, override.hour, override.minute),
      istDate: override.date,
      thresholdTimeIST: timeLabel(override.hour, override.minute),
      platform,
      source: 'manualOverride',
      dateSource: 'manualOverride',
      predicted: false,
      confidence,
    }
  }

  const airstamp = instantToISTParts(sources.airstamp)
  const tvmazeAirdate = isValidISODate(sources.airdate) ? sources.airdate : null
  const tmdbDate = isValidISODate(airDate) ? airDate : null
  const istDate = airstamp?.istDate ?? tvmazeAirdate ?? tmdbDate
  if (!istDate) return null
  const hour = platformInfo.thresholdHourIST ?? RELEASE_PLATFORMS.unknown.thresholdHourIST
  const minute = platformInfo.thresholdMinuteIST ?? 0
  return {
    timestamp: timestampFromISTDate(istDate, hour, minute),
    istDate,
    thresholdTimeIST: timeLabel(hour, minute),
    platform,
    source: 'platformThreshold',
    dateSource: airstamp ? 'tvmazeAirstamp' : tvmazeAirdate ? 'tvmazeAirdate' : 'tmdb',
    predicted: false,
    confidence,
  }
}

export function releaseInfoFromTimestamp(timestamp, source = 'prediction', metadata = {}) {
  const parts = instantToISTParts(timestamp)
  if (!parts) return null
  return {
    timestamp: parts.timestamp,
    istDate: parts.istDate,
    thresholdTimeIST: timeLabel(parts.hour, parts.minute),
    platform: metadata.platform ?? 'unknown',
    source,
    dateSource: metadata.dateSource ?? source,
    predicted: source === 'prediction',
    confidence: metadata.confidence ?? 'fallback',
  }
}

export function resolveReleaseTimestamp(airDate, sources = {}, platformInfo = {}) {
  return resolveReleaseInfo(airDate, sources, platformInfo)?.timestamp ?? null
}

export function resolveReleaseDateInIST(airDate, sources = {}, platformInfo = {}) {
  return resolveReleaseInfo(airDate, sources, platformInfo)?.istDate ?? null
}

export function resolveReleaseTimeInIST(airDate, sources = {}, platformInfo = {}) {
  return resolveReleaseInfo(airDate, sources, platformInfo)?.thresholdTimeIST ?? null
}

function coerceInstant(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}
