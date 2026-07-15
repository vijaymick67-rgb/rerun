import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { isVisibleInWatching } from '../../src/lib/finishedShows.js'
import { buildNotificationPlan } from '../../src/lib/notifications/plan.js'
import { executeNotificationPlan } from '../../src/lib/notifications/execute.js'
import { publishNtfy } from '../../src/lib/notifications/ntfy.js'
import { episodeKey } from '../../src/lib/watchHelpers.js'
import { getShowReleaseMap } from '../../src/lib/tvmaze.js'
import { fetchWatchedEpisodes } from '../../src/lib/watchedEpisodes.js'
import {
  loadWatchingShowData,
  selectTrackedShowsForWatching,
} from '../../src/lib/watchingShows.js'
import { createDeliveryStore } from './deliveryStore.js'
import { createServerTmdbClient } from './tmdbServer.js'

const IST_FORMAT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'long', hour12: true,
})

function required(env, name) {
  if (!env[name]) throw new Error(`${name} is required`)
  return env[name]
}

export function formatDecision(decision) {
  const episode = Number.isInteger(decision.seasonNumber)
    ? ` S${decision.seasonNumber}E${decision.episodeNumber}`
    : ''
  const release = decision.release
    ? ` availability=${IST_FORMAT.format(new Date(decision.release.timestamp))} IST platform=${decision.release.platform} dateSource=${decision.release.dateSource}`
    : ''
  return `${decision.reason}: ${decision.showName} [TMDB ${decision.tmdbShowId}]${episode}${release}`
}

export async function loadNotificationInputs({ supabase, tmdb }) {
  const { data: trackedShows, error: trackedError } = await supabase
    .from('tracked_shows')
    .select('*')
    .order('added_at', { ascending: false })
  if (trackedError) throw trackedError

  const releaseMap = (tmdbId) => getShowReleaseMap(tmdbId, { getExternalIds: tmdb.getExternalIds })
  const { candidates, preloadedById } = await selectTrackedShowsForWatching(
    trackedShows ?? [], tmdb.getShowDetails, releaseMap,
  )
  const ids = candidates.map((show) => show.tmdb_id)
  const watchedRows = ids.length
    ? await fetchWatchedEpisodes(
        supabase, 'tmdb_show_id, season_number, episode_number', ids,
      )
    : []
  const watchedByShowId = new Map(ids.map((id) => [id, new Set()]))
  for (const row of watchedRows) {
    watchedByShowId.get(row.tmdb_show_id)?.add(episodeKey(row.season_number, row.episode_number))
  }

  const shows = await Promise.all(candidates.map(async (show) => {
    const watched = watchedByShowId.get(show.tmdb_id) ?? new Set()
    const loaded = await loadWatchingShowData(show, watched, preloadedById.get(show.tmdb_id), {
      getShowDetails: tmdb.getShowDetails,
      getSeasonEpisodes: tmdb.getSeasonEpisodes,
      getShowReleaseMap: releaseMap,
    })
    return {
      ...show,
      details: loaded.details,
      poster_path: show.poster_path ?? loaded.details?.poster_path ?? null,
      episodesBySeason: loaded.episodesBySeason,
      watched,
      loadError: loaded.loadError,
      status: loaded.status,
    }
  }))

  const visible = shows.filter((show) => isVisibleInWatching(show, show.status))
  if (visible.length === 0) return { shows, delivered: new Set() }
  const { data: deliveries, error: deliveryError } = await supabase
    .from('notification_deliveries')
    .select('identity')
    .not('delivered_at', 'is', null)
    .in('tmdb_show_id', visible.map((show) => show.tmdb_id))
  if (deliveryError) throw deliveryError
  return { shows, delivered: new Set((deliveries ?? []).map((row) => row.identity)) }
}

export async function runNotificationWorker({ env = process.env, fetchImpl = fetch, now = new Date(), log = console.log } = {}) {
  const dryRun = env.RERUN_NOTIFICATIONS_DRY_RUN === 'true'
  const enabled = env.RERUN_NOTIFICATIONS_ENABLED === 'true'
  if (!enabled && !dryRun) {
    log('Rerun notifications are disabled; exiting without network pushes or delivery writes.')
    return { disabled: true, sent: 0 }
  }

  const supabase = createClient(
    required(env, 'SUPABASE_URL'),
    required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const tmdb = createServerTmdbClient(required(env, 'TMDB_API_KEY'), fetchImpl)
  const inputs = await loadNotificationInputs({ supabase, tmdb })
  const plan = buildNotificationPlan({ ...inputs, now: now.getTime() })
  for (const decision of plan.decisions) log(formatDecision(decision))

  return executeNotificationPlan({
    plan,
    enabled,
    dryRun,
    deliveryStore: createDeliveryStore(supabase, () => now),
    publish: (notification) => publishNtfy(notification, {
      topic: required(env, 'NTFY_TOPIC'), fetchImpl,
    }),
    log: ({ notification }) => log(`wouldNotify: ${notification.title}\n${notification.body}`),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNotificationWorker().catch((error) => {
    console.error(`Notification worker failed: ${error?.message ?? 'unknown error'}`)
    process.exitCode = 1
  })
}
