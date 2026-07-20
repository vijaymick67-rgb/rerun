const PLACEHOLDER_CARDS = [0, 1, 2, 3]

export default function BrowseResultsSkeleton() {
  return (
    <section className="mt-5" aria-hidden="true">
      <div className="h-4 w-28 animate-pulse rounded bg-(--color-surface-raised)" />
      <div className="mt-2 grid grid-cols-2 gap-3">
        {PLACEHOLDER_CARDS.map((i) => (
          <div key={i} className="poster-card animate-pulse">
            <div className="aspect-2/3 w-full bg-(--color-surface-raised)" />
            <div className="p-2">
              <div className="h-3 w-4/5 rounded bg-(--color-surface-raised)" />
              <div className="mt-1.5 h-3 w-1/3 rounded bg-(--color-surface-raised)" />
              <div className="mt-2 h-8 w-full rounded-md bg-(--color-surface-raised)" />
              <div className="mt-1.5 h-7 w-full rounded-md bg-(--color-surface-raised)" />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
