import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { SkeletonCardList } from '@/components/ui/Skeleton'
import { ErrorState } from '@/components/ui/StateBlock'
import { PageHeader } from '@/layouts/AppShell'
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

export function AdminPricingPage() {
  const { showToast } = useToast()
  const [shops, setShops] = useState<SafeShop[]>([])
  const [shopId, setShopId] = useState('')
  const [pricingRules, setPricingRules] = useState<SafePricingRule[] | null>(null)
  const [finishingRules, setFinishingRules] = useState<SafeFinishingRule[] | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    shopApi.list().then((list) => {
      setShops(list)
      if (list[0]) setShopId(list[0].shopId)
    })
  }, [])

  async function loadRules() {
    if (!shopId) return
    setError(null)
    try {
      const [pricing, finishing] = await Promise.all([
        pricingApi.listPricingRules(shopId, true),
        pricingApi.listFinishingRules(shopId, true),
      ])
      setPricingRules(pricing)
      setFinishingRules(finishing)
    } catch (err) {
      setError(err)
    }
  }

  useEffect(() => {
    setPricingRules(null)
    setFinishingRules(null)
    void loadRules()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId])

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

  async function handleToggleFinishing(rule: SafeFinishingRule) {
    if (!shopId) return
    try {
      await pricingApi.updateFinishingRule(shopId, rule.finishingRuleId, { isActive: !rule.isActive })
      showToast('Finishing rule updated.', 'success')
      void loadRules()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not update this rule.', 'error')
    }
  }

  return (
    <div>
      <PageHeader title="Pricing" subtitle="Per-shop pricing and finishing rules." />

      <div className="field" style={{ maxWidth: 320, marginBottom: 24 }}>
        <label className="field__label">Shop</label>
        <select className="input" value={shopId} onChange={(e) => setShopId(e.target.value)}>
          {shops.map((shop) => (
            <option key={shop.shopId} value={shop.shopId}>
              {shop.shopName}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={loadRules} />
      ) : (
        <div className="split-grid">
          <div>
            <p style={{ fontWeight: 800, marginBottom: 12 }}>Pricing rules</p>
            {pricingRules === null ? (
              <SkeletonCardList count={2} height={64} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                {pricingRules.map((rule) => (
                  <Card key={rule.pricingRuleId} padded>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 13.5 }}>
                          {rule.printType === 'BW' ? 'B&W' : 'Color'} · {rule.paperSize} · {rule.sides === 'SINGLE' ? 'Single' : 'Double'}
                        </span>
                        <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{formatMoney(rule.pricePerPage)}/page</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Badge tone={rule.isCurrentlyEffective ? 'success' : 'neutral'}>
                          {rule.isCurrentlyEffective ? 'Active' : 'Inactive'}
                        </Badge>
                        {rule.isCurrentlyEffective && (
                          <Button size="sm" variant="ghost" onClick={() => handleDeactivatePricing(rule.pricingRuleId)}>
                            Deactivate
                          </Button>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
            <CreatePricingRuleForm shopId={shopId} onCreated={loadRules} />
          </div>

          <div>
            <p style={{ fontWeight: 800, marginBottom: 12 }}>Finishing rules</p>
            {finishingRules === null ? (
              <SkeletonCardList count={2} height={64} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                {finishingRules.map((rule) => (
                  <Card key={rule.finishingRuleId} padded>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{rule.finishingType.replace('_', ' ')}</span>
                        <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{formatMoney(rule.price)}/copy</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Badge tone={rule.isCurrentlyEffective ? 'success' : 'neutral'}>
                          {rule.isCurrentlyEffective ? 'Active' : 'Inactive'}
                        </Badge>
                        <Button size="sm" variant="ghost" onClick={() => handleToggleFinishing(rule)}>
                          {rule.isActive ? 'Disable' : 'Enable'}
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
            <CreateFinishingRuleForm shopId={shopId} onCreated={loadRules} />
          </div>
        </div>
      )}
    </div>
  )
}

function CreatePricingRuleForm({ shopId, onCreated }: { shopId: string; onCreated: () => void }) {
  const { showToast } = useToast()
  const [printType, setPrintType] = useState<PrintType>('BW')
  const [paperSize, setPaperSize] = useState<PaperSize>('A4')
  const [sides, setSides] = useState<Sides>('SINGLE')
  const [pricePerPage, setPricePerPage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!shopId || !pricePerPage) return
    setIsSubmitting(true)
    try {
      await pricingApi.createPricingRule(shopId, { printType, paperSize, sides, pricePerPage: Number(pricePerPage) })
      setPricePerPage('')
      showToast('Pricing rule created.', 'success')
      onCreated()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not create this pricing rule.', 'error')
    } finally {
      setIsSubmitting(false)
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
        <Button type="submit" isLoading={isSubmitting}>Add Rule</Button>
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
      showToast('Finishing rule created.', 'success')
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
        <Button type="submit" isLoading={isSubmitting}>Add Rule</Button>
      </form>
    </Card>
  )
}
