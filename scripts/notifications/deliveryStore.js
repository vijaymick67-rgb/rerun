Exit code: 0
Wall time: 3.2 seconds
Output:
import { randomUUID } from 'node:crypto'

export function createDeliveryStore(supabase, now = () => new Date()) {
  const claims = new Map()

  return {
    async claim(notification) {
      const token = randomUUID()
      const episodes = notification.episodes.map((episode) => ({
        season_number: episode.seasonNumber,
        episode_number: episode.episodeNumber,
        notification_type: notification.notificationType ?? 'episode_available',
      }))
      const { data, error } = await supabase.rpc('claim_episode_notification_deliveries', {
        p_tmdb_show_id: notification.tmdbShowId,
        p_episodes: episodes,
        p_claim_token: token,
        p_claimed_at: now().toISOString(),
      })
      if (error) throw error
      const identities = (data ?? []).map((row) => row.identity)
      for (const identity of identities) claims.set(identity, token)
      return identities
    },

    async complete(identities) {
      if (identities.length === 0) return
      const token = claims.get(identities[0])
      const { error } = await supabase
        .from('notification_deliveries')
        .update({ delivered_at: now().toISOString(), claim_token: null })
        .eq('claim_token', token)
        .in('identity', identities)
      if (error) throw error
      for (const identity of identities) claims.delete(identity)
    },

    async release(identities) {
      if (identities.length === 0) return
      const token = claims.get(identities[0])
      const { error } = await supabase
        .from('notification_deliveries')
        .delete()
        .eq('claim_token', token)
        .is('delivered_at', null)
        .in('identity', identities)
      if (error) throw error
      for (const identity of identities) claims.delete(identity)
    },
  }
}

