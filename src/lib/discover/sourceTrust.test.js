import { describe, it, expect } from 'vitest'
import { resolveSourceTrust, isTrustedTrade, TRUST_TIER } from './sourceTrust.js'

describe('resolveSourceTrust', () => {
  it('classifies official press hosts as Tier 1', () => {
    expect(resolveSourceTrust({ canonicalUrl: 'https://press.hbo.com/x' })).toBe(TRUST_TIER.OFFICIAL)
    expect(resolveSourceTrust({ canonicalUrl: 'https://about.netflix.com/en/news/x' })).toBe(TRUST_TIER.OFFICIAL)
    expect(resolveSourceTrust({ sourceName: 'Marvel' })).toBe(TRUST_TIER.OFFICIAL)
  })

  it('classifies reputable trades as Tier 2 by host or name', () => {
    expect(resolveSourceTrust({ canonicalUrl: 'https://deadline.com/2026/x' })).toBe(TRUST_TIER.TRADE)
    expect(resolveSourceTrust({ sourceName: 'Deadline' })).toBe(TRUST_TIER.TRADE)
    expect(resolveSourceTrust({ sourceName: 'The Hollywood Reporter' })).toBe(TRUST_TIER.TRADE)
    expect(resolveSourceTrust({ sourceName: 'TVLine' })).toBe(TRUST_TIER.TRADE)
  })

  it('classifies unknown sources as Tier 3', () => {
    expect(resolveSourceTrust({ canonicalUrl: 'https://randomblog.example.com/x', sourceName: 'Random Blog' }))
      .toBe(TRUST_TIER.OTHER)
  })

  it('does not let a spoofed host inherit a trade tier via substring', () => {
    expect(resolveSourceTrust({ canonicalUrl: 'https://notdeadline.example.com/x' })).toBe(TRUST_TIER.OTHER)
    expect(resolveSourceTrust({ canonicalUrl: 'https://deadline.com.evil.example/x' })).toBe(TRUST_TIER.OTHER)
  })

  it('matches a press subdomain on a dot boundary', () => {
    expect(resolveSourceTrust({ canonicalUrl: 'https://press.disneyplus.com/news' })).toBe(TRUST_TIER.OFFICIAL)
  })

  it('isTrustedTrade is true for tiers 1 and 2 only', () => {
    expect(isTrustedTrade({ sourceName: 'Variety' })).toBe(true)
    expect(isTrustedTrade({ sourceName: 'HBO' })).toBe(true)
    expect(isTrustedTrade({ sourceName: 'Some Fan Site' })).toBe(false)
  })
})
