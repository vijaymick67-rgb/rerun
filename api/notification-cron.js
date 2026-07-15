import { runNotificationWorker } from '../scripts/notifications/worker.js'

export const config = { runtime: 'nodejs' }

const SECRET_ENV_NAMES = [
  'CRON_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TMDB_API_KEY',
  'NTFY_TOPIC',
]

function json(res, status, body) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.json(body)
}

function safeErrorMessage(error, env) {
  let message = error instanceof Error ? error.message : String(error)
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name]
    if (typeof value === 'string' && value !== '') message = message.replaceAll(value, '[REDACTED]')
  }
  return message
}

export function createNotificationCronHandler({
  env = process.env,
  runWorker = runNotificationWorker,
  now = () => new Date(),
  log = console.log,
  errorLog = console.error,
} = {}) {
  return async function notificationCronHandler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      json(res, 405, { success: false, error: 'Method not allowed' })
      return
    }

    const secret = env.CRON_SECRET
    const authorization = req.headers?.authorization
    if (typeof secret !== 'string' || secret.trim() === '' || authorization !== `Bearer ${secret}`) {
      json(res, 401, { success: false, error: 'Unauthorized' })
      return
    }

    try {
      const result = await runWorker({ env, now: now(), log })
      json(res, 200, {
        success: true,
        sent: Number(result?.sent ?? 0),
        disabled: result?.disabled === true,
        dryRun: result?.dryRun === true,
      })
    } catch (error) {
      errorLog('notification_cron_failed', {
        name: error instanceof Error ? error.name : 'Error',
        message: safeErrorMessage(error, env),
      })
      json(res, 500, { success: false, error: 'Notification worker failed' })
    }
  }
}

export default createNotificationCronHandler()

