import { useEffect, useRef, useState } from 'react'
import {
  buildBackup,
  backupFilename,
  downloadBackupFile,
  importBackupFile,
} from '../lib/backup'
import { getPushSupportState } from '../lib/push/pushSupport'
import {
  getExistingPushSubscription,
  getServiceWorkerRegistration,
  requestNotificationPermission,
  subscribeToPush,
  unsubscribeFromPush,
} from '../lib/push/pushClient'
import { sendTestPush, subscribePush, unsubscribePush, verifyAutomaticEpisodePush } from '../lib/push/pushApi'
import { clearStoredManagementToken, getStoredManagementToken, setStoredManagementToken } from '../lib/push/managementToken'
import { getAutomaticNotificationsActivated, setAutomaticNotificationsActivated } from '../lib/push/automaticActivation'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY

function plural(count, singular, pluralWord = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralWord}`
}

function Chevron() {
  return (
    <svg viewBox="0 0 8 14" className="h-3.5 w-2 shrink-0 text-(--color-text-muted)" aria-hidden="true">
      <path
        d="M1 1l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SettingsSection({ title, children }) {
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-(--color-text-muted)">
        {title}
      </h2>
      <div className="divide-y divide-(--color-border) overflow-hidden rounded-xl border border-(--color-border) bg-(--color-surface)">
        {children}
      </div>
    </section>
  )
}

function SettingsActionRow({ label, onPress, disabled, busyLabel }) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      className="motion-press flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm font-medium text-(--color-text) disabled:opacity-60"
    >
      <span>{label}</span>
      {busyLabel ? (
        <span className="text-xs font-normal text-(--color-text-muted)">{busyLabel}</span>
      ) : (
        <Chevron />
      )}
    </button>
  )
}

// Compact secondary control — same row shape as SettingsActionRow but muted
// styling, so it reads as a diagnostics aside rather than a primary action.
function SettingsSecondaryActionRow({ label, onPress, disabled, ariaLabel }) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-label={ariaLabel}
      className="motion-press flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-xs font-normal text-(--color-text-muted) disabled:opacity-60"
    >
      <span>{label}</span>
    </button>
  )
}

function SettingsInfoRow({ label, status }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5 text-sm">
      <span className="font-medium text-(--color-text-muted)">{label}</span>
      <span className="rounded-full bg-(--color-surface-raised) px-2.5 py-1 text-xs font-medium text-(--color-text-muted)">
        {status}
      </span>
    </div>
  )
}

function SettingsDescriptionRow({ label, description }) {
  return (
    <div className="flex min-h-11 flex-col justify-center gap-0.5 px-4 py-2.5">
      <span className="text-sm font-medium text-(--color-text)">{label}</span>
      <span className="text-xs text-(--color-text-muted)">{description}</span>
    </div>
  )
}

function Banner({ tone, children, live }) {
  const toneClass =
    tone === 'error'
      ? 'border-red-400/40 bg-red-400/10 text-red-400'
      : 'border-(--color-accent) bg-(--color-accent-muted) text-(--color-text)'
  return (
    <p
      className={`motion-banner mt-3 rounded-lg border px-3 py-2 text-sm ${toneClass}`}
      aria-live={live ? 'polite' : undefined}
    >
      {children}
    </p>
  )
}

export default function Settings() {
  return (
    <div className="app-page px-4 pb-6">
      <BackupRestoreSection />
      <NotificationsSection />
    </div>
  )
}

function BackupRestoreSection() {
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState(null)
  const [exportError, setExportError] = useState(null)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [summary, setSummary] = useState(null)
  const [importError, setImportError] = useState(null)
  const inputRef = useRef(null)

  const busy = exporting || running

  async function handleExport() {
    if (busy) return
    setExporting(true)
    setExportNotice(null)
    setExportError(null)
    try {
      const backup = await buildBackup()
      downloadBackupFile(backup, backupFilename())
      const { trackedShows, watchedEpisodes } = backup.data
      setExportNotice(
        `Exported ${plural(trackedShows.length, 'show')} and ${plural(watchedEpisodes.length, 'watched episode')}.`,
      )
    } catch (err) {
      setExportError(err.message || 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  function handleImportRowPress() {
    if (busy) return
    inputRef.current?.click()
  }

  async function handleFileSelected(e) {
    const selected = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!selected || busy) return

    setRunning(true)
    setSummary(null)
    setImportError(null)
    setProgress({ phase: 'reading', current: 0, total: 0, label: 'Reading file…' })

    try {
      const text = await selected.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error("Couldn't read that file — it isn't valid JSON.")
      }

      const result = await importBackupFile(json, { onProgress: setProgress })
      setSummary(result)
    } catch (err) {
      setImportError(err.message || 'Import failed.')
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const progressPct =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : null

  return (
    <>
      <SettingsSection title="Backup & Restore">
        <SettingsActionRow
          label="Export backup"
          onPress={handleExport}
          disabled={busy}
          busyLabel={exporting ? 'Exporting…' : null}
        />
        <SettingsActionRow
          label="Import backup"
          onPress={handleImportRowPress}
          disabled={busy}
          busyLabel={running ? 'Importing…' : null}
        />
      </SettingsSection>

      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleFileSelected}
        disabled={busy}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
      />

      {exportNotice && <Banner tone="success">{exportNotice}</Banner>}
      {exportError && <Banner tone="error">{exportError}</Banner>}

      {progress && (
        <div className="mt-3">
          <p className="text-sm text-(--color-text-muted)">{progress.label}</p>
          {progressPct !== null && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-(--color-surface-raised)">
              <div
                className="h-full rounded-full bg-(--color-accent) transition-[width] duration-200"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
        </div>
      )}

      {importError && <Banner tone="error">{importError}</Banner>}

      {summary?.kind === 'native' && <NativeImportSummary summary={summary} />}
      {summary?.kind === 'external' && <ExternalImportSummary summary={summary} />}
    </>
  )
}

function NativeImportSummary({ summary }) {
  return (
    <div className="motion-banner mt-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
      <p className="text-sm font-semibold text-(--color-text)">Import complete</p>

      <dl className="mt-3 space-y-1.5 text-sm">
        <SummaryRow
          label="Shows added"
          value={`${summary.showsAdded} new · ${summary.showsAlreadyTracked} already tracked`}
        />
        <SummaryRow
          label="Watched episodes added"
          value={`${summary.episodesAdded} new · ${summary.episodesAlreadyLogged} already logged`}
        />
        {summary.showsDuplicateInFile > 0 && (
          <SummaryRow label="Duplicate shows in file" value={summary.showsDuplicateInFile} />
        )}
        {summary.episodesDuplicateInFile > 0 && (
          <SummaryRow label="Duplicate episodes in file" value={summary.episodesDuplicateInFile} />
        )}
        {summary.showsFailed > 0 && (
          <SummaryRow label="Shows failed to write" value={summary.showsFailed} />
        )}
        {summary.episodesFailed > 0 && (
          <SummaryRow label="Episodes failed to write" value={summary.episodesFailed} />
        )}
      </dl>

      {summary.errors.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="font-medium text-red-400">
            {plural(summary.errors.length, 'issue')} (import continued):
          </p>
          <ul className="mt-1 list-inside list-disc text-(--color-text-muted)">
            {summary.errors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ExternalImportSummary({ summary }) {
  return (
    <div className="motion-banner mt-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
      <p className="text-sm font-semibold text-(--color-text)">Import complete</p>

      <dl className="mt-3 space-y-1.5 text-sm">
        <SummaryRow
          label="Shows tracked"
          value={`${summary.showsNewlyTracked} new · ${summary.showsTotal} total`}
        />
        <SummaryRow label="Episodes imported" value={summary.episodesImported} />
        {summary.seasonMarkersApplied > 0 && (
          <SummaryRow
            label="Seasons filled from markers"
            value={summary.seasonMarkersApplied}
          />
        )}
      </dl>

      {summary.fallbackShows.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="text-(--color-text-muted)">
            Marked fully watched (no per-episode data in the backup):
          </p>
          <ul className="mt-1 list-inside list-disc text-(--color-text)">
            {summary.fallbackShows.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.errors.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="font-medium text-red-400">
            {plural(summary.errors.length, 'issue')} (import continued):
          </p>
          <ul className="mt-1 list-inside list-disc text-(--color-text-muted)">
            {summary.errors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function SummaryRow({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-(--color-text-muted)">{label}</dt>
      <dd className="font-medium text-(--color-text)">{value}</dd>
    </div>
  )
}

// Local per-mount state machine, not persisted: 'checking' (support/existing
// subscription not yet resolved) | 'idle' (not subscribed — permission is
// either not-yet-requested or was granted but the subscription was lost) |
// 'denied' | 'enabling' | 'enabled'. `supportState` short-circuits all of
// this for the unsupported/needs-install cases, which never touch the
// service worker.
function NotificationsSection() {
  const [supportState] = useState(() => getPushSupportState())
  const [status, setStatus] = useState('checking')
  const [subscriptionError, setSubscriptionError] = useState(null)
  const [disabling, setDisabling] = useState(false)
  const [testState, setTestState] = useState('idle') // idle | sending | sent | error
  const [testError, setTestError] = useState(null)
  const [verifyState, setVerifyState] = useState('idle') // idle | verifying | verified | error
  const [verifyError, setVerifyError] = useState(null)

  useEffect(() => {
    if (supportState !== 'supported') return
    let cancelled = false

    async function init() {
      if (typeof Notification === 'undefined') {
        if (!cancelled) setStatus('idle')
        return
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setStatus('denied')
        return
      }
      try {
        const registration = await getServiceWorkerRegistration()
        const existing = await getExistingPushSubscription(registration)
        if (cancelled) return
        const enabled = Boolean(existing) && Notification.permission === 'granted'
        setStatus(enabled ? 'enabled' : 'idle')
        // Phase 2: a subscription created under Phase 1 has never activated
        // automatic episode notifications (the server-side watermark stays
        // null until this runs). Re-posting the existing subscription is
        // the same idempotent upsert Enable uses, so it's safe to fire
        // automatically here, once per installation — see
        // api/push/subscribe.js and src/lib/push/automaticActivation.js.
        // Deliberately isolated behind Promise.resolve().then(...): this is
        // best-effort background wiring and must never affect (or throw
        // into) the status this effect just set above.
        if (enabled && !getAutomaticNotificationsActivated()) {
          Promise.resolve()
            .then(() => subscribePush(existing))
            .then((result) => {
              if (cancelled) return
              setStoredManagementToken(result?.managementToken ?? null)
              setAutomaticNotificationsActivated(true)
            })
            .catch(() => {
              // Best-effort: leave the flag unset so the next mount retries.
              // Never surfaces as a user-facing error — notifications are
              // already working from this device's point of view.
            })
        }
      } catch {
        if (!cancelled) setStatus('idle')
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [supportState])

  // Only ever invoked from the Enable button's onClick below — never
  // automatically. iOS treats an unprompted permission request as abuse, and
  // even where that's not enforced, the product deliberately never asks
  // without an explicit tap.
  async function handleEnable() {
    if (status === 'enabling') return
    setStatus('enabling')
    setSubscriptionError(null)
    try {
      const permission = await requestNotificationPermission()
      if (permission === 'denied') {
        setStatus('denied')
        return
      }
      if (permission !== 'granted') {
        setStatus('idle')
        return
      }
      const registration = await getServiceWorkerRegistration()
      const subscription = await subscribeToPush(registration, VAPID_PUBLIC_KEY)
      const subscribeResult = await subscribePush(subscription)
      setStoredManagementToken(subscribeResult?.managementToken ?? null)
      setAutomaticNotificationsActivated(true)
      setStatus('enabled')
    } catch (err) {
      setSubscriptionError(err.message || 'Could not enable notifications.')
      setStatus('idle')
    }
  }

  async function handleSendTest() {
    if (testState === 'sending') return
    const managementToken = getStoredManagementToken()
    if (!managementToken) {
      setTestError('No stored subscription — enable notifications again.')
      setTestState('error')
      return
    }
    setTestState('sending')
    setTestError(null)
    try {
      await sendTestPush(managementToken)
      setTestState('sent')
    } catch (err) {
      setTestError(err.message || 'Could not deliver the test notification.')
      setTestState('error')
    }
  }

  // Physical-device diagnostics only: sends a synthetic episode-style push
  // through the Phase 2 payload path so the owner can confirm delivery on a
  // real device without waiting for a real episode to air. Never touches
  // tracked_shows/watched_episodes, the automatic activation flag, or the
  // stored management token.
  async function handleVerify() {
    if (verifyState === 'verifying') return
    const managementToken = getStoredManagementToken()
    if (!managementToken) {
      setVerifyError('No stored subscription — enable notifications again.')
      setVerifyState('error')
      return
    }
    setVerifyState('verifying')
    setVerifyError(null)
    try {
      await verifyAutomaticEpisodePush(managementToken)
      setVerifyState('verified')
    } catch (err) {
      setVerifyError(err.message || 'Could not deliver the verification notification.')
      setVerifyState('error')
    }
  }

  async function handleDisable() {
    if (disabling) return
    setDisabling(true)
    setSubscriptionError(null)
    try {
      const registration = await getServiceWorkerRegistration()
      const subscription = await getExistingPushSubscription(registration)
      const endpoint = subscription?.endpoint ?? null
      const managementToken = getStoredManagementToken()
      await unsubscribeFromPush(subscription)
      clearStoredManagementToken()
      setAutomaticNotificationsActivated(false)
      setStatus('idle')
      setTestState('idle')
      setTestError(null)
      setVerifyState('idle')
      setVerifyError(null)
      if (endpoint && managementToken) await unsubscribePush(endpoint, managementToken)
    } catch (err) {
      setSubscriptionError(err.message || 'Could not disable notifications.')
    } finally {
      setDisabling(false)
    }
  }

  if (supportState === 'unsupported') {
    return (
      <SettingsSection title="Notifications">
        <SettingsDescriptionRow label="Episode notifications" description="Native notifications from Rerun" />
        <SettingsInfoRow label="Status" status="Unsupported" />
      </SettingsSection>
    )
  }

  if (supportState === 'needs-install') {
    return (
      <SettingsSection title="Notifications">
        <SettingsDescriptionRow label="Episode notifications" description="Native notifications from Rerun" />
        <SettingsInfoRow label="Status" status="Must install Rerun to Home Screen" />
      </SettingsSection>
    )
  }

  return (
    <>
      <SettingsSection title="Notifications">
        <SettingsDescriptionRow label="Episode notifications" description="Native notifications from Rerun" />
        {status === 'checking' && <SettingsInfoRow label="Status" status="Checking…" />}
        {status === 'denied' && <SettingsInfoRow label="Status" status="Permission denied" />}
        {(status === 'idle' || status === 'enabling') && (
          <SettingsActionRow
            label="Enable notifications"
            onPress={handleEnable}
            disabled={status === 'enabling'}
            busyLabel={status === 'enabling' ? 'Enabling…' : null}
          />
        )}
        {status === 'enabled' && (
          <>
            <SettingsInfoRow label="Status" status="Notifications enabled" />
            <SettingsInfoRow label="Automatic episode alerts" status="Active" />
            <SettingsActionRow
              label="Send test notification"
              onPress={handleSendTest}
              disabled={testState === 'sending'}
              busyLabel={testState === 'sending' ? 'Sending test…' : null}
            />
            <SettingsSecondaryActionRow
              label={verifyState === 'verifying' ? 'Verifying…' : 'Verify automatic episode alert'}
              ariaLabel="Verify automatic episode alert — sends a synthetic episode notification for physical-device testing"
              onPress={handleVerify}
              disabled={verifyState === 'verifying'}
            />
            <SettingsActionRow
              label="Disable notifications"
              onPress={handleDisable}
              disabled={disabling}
              busyLabel={disabling ? 'Disabling…' : null}
            />
          </>
        )}
      </SettingsSection>

      {testState === 'sent' && <Banner tone="success">Test notification sent.</Banner>}
      {testState === 'error' && <Banner tone="error">Test delivery error: {testError}</Banner>}
      {verifyState === 'verified' && (
        <Banner tone="success" live>Verification notification sent</Banner>
      )}
      {verifyState === 'error' && (
        <Banner tone="error" live>{verifyError}</Banner>
      )}
      {subscriptionError && <Banner tone="error">Subscription error: {subscriptionError}</Banner>}
    </>
  )
}
