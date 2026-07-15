export async function executeNotificationPlan({
  plan,
  enabled = false,
  dryRun = false,
  deliveryStore,
  publish,
  log = () => {},
}) {
  if (!enabled && !dryRun) return { disabled: true, sent: 0 }
  const notifications = [...(plan.notifications ?? []), ...(plan.watchReminders ?? [])]
  if (dryRun) {
    for (const notification of notifications) {
      log({
        type: notification.notificationType === 'episode_watch_reminder'
          ? 'wouldNotifyWatchReminder' : 'wouldNotifyAvailability',
        notification,
      })
    }
    return { dryRun: true, sent: 0 }
  }

  let sent = 0
  for (const notification of notifications) {
    const claimed = await deliveryStore.claim(notification)
    if (claimed.length === 0) continue
    const claimedSet = new Set(claimed)
    const selected = notification.episodes.filter((episode) => claimedSet.has(episode.identity))
    const sendable = {
      ...notification,
      episodes: selected,
      title: selected.length === 1
        ? `${notification.showName} — New episode`
        : `${notification.showName} — ${selected.length} new episodes`,
      body: selected.map((episode) => {
        const prefix = `S${episode.seasonNumber}E${episode.episodeNumber}`
        return episode.name ? `${prefix} · ${episode.name}` : prefix
      }).join('\n'),
    }
    try {
      await publish(sendable)
    } catch (error) {
      await deliveryStore.release(claimed)
      throw error
    }
    await deliveryStore.complete(claimed)
    sent += 1
  }
  return { sent }
}

