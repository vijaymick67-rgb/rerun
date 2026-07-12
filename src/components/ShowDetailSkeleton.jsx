export default function ShowDetailSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="mt-4 flex gap-3">
        <div className="h-32 w-24 shrink-0 rounded-md bg-(--color-surface-raised)" />
        <div className="min-w-0 flex-1 py-1">
          <div className="h-3 w-1/3 rounded bg-(--color-surface-raised)" />
          <div className="mt-2 h-3 w-1/2 rounded bg-(--color-surface-raised)" />
          <div className="mt-4 h-1 w-full rounded-full bg-(--color-surface-raised)" />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <div className="h-11 rounded-lg border border-(--color-border) bg-(--color-surface)" />
        <div className="h-11 rounded-lg border border-(--color-border) bg-(--color-surface)" />
        <div className="h-11 rounded-lg border border-(--color-border) bg-(--color-surface)" />
      </div>
    </div>
  )
}
