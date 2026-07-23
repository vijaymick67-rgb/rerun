// Announcement normalization (Scope H). Turns an accepted classifier result +
// its source article + the tracked-show identity into a stable public model,
// independent of the publisher's headline wording, with concise generated copy.
//
// We never invent facts absent from the evidence. If a season number is unknown
// it is omitted from the copy rather than guessed.

import { normalizeText } from './textNormalize.js'

function eventLabel(eventType) {
  switch (eventType) {
    case 'renewal': return 'Renewed'
    case 'season_date': return 'Premiere date'
    case 'cancellation': return 'Cancelled'
    case 'cast_addition': return 'New cast'
    default: return 'Update'
  }
}

function seasonPhrase(seasonNumber) {
  return seasonNumber ? `Season ${seasonNumber}` : null
}

// Concise, wording-independent detail line derived only from extracted facts.
function buildDetail({ eventType, showName, seasonNumber, premiereDate, releaseWindow, personName }) {
  const season = seasonPhrase(seasonNumber)
  switch (eventType) {
    case 'renewal':
      return season ? `${showName} will return for ${season}` : `${showName} has been renewed`
    case 'cancellation':
      return season ? `${showName} will not return for ${season}` : `${showName} will not return`
    case 'season_date': {
      const when = premiereDate || releaseWindow
      const subject = season ? `${showName} ${season}` : showName
      return when ? `${subject} premieres ${when}` : `${subject} has a premiere date`
    }
    case 'cast_addition': {
      const target = season ? `${showName} ${season}` : showName
      return personName ? `${personName} joins ${target}` : `A new cast member joins ${target}`
    }
    default:
      return showName
  }
}

// Stable event identity for deduplication (Scope I). Same real-world event ->
// same key regardless of which publisher reported it.
export function announcementEventKey({ showId, eventType, seasonNumber, personName }) {
  switch (eventType) {
    case 'renewal':
      return `${showId}|renewal|${seasonNumber ?? '?'}`
    case 'cancellation':
      return `${showId}|cancellation`
    case 'season_date':
      return `${showId}|season_date|${seasonNumber ?? '?'}`
    case 'cast_addition':
      return `${showId}|cast_addition|${normalizeText(personName ?? '')}|${seasonNumber ?? '?'}`
    default:
      return `${showId}|${eventType}`
  }
}

export function normalizeAnnouncement(result, article, identity) {
  if (!result?.accepted) return null
  const showName = result.showName ?? identity?.canonicalTitle ?? ''
  const payload = {
    showId: result.showId,
    showName,
    eventType: result.eventType,
    seasonNumber: result.seasonNumber ?? null,
    premiereDate: result.premiereDate ?? null,
    releaseWindow: result.releaseWindow ?? null,
    personName: result.personName ?? null,
  }
  return {
    id: `ann:${announcementEventKey(payload)}`,
    ...payload,
    posterPath: identity?.posterPath ?? article?.posterPath ?? null,
    label: eventLabel(result.eventType),
    headline: buildDetail({ ...payload, showName }),
    detail: buildDetail({ ...payload, showName }),
    sourceName: article?.sourceName ?? null,
    sourceUrl: article?.canonicalUrl ?? article?.url ?? null,
    publishedAt: article?.publishedAt ?? null,
    confidence: result.confidence ?? 0,
  }
}
