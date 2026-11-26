export interface RankedBarRow {
  key: string
  name: string
  value: number
  // Secondary line under the name ("₹1,240.00 · median wait 4 min").
  detail?: string
}

interface RankedBarsProps {
  rows: RankedBarRow[]
  unit: string
  ariaLabel: string
}

// Ranked horizontal bars on one baseline: a name, a bar and the figure per
// row, bars aligned, one hue, largest first (the caller sorts). The bar is
// thin (10px) with a rounded end; the figure sits at the bar's tip side so
// every value is readable without hovering.
export function RankedBars({ rows, unit, ariaLabel }: RankedBarsProps) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul aria-label={ariaLabel} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.map((row) => (
        <li key={row.key}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <span style={{ fontWeight: 700, fontSize: 14, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.name}
            </span>
            <span style={{ fontWeight: 800, fontSize: 14 }}>
              {row.value} <span className="text-muted" style={{ fontWeight: 600, fontSize: 12 }}>{unit}</span>
            </span>
          </div>
          <div style={{ marginTop: 6, height: 10 }} aria-hidden>
            <div
              title={`${row.name}: ${row.value} ${unit}`}
              style={{
                width: `${(row.value / max) * 100}%`,
                minWidth: row.value > 0 ? 4 : 0,
                height: '100%',
                background: 'var(--color-primary)',
                borderRadius: '0 4px 4px 0',
              }}
            />
          </div>
          {row.detail && (
            <p className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
              {row.detail}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}
