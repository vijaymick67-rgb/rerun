export default function WatchingRowSkeleton() {
  return (
    <div className="flex animate-pulse gap-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-3">
      <div className="h-24 w-16 shrink-0 rounded-md bg-(--color-surface-raised)" />
      <div className="min-w-0 flex-1 py-1">
        <div className="h-3 w-3/4 rounded bg-(--color-surface-raised)" />
        <div className="mt-3 h-3 w-1/2 rounded bg-(--color-surface-raised)" />
      </div>
    </div>
  )
}
