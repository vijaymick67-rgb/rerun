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

import * as backupMock from '../lib/backup'
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
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
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
  it('shows "Coming soon" for episode notifications as a non-interactive row', async () => {
    await mountSettings()
    expect(container.textContent).toContain('Episode notifications')
    expect(container.textContent).toContain('Coming soon')

    const label = getByText('Episode notifications')
    expect(label.closest('button')).toBeNull()
    expect(label.closest('a')).toBeNull()
  })
})
