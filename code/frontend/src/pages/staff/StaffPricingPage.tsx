import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { SkeletonCardList } from '@/components/ui/Skeleton'
import { ErrorState, StateBlock } from '@/components/ui/StateBlock'
import { PageHeader } from '@/layouts/AppShell'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { pricingApi } from '@/services/pricingApi'
import { shopApi } from '@/services/shopApi'
import type { FinishingType, PaperSize, PrintType, SafeFinishingRule, SafePricingRule, SafeShop, Sides } from '@/types'
import { ApiError } from '@/types/api'
import { formatMoney } from '@/utils/money'

const PRINT_TYPES: PrintType[] = ['BW', 'COLOR']
const PAPER_SIZES: PaperSize[] = ['A4', 'A3', 'A5', 'LETTER', 'LEGAL']
const SIDES: Sides[] = ['SINGLE', 'DOUBLE']
const FINISHING_TYPES: FinishingType[] = ['NONE', 'SPIRAL_BINDING', 'HARD_BINDING', 'STAPLING', 'LAMINATION']

type Tab = 'current' | 'change' | 'history'

const TABS: { id: Tab; label: string }[] = [
  { id: 'current', label: 'Current rates' },
  { id: 'change', label: 'Change rates' },
  { id: 'history', label: 'History' },
]

interface RateInput {
  printType: PrintType
  paperSize: PaperSize
  sides: Sides
  pricePerPage: number
}

function printLabel(rule: SafePricingRule): string {
  return `${rule.printType === 'BW' ? 'B&W' : 'Color'} · ${rule.paperSize} · ${rule.sides === 'SINGLE' ? 'Single-sided' : 'Double-sided'}`
}

function sameCombo(
  a: Pick<SafePricingRule, 'printType' | 'paperSize' | 'sides'>,
  b: Pick<SafePricingRule, 'printType' | 'paperSize' | 'sides'>,
): boolean {
  return a.printType === b.printType && a.paperSize === b.paperSize && a.sides === b.sides
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function period(from: string, to: string | null): string {
  return to ? `${formatDay(from)} – ${formatDay(to)}` : `From ${formatDay(from)}`
}

// Staff pricing management, scoped to the logged-in staff member's own
// assigned shop only - there is deliberately no shop selector here (see
// AdminPricingPage.tsx for the ADMIN equivalent, which does let an admin
// pick any shop). shopId always comes from the authenticated user, never
// from anything the user could type into a URL or form - the backend
// (shopService.assertShopAccess) independently re-derives and enforces
// this on every request regardless of what the frontend sends.
//
// The page is split into three tabs so each job has its own space:
//   Current rates - what customers are charged right now
//   Change rates  - forms to set a new price / add a finishing option
//   History       - past (inactive) rules, which can be reactivated
export function StaffPricingPage() {
  const { user } = useAuth()
  const { showToast } = useToast()
  const shopId = user?.shopId ?? null

  const [tab, setTab] = useState<Tab>('current')
  const [shop, setShop] = useState<SafeShop | null>(null)
  const [pricingRules, setPricingRules] = useState<SafePricingRule[] | null>(null)
  const [finishingRules, setFinishingRules] = useState<SafeFinishingRule[] | null>(null)
  const [error, setError] = useState<unknown>(null)

  const loadRules = useCallback(async () => {
    if (!shopId) return
    setError(null)
    try {
      const [shopData, pricing, finishing] = await Promise.all([
        shopApi.getOne(shopId),
        pricingApi.listPricingRules(shopId, true),
        pricingApi.listFinishingRules(shopId, true),
      ])
      setShop(shopData)
      setPricingRules(pricing)
      setFinishingRules(finishing)
    } catch (err) {
      setError(err)
    }
  }, [shopId])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  const currentPricing = (pricingRules ?? []).filter((r) => r.isCurrentlyEffective)
  const pastPricing = (pricingRules ?? [])
    .filter((r) => !r.isCurrentlyEffective)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
  const currentFinishing = (finishingRules ?? []).filter((r) => r.isCurrentlyEffective)
  const pastFinishing = (finishingRules ?? []).filter((r) => !r.isCurrentlyEffective)

  async function handleDeactivatePricing(ruleId: string) {
    if (!shopId) return
    try {
      await pricingApi.deactivatePricingRule(shopId, ruleId)
      showToast('Pricing rule deactivated.', 'success')
      void loadRules()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not deactivate this rule.', 'error')
    }
  }

  // Pricing rules are date-ranged and the backend forbids two overlapping
  // rules for the same combination. So "set this price" = end the current
  // rule for that combination (if any), then open a new one starting now.
  // The old rule stays in History as an audit trail.
  async function setPricingRate(input: RateInput) {
    if (!shopId) return
    const existing = currentPricing.find((r) => sameCombo(r, input))
    if (existing) await pricingApi.deactivatePricingRule(shopId, existing.pricingRuleId)
    await pricingApi.createPricingRule(shopId, input)
  }

  async function handleReactivatePricing(rule: SafePricingRule) {
    try {
      await setPricingRate({
        printType: rule.printType,
        paperSize: rule.paperSize,
        sides: rule.sides,
        pricePerPage: Number(rule.pricePerPage),
      })
      showToast('Pricing rule reactivated.', 'success')
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not reactivate this rule.', 'error')
    }
    void loadRules()
  }

  async function handleToggleFinishing(rule: SafeFinishingRule) {
    if (!shopId) return
    try {
      await pricingApi.updateFinishingRule(shopId, rule.finishingRuleId, { isActive: !rule.isActive })
      showToast(rule.isActive ? 'Finishing rule disabled.' : 'Finishing rule enabled.', 'success')
      void loadRules()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not update this rule.', 'error')
    }
  }

  if (!shopId) {
    return (
      <div>
        <PageHeader title="Pricing" />
        <StateBlock
          icon="alert"
          title="No print shop assigned"
          description="Your staff account is not assigned to a print shop. Please contact an administrator."
        />
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Pricing" />
        <ErrorState error={error} onRetry={loadRules} />
      </div>
    )
  }

  const loading = pricingRules === null || finishingRules === null

  return (
    <div>
      <PageHeader title={shop ? shop.shopName : 'Pricing'} subtitle="Pricing & finishing rules for your shop." />

      <div
        className="segmented"
        role="tablist"
        aria-label="Pricing sections"
        style={{ marginBottom: 20, maxWidth: '100%', overflowX: 'auto' }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`segmented__option ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <SkeletonCardList count={3} height={64} />
      ) : tab === 'current' ? (
        <div className="split-grid">
          <section>
            <p style={{ fontWeight: 800, marginBottom: 12 }}>Print prices</p>
            <RuleList empty="No active print prices. Add one in the Change rates tab." count={currentPricing.length}>
              {currentPricing.map((rule) => (
                <RuleRow
                  key={rule.pricingRuleId}
                  title={printLabel(rule)}
                  detail={`${formatMoney(rule.pricePerPage)}/page · ${period(rule.effectiveFrom, rule.effectiveTo)}`}
                  badge={<Badge tone="success">Active</Badge>}
                  action={
                    <Button size="sm" variant="ghost" onClick={() => handleDeactivatePricing(rule.pricingRuleId)}>
                      Deactivate
                    </Button>
                  }
                />
              ))}
            </RuleList>
          </section>
          <section>
            <p style={{ fontWeight: 800, marginBottom: 12 }}>Finishing</p>
            <RuleList empty="No active finishing options. Add one in the Change rates tab." count={currentFinishing.length}>
              {currentFinishing.map((rule) => (
                <RuleRow
                  key={rule.finishingRuleId}
                  title={rule.finishingType.replace('_', ' ')}
                  detail={`${formatMoney(rule.price)}/copy`}
                  badge={<Badge tone="success">Active</Badge>}
                  action={
                    <Button size="sm" variant="ghost" onClick={() => handleToggleFinishing(rule)}>
                      Disable
                    </Button>
                  }
                />
              ))}
            </RuleList>
          </section>
        </div>
      ) : tab === 'change' ? (
        <div className="split-grid">
          <section>
            <p style={{ fontWeight: 800, marginBottom: 4 }}>Set a print price</p>
            <p className="text-muted" style={{ fontSize: 13, marginBottom: 12 }}>
              If this combination already has a price, it is replaced and the old one moves to History.
            </p>
            <SetPriceForm onSubmitRate={setPricingRate} onDone={loadRules} />
          </section>
          <section>
            <p style={{ fontWeight: 800, marginBottom: 4 }}>Add a finishing option</p>
            <p className="text-muted" style={{ fontSize: 13, marginBottom: 12 }}>
              Binding, stapling and lamination are priced per copy.
            </p>
            <CreateFinishingRuleForm shopId={shopId} onCreated={loadRules} />
          </section>
        </div>
      ) : (
        <div className="split-grid">
          <section>
            <p style={{ fontWeight: 800, marginBottom: 12 }}>Past print prices</p>
            <RuleList empty="No past print prices yet. Replaced or deactivated prices show up here." count={pastPricing.length}>
              {pastPricing.map((rule) => (
                <RuleRow
                  key={rule.pricingRuleId}
                  title={printLabel(rule)}
                  detail={`${formatMoney(rule.pricePerPage)}/page · ${period(rule.effectiveFrom, rule.effectiveTo)}`}
                  badge={<Badge tone="neutral">{new Date(rule.effectiveFrom) > new Date() ? 'Scheduled' : 'Inactive'}</Badge>}
                  action={
                    <Button size="sm" variant="ghost" onClick={() => handleReactivatePricing(rule)}>
                      Reactivate
                    </Button>
                  }
                />
              ))}
            </RuleList>
          </section>
          <section>
            <p style={{ fontWeight: 800, marginBottom: 12 }}>Past finishing options</p>
            <RuleList empty="No disabled finishing options." count={pastFinishing.length}>
              {pastFinishing.map((rule) => (
                <RuleRow
                  key={rule.finishingRuleId}
                  title={rule.finishingType.replace('_', ' ')}
                  detail={`${formatMoney(rule.price)}/copy`}
                  badge={<Badge tone="neutral">Inactive</Badge>}
                  action={
                    <Button size="sm" variant="ghost" onClick={() => handleToggleFinishing(rule)}>
                      Enable
                    </Button>
                  }
                />
              ))}
            </RuleList>
          </section>
        </div>
      )}
    </div>
  )
}

function RuleList({ children, empty, count }: { children: ReactNode; empty: string; count: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {count > 0 ? children : <p className="text-muted" style={{ fontSize: 13.5 }}>{empty}</p>}
    </div>
  )
}

function RuleRow({ title, detail, badge, action }: { title: string; detail: string; badge: ReactNode; action: ReactNode }) {
  return (
    <Card padded>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 13.5 }}>{title}</span>
          <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{detail}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {badge}
          {action}
        </div>
      </div>
    </Card>
  )
}

function SetPriceForm({ onSubmitRate, onDone }: { onSubmitRate: (input: RateInput) => Promise<void>; onDone: () => void }) {
  const { showToast } = useToast()
  const [printType, setPrintType] = useState<PrintType>('BW')
  const [paperSize, setPaperSize] = useState<PaperSize>('A4')
  const [sides, setSides] = useState<Sides>('SINGLE')
  const [pricePerPage, setPricePerPage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!pricePerPage) return
    setIsSubmitting(true)
    try {
      await onSubmitRate({ printType, paperSize, sides, pricePerPage: Number(pricePerPage) })
      setPricePerPage('')
      showToast('Print price saved.', 'success')
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not save this print price.', 'error')
    } finally {
      setIsSubmitting(false)
      onDone()
    }
  }

  return (
    <Card padded>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', alignItems: 'end' }}>
        <div className="field">
          <label className="field__label">Print type</label>
          <select className="input" value={printType} onChange={(e) => setPrintType(e.target.value as PrintType)}>
            {PRINT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="field__label">Paper</label>
          <select className="input" value={paperSize} onChange={(e) => setPaperSize(e.target.value as PaperSize)}>
            {PAPER_SIZES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="field__label">Sides</label>
          <select className="input" value={sides} onChange={(e) => setSides(e.target.value as Sides)}>
            {SIDES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <Input label="Price/page" type="number" min="0" step="0.01" value={pricePerPage} onChange={(e) => setPricePerPage(e.target.value)} />
        <Button type="submit" isLoading={isSubmitting}>Save price</Button>
      </form>
    </Card>
  )
}

function CreateFinishingRuleForm({ shopId, onCreated }: { shopId: string; onCreated: () => void }) {
  const { showToast } = useToast()
  const [finishingType, setFinishingType] = useState<FinishingType>('SPIRAL_BINDING')
  const [price, setPrice] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!shopId || !price) return
    setIsSubmitting(true)
    try {
      await pricingApi.createFinishingRule(shopId, { finishingType, price: Number(price) })
      setPrice('')
      showToast('Finishing rule added.', 'success')
      onCreated()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not create this finishing rule.', 'error')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Card padded>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', alignItems: 'end' }}>
        <div className="field">
          <label className="field__label">Finishing type</label>
          <select className="input" value={finishingType} onChange={(e) => setFinishingType(e.target.value as FinishingType)}>
            {FINISHING_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
          </select>
        </div>
        <Input label="Price/copy" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
        <Button type="submit" isLoading={isSubmitting}>Add Finishing Rule</Button>
      </form>
    </Card>
  )
}
