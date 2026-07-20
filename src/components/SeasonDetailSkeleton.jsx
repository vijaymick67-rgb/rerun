function EpisodeRowSkeleton() {
  return (
    <div className="content-row season-episode-row flex items-center gap-2 px-3 py-1.5">
      <div className="season-episode-copy min-w-0 flex-1 py-1">
        <div className="skeleton-block h-3 w-2/3 rounded" />
        <div className="skeleton-block mt-2 h-3 w-1/3 rounded" />
      </div>
      <div className="flex h-11 w-11 shrink-0 items-center justify-center">
        <div className="skeleton-block h-8 w-8 rounded-full" />
      </div>
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
