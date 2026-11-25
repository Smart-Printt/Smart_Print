import type { ReactNode } from 'react'

import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/Icon'
import { Input, TextArea } from '@/components/ui/Input'
import type { FinishingType, PaperSize, PrintType, SafeDocument, SafeFinishingRule, Sides } from '@/types'
import { formatMoney } from '@/utils/money'
import { PrintIssuesNotice } from './PrintIssuesNotice'
import type { PrintSettings } from './types'

const PAPER_SIZES: PaperSize[] = ['A4', 'A3', 'A5', 'LETTER', 'LEGAL']
const FINISHING_LABEL: Record<FinishingType, string> = {
  NONE: 'None',
  SPIRAL_BINDING: 'Spiral binding',
  HARD_BINDING: 'Hard binding',
  STAPLING: 'Stapling',
  LAMINATION: 'Lamination',
}

function set<K extends keyof PrintSettings>(
  settings: PrintSettings,
  onChange: (s: PrintSettings) => void,
  key: K,
  value: PrintSettings[K],
) {
  onChange({ ...settings, [key]: value })
}

interface DocumentSettingsCardProps {
  document: SafeDocument
  settings: PrintSettings
  onChange: (settings: PrintSettings) => void
  onRemove?: () => void
  finishingOptions: SafeFinishingRule[]
}

// Renders the full set of independent print options for ONE document within
// a (possibly multi-document) order draft - see StepSettings, which renders
// one of these per selected document plus a single combined price panel.
export function DocumentSettingsCard({ document, settings, onChange, onRemove, finishingOptions }: DocumentSettingsCardProps) {
  return (
    <Card padded>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--color-primary-soft)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="documents" size={16} />
          </span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>{document.fileName}</div>
            {document.pageCount && <div className="text-muted" style={{ fontSize: 12 }}>{document.pageCount} pages</div>}
          </div>
        </div>
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${document.fileName} from this order`}
            onClick={onRemove}
            style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', display: 'flex', padding: 4 }}
          >
            <Icon name="trash" size={17} />
          </button>
        )}
      </div>

      <PrintIssuesNotice documentId={document.documentId} paperSize={settings.paperSize} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <SettingRow label="Print type">
          <Segmented
            value={settings.printType}
            options={[{ value: 'BW', label: 'Black & White' }, { value: 'COLOR', label: 'Color' }]}
            onChange={(v) => set(settings, onChange, 'printType', v as PrintType)}
          />
        </SettingRow>

        <SettingRow label="Sides">
          <Segmented
            value={settings.sides}
            options={[{ value: 'SINGLE', label: 'Single-sided' }, { value: 'DOUBLE', label: 'Double-sided' }]}
            onChange={(v) => set(settings, onChange, 'sides', v as Sides)}
          />
        </SettingRow>

        <SettingRow label="Paper size">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {PAPER_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className={`segmented__option ${settings.paperSize === size ? 'is-active' : ''}`}
                style={{ background: settings.paperSize === size ? 'var(--color-primary-soft)' : 'var(--color-surface-sunken)', color: settings.paperSize === size ? 'var(--color-primary)' : undefined }}
                onClick={() => set(settings, onChange, 'paperSize', size)}
              >
                {size}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow label="Copies">
          <div className="qty-control">
            <button
              className="qty-control__btn"
              type="button"
              disabled={settings.copies <= 1}
              onClick={() => set(settings, onChange, 'copies', Math.max(1, settings.copies - 1))}
              aria-label="Decrease copies"
            >
              <Icon name="minus" size={16} />
            </button>
            <span className="qty-control__value">{settings.copies}</span>
            <button
              className="qty-control__btn"
              type="button"
              disabled={settings.copies >= 100}
              onClick={() => set(settings, onChange, 'copies', Math.min(100, settings.copies + 1))}
              aria-label="Increase copies"
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
        </SettingRow>

        <SettingRow label="Page range">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Segmented
              value={settings.pageRangeMode}
              options={[{ value: 'all', label: 'All pages' }, { value: 'custom', label: 'Custom range' }]}
              onChange={(v) => set(settings, onChange, 'pageRangeMode', v as 'all' | 'custom')}
            />
            {settings.pageRangeMode === 'custom' && (
              <Input
                placeholder="e.g. 1-5, 8, 10-12"
                value={settings.pageRange}
                onChange={(e) => set(settings, onChange, 'pageRange', e.target.value)}
                hint={document.pageCount ? `This document has ${document.pageCount} pages.` : undefined}
              />
            )}
          </div>
        </SettingRow>

        {finishingOptions.length > 0 && (
          <SettingRow label="Finishing">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                className={`option-pill ${!settings.finishingRuleId ? 'is-active' : ''}`}
                onClick={() => onChange({ ...settings, finishingRuleId: null, finishingType: null })}
              >
                <span className="option-pill__title">None</span>
              </button>
              {finishingOptions
                .filter((r) => r.finishingType !== 'NONE')
                .map((rule) => (
                  <button
                    key={rule.finishingRuleId}
                    type="button"
                    className={`option-pill ${settings.finishingRuleId === rule.finishingRuleId ? 'is-active' : ''}`}
                    onClick={() =>
                      onChange({ ...settings, finishingRuleId: rule.finishingRuleId, finishingType: rule.finishingType })
                    }
                  >
                    <span className="option-pill__title">{FINISHING_LABEL[rule.finishingType]}</span>
                    <span className="option-pill__price">{formatMoney(rule.price)}/copy</span>
                  </button>
                ))}
            </div>
          </SettingRow>
        )}

        <SettingRow label="Special instructions (optional)">
          <TextArea
            placeholder="e.g. Please staple in the top-left corner"
            value={settings.specialInstructions}
            maxLength={500}
            onChange={(e) => set(settings, onChange, 'specialInstructions', e.target.value)}
          />
        </SettingRow>
      </div>
    </Card>
  )
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>{label}</div>
      {children}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`segmented__option ${value === opt.value ? 'is-active' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
