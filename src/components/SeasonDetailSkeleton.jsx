function EpisodeRowSkeleton() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2">
      <div className="min-w-0 flex-1 py-1">
        <div className="h-3 w-2/3 rounded bg-(--color-surface-raised)" />
        <div className="mt-2 h-3 w-1/3 rounded bg-(--color-surface-raised)" />
      </div>
      <div className="h-8 w-24 shrink-0 rounded-md bg-(--color-surface-raised)" />
    </div>
  )
}

export default function SeasonDetailSkeleton() {
  return (
    <div className="mt-4 flex animate-pulse flex-col gap-2">
      <EpisodeRowSkeleton />
      <EpisodeRowSkeleton />
      <EpisodeRowSkeleton />
      <EpisodeRowSkeleton />
    </div>
  )
}
