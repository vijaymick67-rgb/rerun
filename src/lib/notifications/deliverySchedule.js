// Computes when an already-eligible episode should actually be pushed,
// honoring the per-subscription preferred delivery hour (6 PM-11 PM IST)
// layered on top of the episode's already-resolved release instant. This is
// purely a *when to send* calculation — it never touches whether an episode
// is eligible in the first place (release-instant resolution, activation
// watermark, watched/tracked/hidden filtering all stay exactly as they were
// in episodeEligibility.js).
//
// Reuses the same fixed-offset IST conversion helpers the release-timing
// pipeline already relies on (src/lib/networkReleaseTiming.js) rather than
// introducing a second timezone approach — India has no DST, so a fixed
// UTC+5:30 offset is exact, not an approximation.
import { istDateISO, timestampFromISTDate } from '../networkReleaseTiming.js'

export const MIN_PREFERRED_HOUR_IST = 18
export const MAX_PREFERRED_HOUR_IST = 23
export const DEFAULT_PREFERRED_HOUR_IST = 20

export function isValidPreferredHour(value) {
  return Number.isInteger(value) && value >= MIN_PREFERRED_HOUR_IST && value <= MAX_PREFERRED_HOUR_IST
}

// scheduledDeliveryInstant = max(releaseInstant, selectedDeliveryInstant),
// where selectedDeliveryInstant is the preferred hour on the same IST
// calendar date the episode itself releases on. An invalid preferredHourIst
// falls back to the default rather than producing a null/garbage schedule —
// callers that need strict validation (the preferences API) reject bad input
// before it ever reaches this function.
export function scheduledDeliveryInstant(releaseTimestamp, preferredHourIst) {
  if (!Number.isFinite(releaseTimestamp)) return null
  const hour = isValidPreferredHour(preferredHourIst) ? preferredHourIst : DEFAULT_PREFERRED_HOUR_IST
  const istDate = istDateISO(new Date(releaseTimestamp))
  const selectedInstant = timestampFromISTDate(istDate, hour, 0)
  return Math.max(releaseTimestamp, selectedInstant)
}

// Whether an eligible episode is sendable *right now* — i.e. the worker's
// evaluation instant has reached the scheduled delivery instant. Episodes
// that fail this check simply aren't included in this run's batch; they stay
// unclaimed and get picked up on a later worker run once their scheduled
// instant arrives.
export function isSendableNow(releaseTimestamp, preferredHourIst, evaluationTime) {
  const scheduled = scheduledDeliveryInstant(releaseTimestamp, preferredHourIst)
  return scheduled !== null && Number.isFinite(evaluationTime) && evaluationTime >= scheduled
}
