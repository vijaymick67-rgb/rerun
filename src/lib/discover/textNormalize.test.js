import { describe, it, expect } from 'vitest'
import {
  normalizeText,
  stripLeadingArticle,
  containsPhrase,
  neighboursOfPhrase,
  hasQuotedTitle,
  hasPossessiveBeforeTitle,
} from './textNormalize.js'

describe('normalizeText', () => {
  it('folds case, accents, and punctuation to a bounded token stream', () => {
    expect(normalizeText('Café Society!')).toBe('cafe society')
    expect(normalizeText('The Handmaid’s Tale')).toBe('the handmaid s tale')
    expect(normalizeText('WandaVision')).toBe('wandavision')
  })

  it('expands a literal ampersand to " and " only', () => {
    expect(normalizeText('Will & Grace')).toBe('will and grace')
    expect(normalizeText('Law and Order')).toBe('law and order')
  })

  it('returns empty string for non-strings', () => {
    expect(normalizeText(null)).toBe('')
    expect(normalizeText(undefined)).toBe('')
    expect(normalizeText(42)).toBe('')
  })

  it('contains no residual whitespace runs', () => {
    expect(normalizeText('  The   Bear  ')).toBe('the bear')
  })
})

describe('stripLeadingArticle', () => {
  it('removes a single leading article as a secondary form', () => {
    expect(stripLeadingArticle('the last of us')).toBe('last of us')
    expect(stripLeadingArticle('a man on the inside')).toBe('man on the inside')
  })

  it('never empties a title that is only an article', () => {
    expect(stripLeadingArticle('the')).toBe('the')
  })

  it('leaves non-article-led titles untouched', () => {
    expect(stripLeadingArticle('industry')).toBe('industry')
  })
})

describe('containsPhrase (bounded whole-word matching)', () => {
  it('matches a title only on word boundaries', () => {
    expect(containsPhrase('industry renewed for season 3', 'industry')).toBe(true)
    expect(containsPhrase('industrywide layoffs reported', 'industry')).toBe(false)
    expect(containsPhrase('the bearer of bad news', 'bear')).toBe(false)
  })

  it('matches multi-word phrases contiguously', () => {
    expect(containsPhrase('the last of us season 3 premieres', 'the last of us')).toBe(true)
    expect(containsPhrase('last night of us all', 'the last of us')).toBe(false)
  })
})

describe('neighboursOfPhrase', () => {
  it('reports the touching words on each side', () => {
    const [n] = neighboursOfPhrase('from renewed for season 4', 'from')
    expect(n.before).toBe(null)
    expect(n.after).toBe('renewed')
  })
})

describe('hasQuotedTitle / hasPossessiveBeforeTitle (raw-text evidence)', () => {
  it('detects a quoted title in the raw headline', () => {
    expect(hasQuotedTitle("'From' renewed for Season 4", 'from')).toBe(true)
    expect(hasQuotedTitle('From renewed for Season 4', 'from')).toBe(false)
  })

  it('detects a possessive platform construction', () => {
    expect(hasPossessiveBeforeTitle("Netflix's You returns", 'you')).toBe(true)
    expect(hasPossessiveBeforeTitle('You returns to Netflix', 'you')).toBe(false)
  })
})
