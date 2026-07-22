export default function ShowDetailSkeleton() {
  return (
    <div className="show-detail-skeleton animate-pulse">
      <div className="route-hero show-detail-hero content-surface mt-4">
        <div className="show-detail-hero__flow">
          <div className="show-detail-poster phase2-poster-frame skeleton-block h-32 w-24" />
          <div className="show-detail-skeleton__copy py-1">
            <div className="skeleton-block h-3 w-full rounded" />
            <div className="skeleton-block mt-2 h-3 w-11/12 rounded" />
            <div className="skeleton-block mt-2 h-3 w-full rounded" />
            <div className="skeleton-block mt-2 h-3 w-3/4 rounded" />
            <div className="skeleton-block mt-2 h-3 w-full rounded" />
            <div className="skeleton-block mt-2 h-3 w-2/3 rounded" />
          </div>
        </div>
      </div>

      <div className="detail-season-list mt-4">
        {[1, 2, 3].map((row) => (
          <div key={row} className="detail-season-row loki-record-row content-row flex items-center pl-3 pr-1">
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
