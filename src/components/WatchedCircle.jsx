export default function WatchedCircle({ checked, disabled = false, label, onClick }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={checked}
      disabled={disabled}
      onClick={onClick}
      className="motion-press flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-(--color-accent) disabled:cursor-default"
    >
      <span className={`flex h-8 w-8 items-center justify-center rounded-full border-2 ${
        checked
          ? 'border-(--color-accent) bg-(--color-accent) text-(--color-bg)'
          : 'border-(--color-text-muted) text-transparent'
      } ${disabled ? 'opacity-35' : ''}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 4 4L19 6" />
        </svg>
      </span>
    </button>
  )
}
