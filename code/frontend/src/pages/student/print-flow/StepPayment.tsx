import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/Icon'
import { Spinner } from '@/components/ui/Spinner'
import { orderApi } from '@/services/orderApi'
import { paymentApi } from '@/services/paymentApi'
import type { PaymentMethod, SafeOrder, SafePayment } from '@/types'
import { ApiError } from '@/types/api'
import { formatMoney } from '@/utils/money'
import { CheckoutClosedError, openRazorpayCheckout } from '@/utils/razorpayCheckout'

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

// Two backends are supported (see backend services/payments):
//  - mock: no payment window; confirm settles immediately. The dev-only
//    "simulate a failed payment" control exercises the backend's
//    simulateOutcome hook so the retry flow can be tested.
//  - Razorpay (test mode): the started payment carries `checkout` details;
//    Razorpay's own window takes the payment and its signed result is sent
//    to the backend, which verifies it before queueing the order.
export function StepPayment({ order, onPaid, onBack }: StepPaymentProps) {
  const [method, setMethod] = useState<PaymentMethod>('UPI')
  const [phase, setPhase] = useState<Phase>('choosing')
  const [error, setError] = useState<string | null>(null)
  const [simulateFailure, setSimulateFailure] = useState(false)

  async function handlePay() {
    setPhase('processing')
    setError(null)
    try {
      let payment: SafePayment | null | undefined
      try {
        payment = await paymentApi.initiate(order.orderId, method)
      } catch (err) {
        // 409 = a payment was already started for this order (the user left
        // this screen between "initiate" and "confirm", closed the payment
        // window, or double-clicked). Carry on with that pending payment
        // instead of looping on "Payment failed". If the order is not payable
        // at all, confirm fails too and the failure is shown as before.
        if (!(err instanceof ApiError && err.status === 409)) throw err
        payment = await paymentApi.getForOrder(order.orderId)
      }

      if (payment?.checkout) {
        const result = await openRazorpayCheckout({
          checkout: payment.checkout,
          description: `Order ${order.orderCode}`,
        })
        setPhase('processing')
        await paymentApi.confirm(order.orderId, result)
      } else {
        await paymentApi.confirm(order.orderId, simulateFailure ? 'FAILED' : undefined)
      }

      const refreshed = await orderApi.getOne(order.orderId)
      if (refreshed.orderStatus === 'QUEUED') {
        onPaid(refreshed)
      } else {
        setPhase('failed')
        setError('Payment failed. Please try again.')
      }
    } catch (err) {
      setPhase('failed')
      if (err instanceof CheckoutClosedError) {
        setError('Payment window closed before paying. Nothing was charged - you can try again.')
      } else if (err instanceof ApiError && (err.status === 400 || err.status === 503) && err.message) {
        // e.g. "Cash is not available for online payment" or a gateway outage.
        setError(`Payment failed: ${err.message}`)
      } else {
        setError('Payment failed. Please try again.')
      }
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
        <div className="option-grid">
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
        Payments are in test mode. No real money is charged.
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
