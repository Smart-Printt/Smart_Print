import { useState } from 'react'

import { niceMax } from './scale'

export interface ColumnDatum {
  key: string
  // Short axis label ("12 Oct", "9 AM").
  label: string
  // Full wording for the tooltip and screen readers ("Mon, 12 Oct").
  fullLabel: string
  value: number
}

interface ColumnChartProps {
  data: ColumnDatum[]
  // What one unit is called in the tooltip ("orders").
  unit: string
  ariaLabel: string
  // Show every n-th x label so they never collide.
  labelEvery?: number
  // Draw this column in the accent colour and the rest in the quiet tint
  // (emphasis: "this one is the story"). Omit for a plain single series.
  highlightKey?: string | null
  height?: number
}

const AXIS_WIDTH = 34

// One-series column chart in plain HTML/CSS: thin columns (<= 24px) with a
// rounded top and a square baseline, hairline recessive gridlines, a hover /
// focus tooltip per column, and a roomy hit area (the whole column slot, not
// just the painted bar). Text uses text tokens, never the series colour.
export function ColumnChart({ data, unit, ariaLabel, labelEvery = 1, highlightKey = null, height = 170 }: ColumnChartProps) {
  const [active, setActive] = useState<number | null>(null)
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)))
  const ticks = [max, max / 2, 0]
  const activeDatum = active !== null ? data[active] : null

  const align = active === null ? 'center' : active < data.length * 0.15 ? 'left' : active > data.length * 0.85 ? 'right' : 'center'

  return (
    <div role="group" aria-label={ariaLabel} style={{ position: 'relative', paddingLeft: AXIS_WIDTH }}>
      <div style={{ position: 'relative', height }}>
        {ticks.map((tick) => (
          <div
            key={tick}
            style={{
              position: 'absolute',
              left: -AXIS_WIDTH,
              right: 0,
              bottom: `${(tick / max) * 100}%`,
              display: 'flex',
              alignItems: 'center',
              pointerEvents: 'none',
            }}
          >
            <span
              className="text-muted"
              style={{ width: AXIS_WIDTH - 8, textAlign: 'right', fontSize: 11, transform: 'translateY(50%)', lineHeight: 1 }}
            >
              {tick}
            </span>
            <span style={{ flex: 1, marginLeft: 8, height: 1, background: 'var(--color-border)' }} />
          </div>
        ))}

        <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
          {data.map((d, i) => {
            const isActive = active === i
            const isHighlight = highlightKey === null || highlightKey === d.key
            const color = isActive
              ? 'var(--color-primary-hover)'
              : isHighlight
                ? 'var(--color-primary)'
                : 'var(--color-primary-soft-strong)'
            return (
              <div
                key={d.key}
                tabIndex={0}
                aria-label={`${d.fullLabel}: ${d.value} ${unit}`}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive((cur) => (cur === i ? null : cur))}
                onFocus={() => setActive(i)}
                onBlur={() => setActive((cur) => (cur === i ? null : cur))}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                  padding: '0 1px',
                  outline: 'none',
                  background: isActive ? 'var(--color-surface-sunken)' : 'transparent',
                  borderRadius: 6,
                }}
              >
                <div
                  style={{
                    width: '100%',
                    maxWidth: 24,
                    height: `${(d.value / max) * 100}%`,
                    minHeight: d.value > 0 ? 2 : 0,
                    background: color,
                    borderRadius: '4px 4px 0 0',
                  }}
                />
              </div>
            )
          })}
        </div>

        {activeDatum && active !== null && (
          <div
            role="status"
            style={{
              position: 'absolute',
              top: -6,
              left: align === 'left' ? 0 : align === 'right' ? undefined : `${((active + 0.5) / data.length) * 100}%`,
              right: align === 'right' ? 0 : undefined,
              transform: `translate(${align === 'center' ? '-50%' : '0'}, -100%)`,
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border-strong)',
              borderRadius: 10,
              padding: '8px 10px',
              boxShadow: '0 6px 18px rgba(20,22,43,0.12)',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              zIndex: 2,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 12, height: 3, borderRadius: 2, background: 'var(--color-primary)' }} />
              <span style={{ fontWeight: 800, fontSize: 15 }}>{activeDatum.value}</span>
              <span className="text-secondary" style={{ fontSize: 12.5 }}>{unit}</span>
            </div>
            <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{activeDatum.fullLabel}</div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', marginTop: 6 }} aria-hidden>
        {data.map((d, i) => (
          <div key={d.key} style={{ flex: 1, minWidth: 0, textAlign: 'center', position: 'relative', height: 16 }}>
            {i % labelEvery === 0 && (
              <span
                className="text-muted"
                style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', fontSize: 11, whiteSpace: 'nowrap' }}
              >
                {d.label}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
