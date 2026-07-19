// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../lib/backup', () => ({
  buildBackup: vi.fn(),
  backupFilename: vi.fn(() => 'rerun-backup-2026-01-01-000000.json'),
  downloadBackupFile: vi.fn(),
  importBackupFile: vi.fn(),
}))

vi.mock('../lib/push/pushSupport', () => ({
  getPushSupportState: vi.fn(() => 'supported'),
}))

vi.mock('../lib/push/pushClient', () => ({
  requestNotificationPermission: vi.fn(),
  getServiceWorkerRegistration: vi.fn(async () => ({ pushManager: {} })),
  getExistingPushSubscription: vi.fn(async () => null),
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(async () => true),
}))

vi.mock('../lib/push/pushApi', () => ({
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
  sendTestPush: vi.fn(),
  verifyAutomaticEpisodePush: vi.fn(),
}))

vi.mock('../lib/push/managementToken', () => ({
  getStoredManagementToken: vi.fn(),
  setStoredManagementToken: vi.fn(),
  clearStoredManagementToken: vi.fn(),
}))

vi.mock('../lib/push/automaticActivation', () => ({
  getAutomaticNotificationsActivated: vi.fn(),
  setAutomaticNotificationsActivated: vi.fn(),
}))

import * as backupMock from '../lib/backup'
import * as pushSupportMock from '../lib/push/pushSupport'
import * as pushClientMock from '../lib/push/pushClient'
import * as pushApiMock from '../lib/push/pushApi'
import * as managementTokenMock from '../lib/push/managementToken'
import * as automaticActivationMock from '../lib/push/automaticActivation'
import Settings from './Settings'

let container = null
let root = null

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function mountSettings() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<Settings />) })
}

// Lets chained promises inside the Notifications section's mount effect
// (getServiceWorkerRegistration -> getExistingPushSubscription, each a
// separate microtask hop) settle, and their resulting setState calls flush
// through React, before assertions run.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function getByText(text) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT)
  let node = walker.currentNode
  while (node) {
    if (node.textContent.trim() === text && node.children.length === 0) return node
    node = walker.nextNode()
  }
  return null
}

function fileInput() {
  return container.querySelector('input[type="file"]')
}

function fakeFile(text) {
  return { name: 'backup.json', text: () => Promise.resolve(text) }
}

async function selectFile(text) {
  const input = fileInput()
  Object.defineProperty(input, 'files', { configurable: true, value: [fakeFile(text)] })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => {
  backupMock.buildBackup.mockReset()
  backupMock.backupFilename.mockReset().mockReturnValue('rerun-backup-2026-01-01-000000.json')
  backupMock.downloadBackupFile.mockReset()
  backupMock.importBackupFile.mockReset()

  pushSupportMock.getPushSupportState.mockReset().mockReturnValue('supported')
  pushClientMock.requestNotificationPermission.mockReset()
  pushClientMock.getServiceWorkerRegistration.mockReset().mockResolvedValue({ pushManager: {} })
  pushClientMock.getExistingPushSubscription.mockReset().mockResolvedValue(null)
  pushClientMock.subscribeToPush.mockReset()
  pushClientMock.unsubscribeFromPush.mockReset().mockResolvedValue(true)
  pushApiMock.subscribePush.mockReset()
  pushApiMock.unsubscribePush.mockReset()
  pushApiMock.sendTestPush.mockReset()
  pushApiMock.verifyAutomaticEpisodePush.mockReset()
  managementTokenMock.getStoredManagementToken.mockReset().mockReturnValue('stored-management-token')
  managementTokenMock.setStoredManagementToken.mockReset()
  managementTokenMock.clearStoredManagementToken.mockReset()
  // Defaults to "already activated" so existing/Phase 1 assertions about
  // subscribePush call counts are unaffected by the Phase 2 mount-time
  // activation call — tests that specifically exercise that call override
  // this to `false`.
  automaticActivationMock.getAutomaticNotificationsActivated.mockReset().mockReturnValue(true)
  automaticActivationMock.setAutomaticNotificationsActivated.mockReset()
  delete globalThis.Notification
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  delete globalThis.Notification
})

describe('Settings: Backup & Restore section', () => {
  it('renders Export backup and Import backup action rows', async () => {
    await mountSettings()
    expect(getByText('Export backup')).not.toBeNull()
    expect(getByText('Import backup')).not.toBeNull()
  })

  it('keeps the native file input hidden and out of the tab order, triggering it only via the Import row', async () => {
    await mountSettings()
    const input = fileInput()
    expect(input).not.toBeNull()
    expect(input.className).toContain('hidden')
    expect(input.tabIndex).toBe(-1)

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click')
    const importRow = getByText('Import backup').closest('button')
    await act(async () => { importRow.click() })
    expect(clickSpy).toHaveBeenCalledTimes(1)
    clickSpy.mockRestore()
  })

  it('cannot trigger a second export while one is already running', async () => {
    const gate = deferred()
    backupMock.buildBackup.mockReturnValue(gate.promise)
    await mountSettings()

    const exportRow = getByText('Export backup').closest('button')
    await act(async () => { exportRow.click() })
    await act(async () => { exportRow.click() }) // second tap while pending
    expect(backupMock.buildBackup).toHaveBeenCalledTimes(1)

    await act(async () => {
      gate.resolve({ data: { trackedShows: [], watchedEpisodes: [] } })
      await gate.promise
    })
    expect(backupMock.downloadBackupFile).toHaveBeenCalledTimes(1)
  })

  it('downloads the built backup and shows calm success feedback, including for an empty database', async () => {
    backupMock.buildBackup.mockResolvedValue({ data: { trackedShows: [], watchedEpisodes: [] } })
    await mountSettings()

    const exportRow = getByText('Export backup').closest('button')
    await act(async () => { exportRow.click() })

    expect(backupMock.downloadBackupFile).toHaveBeenCalledWith(
      { data: { trackedShows: [], watchedEpisodes: [] } },
      'rerun-backup-2026-01-01-000000.json',
    )
    expect(container.textContent).toContain('0 shows')
  })

  it('shows calm error feedback when export fails', async () => {
    backupMock.buildBackup.mockRejectedValue(new Error('Network unreachable'))
    await mountSettings()
    const exportRow = getByText('Export backup').closest('button')
    await act(async () => { exportRow.click() })
    expect(container.textContent).toContain('Network unreachable')
  })

  it('renders a native-backup import summary with added/already-tracked counts', async () => {
    backupMock.importBackupFile.mockResolvedValue({
      kind: 'native',
      showsAdded: 2,
      showsAlreadyTracked: 1,
      showsDuplicateInFile: 0,
      showsFailed: 0,
      episodesAdded: 5,
      episodesAlreadyLogged: 3,
      episodesDuplicateInFile: 0,
      episodesFailed: 0,
      errors: [],
    })
    await mountSettings()
    await selectFile('{"format":"rerun-backup"}')

    expect(backupMock.importBackupFile).toHaveBeenCalledWith(
      { format: 'rerun-backup' },
      expect.objectContaining({ onProgress: expect.any(Function) }),
    )
    expect(container.textContent).toContain('2 new')
    expect(container.textContent).toContain('1 already tracked')
    expect(container.textContent).toContain('5 new')
    expect(container.textContent).toContain('3 already logged')
    // No duplicate/failed rows in this summary — those lines must stay hidden, not read as zero-value noise.
    expect(container.textContent).not.toContain('Duplicate shows in file')
    expect(container.textContent).not.toContain('Shows failed to write')
  })

  it('never labels duplicate-in-file or failed-write rows as "already tracked/logged" data', async () => {
    backupMock.importBackupFile.mockResolvedValue({
      kind: 'native',
      showsAdded: 1,
      showsAlreadyTracked: 0,
      showsDuplicateInFile: 2,
      showsFailed: 4,
      episodesAdded: 0,
      episodesAlreadyLogged: 0,
      episodesDuplicateInFile: 1,
      episodesFailed: 3,
      errors: ["Couldn't write 4 tracked_shows row(s): network blip", "Couldn't write 3 watched_episodes row(s): network blip"],
    })
    await mountSettings()
    await selectFile('{"format":"rerun-backup"}')

    expect(container.textContent).toContain('1 new')
    expect(container.textContent).toContain('0 already tracked')
    expect(container.textContent).toContain('Duplicate shows in file')
    expect(container.textContent).toContain('2')
    expect(container.textContent).toContain('Shows failed to write')
    expect(container.textContent).toContain('4')
    expect(container.textContent).toContain('Duplicate episodes in file')
    expect(container.textContent).toContain('Episodes failed to write')
    // The 4 failed shows must never be counted as "already tracked" data the user can trust exists.
    expect(container.textContent).not.toMatch(/4 already tracked/)
  })

  it('renders the existing external-import summary shape unchanged', async () => {
    backupMock.importBackupFile.mockResolvedValue({
      kind: 'external',
      showsTotal: 4,
      showsNewlyTracked: 2,
      episodesImported: 10,
      seasonMarkersApplied: 0,
      fallbackShows: [],
      errors: [],
    })
    await mountSettings()
    await selectFile('{"shows":{"cW":[]}}')

    expect(container.textContent).toContain('2 new')
    expect(container.textContent).toContain('4 total')
    expect(container.textContent).toContain('10')
  })

  it('shows a non-destructive error for invalid JSON without touching the importer', async () => {
    await mountSettings()
    await selectFile('not valid json{{{')
    expect(backupMock.importBackupFile).not.toHaveBeenCalled()
    expect(container.textContent).toMatch(/isn't valid JSON/)
  })

  it('resets the input value after selection so the same file can be chosen again', async () => {
    backupMock.importBackupFile.mockResolvedValue({
      kind: 'native',
      showsAdded: 0,
      showsAlreadyTracked: 0,
      showsDuplicateInFile: 0,
      showsFailed: 0,
      episodesAdded: 0,
      episodesAlreadyLogged: 0,
      episodesDuplicateInFile: 0,
      episodesFailed: 0,
      errors: [],
    })
    await mountSettings()
    await selectFile('{"format":"rerun-backup"}')
    expect(fileInput().value).toBe('')
  })

  it('does not start an import when the file picker is cancelled (no file selected)', async () => {
    await mountSettings()
    const input = fileInput()
    Object.defineProperty(input, 'files', { configurable: true, value: [] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(backupMock.importBackupFile).not.toHaveBeenCalled()
  })

  it('disables both actions while an import is running, so it cannot be triggered twice', async () => {
    const gate = deferred()
    backupMock.importBackupFile.mockReturnValue(gate.promise)
    await mountSettings()
    await selectFile('{"format":"rerun-backup"}')

    const importRow = getByText('Import backup').closest('button')
    const exportRow = getByText('Export backup').closest('button')
    expect(importRow.disabled).toBe(true)
    expect(exportRow.disabled).toBe(true)

    await act(async () => {
      gate.resolve({
        kind: 'native',
        showsAdded: 0,
        showsAlreadyTracked: 0,
        showsDuplicateInFile: 0,
        showsFailed: 0,
        episodesAdded: 0,
        episodesAlreadyLogged: 0,
        episodesDuplicateInFile: 0,
        episodesFailed: 0,
        errors: [],
      })
      await gate.promise
    })
    expect(importRow.disabled).toBe(false)
  })
})

describe('Settings: Notifications section', () => {
  it('shows an unsupported state with no action row', async () => {
    pushSupportMock.getPushSupportState.mockReturnValue('unsupported')
    await mountSettings()
    await flush()
    expect(container.textContent).toContain('Episode notifications')
    expect(container.textContent).toContain('Unsupported')
    expect(getByText('Enable notifications')).toBeNull()
  })

  it('prompts installing to the Home Screen on iOS Safari outside the installed app', async () => {
    pushSupportMock.getPushSupportState.mockReturnValue('needs-install')
    await mountSettings()
    await flush()
    expect(container.textContent).toContain('Must install Rerun to Home Screen')
    expect(getByText('Enable notifications')).toBeNull()
  })

  it('shows Enable notifications initially and never requests permission automatically', async () => {
    await mountSettings()
    await flush()
    expect(getByText('Enable notifications')).not.toBeNull()
    expect(pushClientMock.requestNotificationPermission).not.toHaveBeenCalled()
  })

  it('shows Permission denied on mount without offering to enable', async () => {
    globalThis.Notification = { permission: 'denied' }
    await mountSettings()
    await flush()
    expect(container.textContent).toContain('Permission denied')
    expect(getByText('Enable notifications')).toBeNull()
  })

  it('shows Notifications enabled on mount when a subscription already exists', async () => {
    globalThis.Notification = { permission: 'granted' }
    pushClientMock.getExistingPushSubscription.mockResolvedValue({ endpoint: 'https://web.push.apple.com/existing' })
    await mountSettings()
    await flush()
    expect(container.textContent).toContain('Notifications enabled')
    expect(pushClientMock.requestNotificationPermission).not.toHaveBeenCalled()
  })

  it('requests permission only on explicit tap, then subscribes and reports enabled', async () => {
    pushClientMock.requestNotificationPermission.mockResolvedValue('granted')
    const subscription = {
      endpoint: 'https://web.push.apple.com/abc',
      toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc' }),
    }
    pushClientMock.subscribeToPush.mockResolvedValue(subscription)
    pushApiMock.subscribePush.mockResolvedValue({ success: true, managementToken: 'fresh-management-token' })

    await mountSettings()
    await flush()
    expect(pushClientMock.requestNotificationPermission).not.toHaveBeenCalled()

    const enableRow = getByText('Enable notifications').closest('button')
    await act(async () => { enableRow.click() })

    expect(pushClientMock.requestNotificationPermission).toHaveBeenCalledOnce()
    expect(pushApiMock.subscribePush).toHaveBeenCalledWith(subscription)
    expect(managementTokenMock.setStoredManagementToken).toHaveBeenCalledWith('fresh-management-token')
    expect(container.textContent).toContain('Notifications enabled')
    expect(getByText('Send test notification')).not.toBeNull()
    expect(getByText('Disable notifications')).not.toBeNull()
  })

  it('shows Permission denied when the user denies the native prompt', async () => {
    pushClientMock.requestNotificationPermission.mockResolvedValue('denied')
    await mountSettings()
    await flush()
    await act(async () => { getByText('Enable notifications').closest('button').click() })
    expect(container.textContent).toContain('Permission denied')
    expect(pushApiMock.subscribePush).not.toHaveBeenCalled()
  })

  it('shows a subscription error and reverts to Enable notifications on failure', async () => {
    pushClientMock.requestNotificationPermission.mockResolvedValue('granted')
    pushClientMock.subscribeToPush.mockRejectedValue(new Error('No active service worker registration.'))
    await mountSettings()
    await flush()
    await act(async () => { getByText('Enable notifications').closest('button').click() })
    expect(container.textContent).toContain('Subscription error: No active service worker registration.')
    expect(getByText('Enable notifications')).not.toBeNull()
  })

  it('sends a test notification on tap and reports it as sent, not received', async () => {
    pushClientMock.requestNotificationPermission.mockResolvedValue('granted')
    const subscription = { endpoint: 'https://web.push.apple.com/abc', toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc' }) }
    pushClientMock.subscribeToPush.mockResolvedValue(subscription)
    pushApiMock.subscribePush.mockResolvedValue({ success: true, managementToken: 'fresh-management-token' })
    pushApiMock.sendTestPush.mockResolvedValue({ success: true })

    await mountSettings()
    await flush()
    await act(async () => { getByText('Enable notifications').closest('button').click() })
    await act(async () => { getByText('Send test notification').closest('button').click() })

    expect(pushApiMock.sendTestPush).toHaveBeenCalledWith('stored-management-token')
    expect(container.textContent).toContain('Test notification sent.')
    expect(container.textContent).not.toContain('received')
  })

  it('shows an error and never calls the server when no management token is stored', async () => {
    pushClientMock.requestNotificationPermission.mockResolvedValue('granted')
    const subscription = { endpoint: 'https://web.push.apple.com/abc', toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc' }) }
    pushClientMock.subscribeToPush.mockResolvedValue(subscription)
    pushApiMock.subscribePush.mockResolvedValue({ success: true, managementToken: 'fresh-management-token' })
    managementTokenMock.getStoredManagementToken.mockReturnValue(null)

    await mountSettings()
    await flush()
    await act(async () => { getByText('Enable notifications').closest('button').click() })
    await act(async () => { getByText('Send test notification').closest('button').click() })

    expect(pushApiMock.sendTestPush).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Test delivery error:')
    expect(container.textContent).toContain('Notifications enabled')
  })

  it('shows a test delivery error while remaining enabled', async () => {
    pushClientMock.requestNotificationPermission.mockResolvedValue('granted')
    const subscription = { endpoint: 'https://web.push.apple.com/abc', toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc' }) }
    pushClientMock.subscribeToPush.mockResolvedValue(subscription)
    pushApiMock.subscribePush.mockResolvedValue({ success: true })
    pushApiMock.sendTestPush.mockRejectedValue(new Error('No stored subscription — enable notifications first'))

    await mountSettings()
    await flush()
    await act(async () => { getByText('Enable notifications').closest('button').click() })
    await act(async () => { getByText('Send test notification').closest('button').click() })

    expect(container.textContent).toContain('Test delivery error: No stored subscription — enable notifications first')
    expect(container.textContent).toContain('Notifications enabled')
  })

  it('disables notifications on tap: unsubscribes locally, clears the local token, and removes the stored row', async () => {
    pushClientMock.requestNotificationPermission.mockResolvedValue('granted')
    const subscription = { endpoint: 'https://web.push.apple.com/abc', toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc' }) }
    pushClientMock.subscribeToPush.mockResolvedValue(subscription)
    pushApiMock.subscribePush.mockResolvedValue({ success: true, managementToken: 'fresh-management-token' })

    await mountSettings()
    await flush()
    await act(async () => { getByText('Enable notifications').closest('button').click() })

    pushClientMock.getExistingPushSubscription.mockResolvedValue(subscription)
    await act(async () => { getByText('Disable notifications').closest('button').click() })

    expect(pushClientMock.unsubscribeFromPush).toHaveBeenCalledWith(subscription)
    expect(pushApiMock.unsubscribePush).toHaveBeenCalledWith('https://web.push.apple.com/abc', 'stored-management-token')
    expect(managementTokenMock.clearStoredManagementToken).toHaveBeenCalledOnce()
    expect(getByText('Enable notifications')).not.toBeNull()
    expect(getByText('Send test notification')).toBeNull()
  })

  it('still unsubscribes locally and clears the local token when no management token was stored', async () => {
    pushClientMock.requestNotificationPermission.mockResolvedValue('granted')
    const subscription = { endpoint: 'https://web.push.apple.com/abc', toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc' }) }
    pushClientMock.subscribeToPush.mockResolvedValue(subscription)
    pushApiMock.subscribePush.mockResolvedValue({ success: true, managementToken: 'fresh-management-token' })

    await mountSettings()
    await flush()
    await act(async () => { getByText('Enable notifications').closest('button').click() })

    pushClientMock.getExistingPushSubscription.mockResolvedValue(subscription)
    managementTokenMock.getStoredManagementToken.mockReturnValue(null)
    await act(async () => { getByText('Disable notifications').closest('button').click() })

    expect(pushClientMock.unsubscribeFromPush).toHaveBeenCalledWith(subscription)
    expect(pushApiMock.unsubscribePush).not.toHaveBeenCalled()
    expect(managementTokenMock.clearStoredManagementToken).toHaveBeenCalledOnce()
    expect(getByText('Enable notifications')).not.toBeNull()
  })

  it('shows the automatic episode alerts status line once enabled', async () => {
    globalThis.Notification = { permission: 'granted' }
    pushClientMock.getExistingPushSubscription.mockResolvedValue({ endpoint: 'https://web.push.apple.com/existing' })
    await mountSettings()
    await flush()
    expect(container.textContent).toContain('Automatic episode alerts')
    expect(container.textContent).toContain('Active')
  })

  describe('Verify automatic episode alert', () => {
    async function enableNotifications() {
      pushClientMock.requestNotificationPermission.mockResolvedValue('granted')
      const subscription = { endpoint: 'https://web.push.apple.com/abc', toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc' }) }
      pushClientMock.subscribeToPush.mockResolvedValue(subscription)
      pushApiMock.subscribePush.mockResolvedValue({ success: true, managementToken: 'fresh-management-token' })

      await mountSettings()
      await flush()
      await act(async () => { getByText('Enable notifications').closest('button').click() })
    }

    it('does not render before notifications are enabled', async () => {
      await mountSettings()
      await flush()
      expect(getByText('Verify automatic episode alert')).toBeNull()
    })

    it('renders once notifications are enabled', async () => {
      await enableNotifications()
      expect(getByText('Verify automatic episode alert')).not.toBeNull()
    })

    it('reads the stored management token and calls /api/notifications/verify with it on tap', async () => {
      pushApiMock.verifyAutomaticEpisodePush.mockResolvedValue({ success: true, synthetic: true })
      await enableNotifications()

      await act(async () => { getByText('Verify automatic episode alert').closest('button').click() })

      expect(managementTokenMock.getStoredManagementToken).toHaveBeenCalled()
      expect(pushApiMock.verifyAutomaticEpisodePush).toHaveBeenCalledWith('stored-management-token')
    })

    it('shows a compact pending state and blocks a second tap while one request is in flight', async () => {
      const gate = deferred()
      pushApiMock.verifyAutomaticEpisodePush.mockReturnValue(gate.promise)
      await enableNotifications()

      const verifyRow = getByText('Verify automatic episode alert').closest('button')
      await act(async () => { verifyRow.click() })
      expect(getByText('Verifying…')).not.toBeNull()

      const stillPendingRow = getByText('Verifying…').closest('button')
      await act(async () => { stillPendingRow.click() }) // second tap while pending
      expect(pushApiMock.verifyAutomaticEpisodePush).toHaveBeenCalledTimes(1)

      await act(async () => {
        gate.resolve({ success: true, synthetic: true })
        await gate.promise
      })
      expect(getByText('Verification notification sent')).not.toBeNull()
    })

    it('shows a success state after the endpoint confirms delivery', async () => {
      pushApiMock.verifyAutomaticEpisodePush.mockResolvedValue({ success: true, synthetic: true })
      await enableNotifications()

      await act(async () => { getByText('Verify automatic episode alert').closest('button').click() })

      expect(container.textContent).toContain('Verification notification sent')
    })

    it('shows the missing-token message and never calls the endpoint when no management token is stored', async () => {
      managementTokenMock.getStoredManagementToken.mockReturnValue(null)
      await enableNotifications()

      await act(async () => { getByText('Verify automatic episode alert').closest('button').click() })

      expect(pushApiMock.verifyAutomaticEpisodePush).not.toHaveBeenCalled()
      expect(container.textContent).toContain('No stored subscription — enable notifications again.')
    })

    it('surfaces an endpoint error safely below the control', async () => {
      pushApiMock.verifyAutomaticEpisodePush.mockRejectedValue(new Error('Could not deliver verification notification'))
      await enableNotifications()

      await act(async () => { getByText('Verify automatic episode alert').closest('button').click() })

      expect(container.textContent).toContain('Could not deliver verification notification')
    })

    it('displays the 30-second throttle error returned by the endpoint', async () => {
      pushApiMock.verifyAutomaticEpisodePush.mockRejectedValue(
        new Error('A verification notification was sent recently — try again shortly'),
      )
      await enableNotifications()

      await act(async () => { getByText('Verify automatic episode alert').closest('button').click() })

      expect(container.textContent).toContain('A verification notification was sent recently — try again shortly')
    })

    it('leaves the existing Send test notification action calling the Phase 1 test endpoint unchanged', async () => {
      pushApiMock.sendTestPush.mockResolvedValue({ success: true })
      await enableNotifications()

      await act(async () => { getByText('Send test notification').closest('button').click() })

      expect(pushApiMock.sendTestPush).toHaveBeenCalledWith('stored-management-token')
      expect(pushApiMock.verifyAutomaticEpisodePush).not.toHaveBeenCalled()
      expect(container.textContent).toContain('Test notification sent.')
    })

    it('does not touch permission, subscription, or automatic-activation state', async () => {
      pushApiMock.verifyAutomaticEpisodePush.mockResolvedValue({ success: true, synthetic: true })
      await enableNotifications()
      automaticActivationMock.setAutomaticNotificationsActivated.mockClear()
      pushApiMock.subscribePush.mockClear()
      pushClientMock.requestNotificationPermission.mockClear()
      managementTokenMock.setStoredManagementToken.mockClear()

      await act(async () => { getByText('Verify automatic episode alert').closest('button').click() })

      expect(automaticActivationMock.setAutomaticNotificationsActivated).not.toHaveBeenCalled()
      expect(pushApiMock.subscribePush).not.toHaveBeenCalled()
      expect(pushClientMock.requestNotificationPermission).not.toHaveBeenCalled()
      expect(managementTokenMock.setStoredManagementToken).not.toHaveBeenCalled()
      expect(managementTokenMock.clearStoredManagementToken).not.toHaveBeenCalled()
    })
  })

  describe('Phase 2 automatic-notification activation', () => {
    it('re-subscribes once on mount to activate automatic notifications for a pre-existing subscription', async () => {
      globalThis.Notification = { permission: 'granted' }
      const existing = { endpoint: 'https://web.push.apple.com/existing' }
      pushClientMock.getExistingPushSubscription.mockResolvedValue(existing)
      automaticActivationMock.getAutomaticNotificationsActivated.mockReturnValue(false)
      pushApiMock.subscribePush.mockResolvedValue({ success: true, managementToken: 'rotated-token' })

      await mountSettings()
      await flush()

      expect(pushApiMock.subscribePush).toHaveBeenCalledWith(existing)
      expect(managementTokenMock.setStoredManagementToken).toHaveBeenCalledWith('rotated-token')
      expect(automaticActivationMock.setAutomaticNotificationsActivated).toHaveBeenCalledWith(true)
      // Never disrupts the status the mount effect already resolved.
      expect(container.textContent).toContain('Notifications enabled')
    })

    it('does not re-subscribe on mount once already activated', async () => {
      globalThis.Notification = { permission: 'granted' }
      pushClientMock.getExistingPushSubscription.mockResolvedValue({ endpoint: 'https://web.push.apple.com/existing' })
      automaticActivationMock.getAutomaticNotificationsActivated.mockReturnValue(true)

      await mountSettings()
      await flush()

      expect(pushApiMock.subscribePush).not.toHaveBeenCalled()
    })

    it('a failed mount-time activation attempt is silent and does not disturb the enabled status', async () => {
      globalThis.Notification = { permission: 'granted' }
      pushClientMock.getExistingPushSubscription.mockResolvedValue({ endpoint: 'https://web.push.apple.com/existing' })
      automaticActivationMock.getAutomaticNotificationsActivated.mockReturnValue(false)
      pushApiMock.subscribePush.mockRejectedValue(new Error('network down'))

      await mountSettings()
      await flush()

      expect(container.textContent).toContain('Notifications enabled')
      expect(container.textContent).not.toContain('network down')
      expect(automaticActivationMock.setAutomaticNotificationsActivated).not.toHaveBeenCalledWith(true)
    })

    it('marks activation on explicit Enable as well (a fresh subscription is activated immediately)', async () => {
      automaticActivationMock.getAutomaticNotificationsActivated.mockReturnValue(false)
      pushClientMock.requestNotificationPermission.mockResolvedValue('granted')
      const subscription = { endpoint: 'https://web.push.apple.com/abc', toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc' }) }
      pushClientMock.subscribeToPush.mockResolvedValue(subscription)
      pushApiMock.subscribePush.mockResolvedValue({ success: true, managementToken: 'fresh-management-token' })

      await mountSettings()
      await flush()
      await act(async () => { getByText('Enable notifications').closest('button').click() })

      expect(automaticActivationMock.setAutomaticNotificationsActivated).toHaveBeenCalledWith(true)
    })

    it('clears the local activation flag on disable, so a future re-enable re-activates', async () => {
      pushClientMock.requestNotificationPermission.mockResolvedValue('granted')
      const subscription = { endpoint: 'https://web.push.apple.com/abc', toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc' }) }
      pushClientMock.subscribeToPush.mockResolvedValue(subscription)
      pushApiMock.subscribePush.mockResolvedValue({ success: true, managementToken: 'fresh-management-token' })

      await mountSettings()
      await flush()
      await act(async () => { getByText('Enable notifications').closest('button').click() })

      pushClientMock.getExistingPushSubscription.mockResolvedValue(subscription)
      await act(async () => { getByText('Disable notifications').closest('button').click() })

      expect(automaticActivationMock.setAutomaticNotificationsActivated).toHaveBeenCalledWith(false)
    })
  })
})
