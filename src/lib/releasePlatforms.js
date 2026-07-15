export const RELEASE_PLATFORMS = Object.freeze({
  hbo: { thresholdHourIST: 8, thresholdMinuteIST: 0 },
  mgm: { thresholdHourIST: 8, thresholdMinuteIST: 0 },
  apple: { thresholdHourIST: 8, thresholdMinuteIST: 0 },
  prime: { thresholdHourIST: 14, thresholdMinuteIST: 0 },
  netflix: { thresholdHourIST: 14, thresholdMinuteIST: 0 },
  disney: { thresholdHourIST: 14, thresholdMinuteIST: 0 },
  hulu: { thresholdHourIST: 14, thresholdMinuteIST: 0 },
  peacock: { thresholdHourIST: 16, thresholdMinuteIST: 0 },
  unknown: { thresholdHourIST: 18, thresholdMinuteIST: 0 },
})

const PLATFORM_ALIASES = [
  { platform: 'hbo', priority: 100, aliases: ['hbo', 'max', 'hbo max'] },
  { platform: 'mgm', priority: 95, aliases: ['mgm+'] },
  { platform: 'hulu', priority: 90, aliases: ['hulu', 'fx', 'fx on hulu'] },
  { platform: 'apple', priority: 80, aliases: ['apple tv+', 'apple tv'] },
  { platform: 'disney', priority: 70, aliases: ['disney+', 'disney plus'] },
  { platform: 'netflix', priority: 60, aliases: ['netflix'] },
  { platform: 'peacock', priority: 50, aliases: ['peacock'] },
  { platform: 'prime', priority: 40, aliases: ['amazon prime video', 'prime video'] },
]

function normalizedNetworkNames(showDetails) {
  return (showDetails?.networks ?? [])
    .map((network) => typeof network === 'string' ? network : network?.name)
    .filter(Boolean)
    .map((name) => name.trim().toLowerCase())
}

export function classifyReleasePlatform(showDetails) {
  const names = normalizedNetworkNames(showDetails)
  let match = null
  for (const entry of PLATFORM_ALIASES) {
    if (entry.aliases.some((alias) => names.includes(alias))) {
      if (!match || entry.priority > match.priority) match = entry
    }
  }
  const platform = match?.platform ?? 'unknown'
  return {
    platform,
    ...RELEASE_PLATFORMS[platform],
    confidence: match ? 'mapped' : 'fallback',
  }
}
