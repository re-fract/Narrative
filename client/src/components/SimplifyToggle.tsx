type SimplifyMode = 'original' | 'simplified'

interface SimplifyToggleProps {
  mode: SimplifyMode
  onChange: (mode: SimplifyMode) => void
  className?: string
}

const MODES: { key: SimplifyMode; label: string }[] = [
  { key: 'original', label: 'Original' },
  { key: 'simplified', label: 'Simplified' },
]

function SimplifyToggle({ mode, onChange, className = '' }: SimplifyToggleProps) {
  return (
    <div className={`inline-flex items-center rounded-full border border-outline-variant bg-surface p-1 ${className}`}>
      {MODES.map(({ key, label }) => {
        const active = mode === key
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`px-3 py-1 rounded-full font-label-md text-label-md transition-colors duration-200 whitespace-nowrap ${
              active
                ? 'bg-secondary text-on-secondary'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

export type { SimplifyMode }
export default SimplifyToggle
