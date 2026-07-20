export default function WatchingRowSkeleton() {
  return (
    <div className="content-row flex animate-pulse gap-3 p-3">
      <div className="skeleton-block h-24 w-16 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1 py-1">
        <div className="skeleton-block h-3 w-3/4 rounded" />
        <div className="skeleton-block mt-3 h-3 w-1/2 rounded" />
      </div>
    </div>
  )
}
