export default function WatchingTileSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="aspect-[2/3] w-full rounded-lg bg-(--color-surface-raised)" />
      <div className="mt-1.5 h-3 w-3/4 rounded bg-(--color-surface-raised)" />
      <div className="mt-1.5 h-3 w-1/2 rounded bg-(--color-surface-raised)" />
    </div>
  )
}
