// A single-word title (Sugar, Beef, You, From, Dark, Lucky…) is inherently ambiguous —
// it can only match when the headline names it AND the surrounding text carries real
// TV-production context. Multi-word titles are distinctive enough to match directly.
const CONTEXT_SIGNAL = /\b(?:season|seasons|series|episode|episodes|premiere|premieres|premiered|renew|renews|renewed|renewal|cancel|cancels|cancelled|canceled|cancellation|trailer|showrunner|finale|spinoff|streaming|stream|cast|casts|casting|network|debut|debuts|greenlit|greenlight|revival|reboot|hbo|max|netflix|apple tv|prime video|disney|hulu|peacock|paramount|fx|amc|showtime|starz|bbc|itv|mgm)\b/

export function normalizeNewsText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
    : ''
}

function titleVariants(show) {
  const raw = [show?.name, show?.title, show?.original_name, show?.originalTitle,
    ...(Array.isArray(show?.alternateTitles) ? show.alternateTitles : [])]
  return [...new Set(raw.map(normalizeNewsText).filter(Boolean))]
}

function phraseIn(text, phrase) {
  return (` ${text} `).includes(` ${phrase} `)
}

function titleInHeadline(headline, title) {
  return phraseIn(headline, title)
}

export function matchArticleToTrackedShow(article, trackedShows = []) {
  if (!article || typeof article !== 'object' || !normalizeNewsText(article.title)) {
    return { matched: false, showId: null, showName: null, confidence: 'none' }
  }
  const headline = normalizeNewsText(article.title)
  const body = normalizeNewsText(`${article.description ?? ''} ${article.sourceName ?? ''}`)
  const candidates = []

  for (const show of Array.isArray(trackedShows) ? trackedShows : []) {
    const variants = titleVariants(show)
    for (const variant of variants) {
      const words = variant.split(' ')
      const headlineMatch = titleInHeadline(headline, variant)
      const contextMatch = phraseIn(body, variant)
      const isWeakTitle = words.length === 1
      if (isWeakTitle) {
        if (!headlineMatch || !CONTEXT_SIGNAL.test(`${headline} ${body}`)) continue
      } else if (!headlineMatch && !contextMatch) {
        continue
      }
      candidates.push({
        show,
        variant,
        headlineMatch,
        score: (headlineMatch ? 1000 : 100) + words.length * 20 + variant.length,
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score || String(a.show?.tmdb_id ?? a.show?.id)
    .localeCompare(String(b.show?.tmdb_id ?? b.show?.id)))
  const best = candidates[0]
  return best ? {
    matched: true,
    showId: best.show?.tmdb_id ?? best.show?.id ?? null,
    showName: best.show?.name ?? best.show?.title ?? best.variant,
    confidence: 'high',
  } : { matched: false, showId: null, showName: null, confidence: 'none' }
}
