import { describe, it, expect } from 'vitest'
import {
  emptyAnnouncementsState, sanitizeAnnouncementsState, readAnnouncementsCache,
  writeAnnouncementsCache, mergeAnnouncements, dismissAnnouncement, ANNOUNCEMENTS_CACHE_KEY,
} from './announcementStore.js'

const NOW = Date.parse('2026-07-23T00:00:00.000Z')

function item(overrides = {}) {
  return {
    id: 'ann:1|renewal|3', showId: 1, showName: 'From', eventType: 'renewal',
    seasonNumber: 3, publishedAt: '2026-07-20T00:00:00.000Z', ...overrides,
  }
}

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  }
}

describe('sanitizeAnnouncementsState', () => {
  it('resets a corrupt or wrong-version value to empty', () => {
    expect(sanitizeAnnouncementsState(null)).toEqual(emptyAnnouncementsState())
    expect(sanitizeAnnouncementsState({ version: 99, items: [] })).toEqual(emptyAnnouncementsState())
    expect(sanitizeAnnouncementsState({ version: 1, items: 'nope' })).toEqual(emptyAnnouncementsState())
  })

  it('drops invalid items, dedupes by id, and prunes stale', () => {
    const state = sanitizeAnnouncementsState({
      version: 1,
      items: [
        item(),
        item(), // duplicate id
        { id: 'x' }, // invalid (missing fields)
        item({ id: 'ann:2', publishedAt: '2020-01-01T00:00:00.000Z' }), // stale
      ],
      lastSuccess: NOW,
    }, NOW)
    expect(state.items).toHaveLength(1)
    expect(state.items[0].id).toBe('ann:1|renewal|3')
  })
})

describe('read/write cache', () => {
  it('round-trips through storage and tolerates malformed JSON', () => {
    const storage = memoryStorage()
    writeAnnouncementsCache({ version: 1, items: [item()], lastSuccess: NOW }, storage, NOW)
    expect(readAnnouncementsCache(storage, NOW).items).toHaveLength(1)

    storage.setItem(ANNOUNCEMENTS_CACHE_KEY, '{not json')
    expect(readAnnouncementsCache(storage, NOW)).toEqual(emptyAnnouncementsState())
  })
})

describe('mergeAnnouncements', () => {
  it('adds new events and replaces an id with a newer report', () => {
    const first = mergeAnnouncements(emptyAnnouncementsState(), [item()], NOW)
    expect(first.items).toHaveLength(1)
    const merged = mergeAnnouncements(first, [
      item({ publishedAt: '2026-07-22T00:00:00.000Z', showName: 'From (updated)' }),
      item({ id: 'ann:2', showId: 2, showName: 'You' }),
    ], NOW)
    expect(merged.items).toHaveLength(2)
    expect(merged.items.find((i) => i.id === 'ann:1|renewal|3').showName).toBe('From (updated)')
    expect(merged.lastSuccess).toBe(NOW)
  })

  it('persists a dismissal and never restores the event on a later merge', () => {
    const first = mergeAnnouncements(emptyAnnouncementsState(), [item()], NOW)
    const dismissed = dismissAnnouncement(first, item().id, NOW)
    expect(dismissed.items).toEqual([])
    expect(dismissed.dismissedIds).toContain(item().id)
    expect(mergeAnnouncements(dismissed, [item()], NOW).items).toEqual([])
  })
})
