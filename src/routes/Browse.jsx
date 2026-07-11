import { useEffect, useRef, useState } from 'react'
import { searchShows } from '../lib/tmdb'
import { supabase } from '../lib/supabase'

const POSTER_BASE = 'https://image.tmdb.org/t/p/w342'
const DEBOUNCE_MS = 400
const UNIQUE_VIOLATION = '23505'

export default function Browse() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [searched, setSearched] = useState(false)
  const [trackedIds, setTrackedIds] = useState(new Set())
  const [addingIds, setAddingIds] = useState(new Set())
  const debounceRef = useRef(null)

  useEffect(() => {
    let ignore = false
    supabase
      .from('tracked_shows')
      .select('tmdb_id')
      .then(({ data, error: fetchError }) => {
        if (ignore || fetchError || !data) return
        setTrackedIds(new Set(data.map((row) => row.tmdb_id)))
      })
    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    clearTimeout(debounceRef.current)

    if (!query.trim()) {
      setResults([])
      setSearched(false)
      setError(null)
      setLoading(false)
      return
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await searchShows(query.trim())
        setResults(data)
      } catch {
        setError('Search failed. Try again.')
        setResults([])
      } finally {
        setSearched(true)
        setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(debounceRef.current)
  }, [query])

  async function handleAdd(show) {
    setAddingIds((prev) => new Set(prev).add(show.id))

    const { error: insertError } = await supabase.from('tracked_shows').insert({
      tmdb_id: show.id,
      name: show.name,
      poster_path: show.poster_path,
      added_at: new Date().toISOString(),
    })

    setAddingIds((prev) => {
      const next = new Set(prev)
      next.delete(show.id)
      return next
    })

    if (!insertError || insertError.code === UNIQUE_VIOLATION) {
      setTrackedIds((prev) => new Set(prev).add(show.id))
    }
  }

  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold text-(--color-text)">Browse</h1>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a show…"
        className="mt-3 w-full rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2 text-(--color-text) placeholder:text-(--color-text-muted) focus:outline-none focus:border-(--color-accent)"
      />

      {loading && (
        <p className="mt-4 text-sm text-(--color-text-muted)">Searching…</p>
      )}

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {!loading && !error && !query.trim() && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          Search for a show
        </p>
      )}

      {!loading && !error && searched && query.trim() && results.length === 0 && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          No results
        </p>
      )}

      {!loading && !error && results.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {results.map((show) => {
            const isTracked = trackedIds.has(show.id)
            const isAdding = addingIds.has(show.id)
            const year = show.first_air_date
              ? show.first_air_date.slice(0, 4)
              : null

            return (
              <div
                key={show.id}
                className="overflow-hidden rounded-lg bg-(--color-surface)"
              >
                {show.poster_path ? (
                  <img
                    src={POSTER_BASE + show.poster_path}
                    alt={show.name}
                    className="aspect-2/3 w-full object-cover"
                  />
                ) : (
                  <div className="flex aspect-2/3 w-full items-center justify-center bg-(--color-surface-raised) text-xs text-(--color-text-muted)">
                    No poster
                  </div>
                )}

                <div className="p-2">
                  <p className="truncate text-sm font-medium text-(--color-text)">
                    {show.name}
                  </p>
                  <p className="text-xs text-(--color-text-muted)">
                    {year ?? 'Unknown year'}
                  </p>

                  <button
                    type="button"
                    onClick={() => handleAdd(show)}
                    disabled={isTracked || isAdding}
                    className={`mt-2 w-full rounded-md py-1.5 text-sm font-medium ${
                      isTracked
                        ? 'bg-(--color-surface-raised) text-(--color-text-muted)'
                        : 'bg-(--color-accent) text-(--color-bg) disabled:opacity-60'
                    }`}
                  >
                    {isTracked ? 'Added' : isAdding ? 'Adding…' : 'Add'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
