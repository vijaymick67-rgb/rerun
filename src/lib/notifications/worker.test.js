import { describe, expect, it, vi } from 'vitest'
import { runNotificationWorker } from '../../../scripts/notifications/worker.js'

describe('notification worker safety gate', () => {
  it('exits before any network or database setup when disabled by default', async () => {
    const fetchImpl = vi.fn()
    const log = vi.fn()
    await expect(runNotificationWorker({ env: {}, fetchImpl, log })).resolves.toEqual({
      disabled: true,
      sent: 0,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disabled'))
  })
})
