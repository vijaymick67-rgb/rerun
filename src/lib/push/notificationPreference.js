// Local cache of the last server-confirmed preferred reminder hour
// (Settings -> Notifications -> "Reminder time"). The server
// (push_subscriptions.preferred_notification_hour_ist) is the source of
// truth — this is only ever written from an actual server response
// (/api/push/subscribe or /api/push/preferences), never fabricated, so
// Settings can show the right value immediately on mount without a
// dedicated read endpoint. Mirrors the managementToken.js storage pattern.
import { DEFAULT_PREFERRED_HOUR_IST, isValidPreferredHour } from '../notifications/deliverySchedule.js'

const STORAGE_KEY = 'rerun:push:preferredNotificationHourIst'

export function getStoredPreferredHour(storage = globalThis.localStorage) {
  if (!storage) return DEFAULT_PREFERRED_HOUR_IST
  try {
    const raw = storage.getItem(STORAGE_KEY)
    const parsed = raw === null ? null : Number(raw)
    return isValidPreferredHour(parsed) ? parsed : DEFAULT_PREFERRED_HOUR_IST
  } catch {
    return DEFAULT_PREFERRED_HOUR_IST
  }
}

export function setStoredPreferredHour(hour, storage = globalThis.localStorage) {
  if (!storage) return
  try {
    if (isValidPreferredHour(hour)) storage.setItem(STORAGE_KEY, String(hour))
    else storage.removeItem(STORAGE_KEY)
  } catch {
    // Private-browsing/quota-exceeded storage errors just mean the cached
    // value isn't persisted — not fatal, the next server response recovers.
  }
}
