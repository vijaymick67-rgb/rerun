export default function ShowDetailSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="mt-4 flex gap-3">
        <div className="skeleton-block h-32 w-24 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1 py-1">
          <div className="skeleton-block h-3 w-1/3 rounded" />
          <div className="skeleton-block mt-2 h-3 w-1/2 rounded" />
          <div className="skeleton-block mt-4 h-1 w-full rounded-full" />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {[1, 2, 3].map((row) => (
          <div key={row} className="surface-card flex items-center pl-3 pr-1">
            <div className="flex min-w-0 flex-1 items-center py-3 pr-2">
              <div className="skeleton-block h-3 w-24 rounded" />
            </div>
            <div className="flex h-11 w-11 shrink-0 items-center justify-center">
              <div className="skeleton-block h-8 w-8 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
