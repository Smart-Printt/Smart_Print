import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/Icon'
import { Spinner } from '@/components/ui/Spinner'
import { orderApi } from '@/services/orderApi'
import { paymentApi } from '@/services/paymentApi'
import type { PaymentMethod, SafeOrder } from '@/types'
import { ApiError } from '@/types/api'
import { formatMoney } from '@/utils/money'

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'UPI', label: 'UPI' },
  { value: 'CARD', label: 'Card' },
  { value: 'WALLET', label: 'Wallet' },
  { value: 'CASH', label: 'Cash on pickup' },
]

type Phase = 'choosing' | 'processing' | 'failed'

interface StepPaymentProps {
  order: SafeOrder
  onPaid: (order: SafeOrder) => void
  onBack: () => void
}

// This is a mock/test payment provider (see backend payments service) - the
// UI never claims a real gateway like Razorpay or a bank connection. The
// dev-only "simulate a failed payment" control exercises the same
// simulateOutcome hook the backend already exposes outside production, so
// the retry flow can be tested without it succeeding by default.
export function StepPayment({ order, onPaid, onBack }: StepPaymentProps) {
  const [method, setMethod] = useState<PaymentMethod>('UPI')
  const [phase, setPhase] = useState<Phase>('choosing')
  const [error, setError] = useState<string | null>(null)
  const [simulateFailure, setSimulateFailure] = useState(false)

  async function handlePay() {
    setPhase('processing')
    setError(null)
    try {
      try {
        await paymentApi.initiate(order.orderId, method)
      } catch (err) {
        // 409 = a payment was already started for this order (the user left
        // this screen between "initiate" and "confirm", or double-clicked).
        // Carry on and confirm that pending payment instead of looping on
        // "Payment failed". If the order is not payable at all, confirm
        // fails too and the failure is shown as before.
        if (!(err instanceof ApiError && err.status === 409)) throw err
      }
      await paymentApi.confirm(order.orderId, simulateFailure ? 'FAILED' : undefined)
      const refreshed = await orderApi.getOne(order.orderId)
      if (refreshed.orderStatus === 'QUEUED') {
        onPaid(refreshed)
      } else {
        setPhase('failed')
        setError('Payment failed. Please try again.')
      }
    } catch {
      setPhase('failed')
      setError('Payment failed. Please try again.')
    }
  }

  if (phase === 'processing') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '60px 20px' }}>
        <Spinner size={32} />
        <p style={{ fontWeight: 700 }}>Processing payment…</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card padded style={{ textAlign: 'center' }}>
        <p className="text-muted" style={{ fontSize: 12.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Amount to pay
        </p>
        <p style={{ fontFamily: "'Manrope', sans-serif", fontSize: 40, fontWeight: 800, margin: '6px 0' }}>
          {formatMoney(order.totalAmount)}
        </p>
        <p className="text-muted" style={{ fontSize: 13 }}>Order {order.orderCode}</p>
      </Card>

      {phase === 'failed' && (
        <div className="auth-error-banner" role="alert">
          <Icon name="xCircle" size={17} />
          <span>{error}</span>
        </div>
      )}

      <div>
        <p style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>Payment method</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {METHODS.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`option-pill ${method === m.value ? 'is-active' : ''}`}
              onClick={() => setMethod(m.value)}
            >
              <span className="option-pill__title">{m.label}</span>
            </button>
          ))}
        </div>
      </div>

      {import.meta.env.DEV && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--color-text-muted)' }}>
          <input type="checkbox" checked={simulateFailure} onChange={(e) => setSimulateFailure(e.target.checked)} />
          Simulate a failed payment (dev/test only)
        </label>
      )}

      <p className="text-muted" style={{ fontSize: 12, textAlign: 'center' }}>
        This is a test payment system for development. No real money is charged.
      </p>

      <div style={{ display: 'flex', gap: 10 }}>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button block size="lg" onClick={handlePay}>
          {phase === 'failed' ? 'Retry Payment' : `Pay ${formatMoney(order.totalAmount)}`}
        </Button>
      </div>
    </div>
  )
}
