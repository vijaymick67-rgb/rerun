const TMDB_BASE_URL = 'https://api.themoviedb.org/3'

export default async function handler(req, res) {
  const apiKey = process.env.TMDB_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'TMDB_API_KEY is not configured' })
    return
  }

  const { path, ...query } = req.query
  const tmdbPath = Array.isArray(path) ? path.join('/') : (path ?? '')

  const url = new URL(`${TMDB_BASE_URL}/${tmdbPath}`)
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v)
    } else if (value !== undefined) {
      url.searchParams.set(key, value)
    }
  }
  url.searchParams.set('api_key', apiKey)

  let tmdbRes
  try {
    tmdbRes = await fetch(url)
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach TMDB', message: err.message })
    return
  }

  const body = await tmdbRes.text()
  res
    .status(tmdbRes.status)
    .setHeader(
      'Content-Type',
      tmdbRes.headers.get('content-type') ?? 'application/json',
    )
    .send(body)
}
