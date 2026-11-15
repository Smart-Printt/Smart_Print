import type { CheckoutDetails, RazorpayCheckoutResult } from '@/types'

// Razorpay Checkout: Razorpay's own payment window. Card/UPI details are
// typed into Razorpay's page, never into SmartPrint.
const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js'

interface RazorpayHandlerResponse {
  razorpay_order_id: string
  razorpay_payment_id: string
  razorpay_signature: string
}

interface RazorpayInstance {
  open(): void
  on(event: 'payment.failed', handler: () => void): void
}

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor
  }
}

export class CheckoutClosedError extends Error {
  constructor() {
    super('Payment window closed')
    this.name = 'CheckoutClosedError'
  }
}

let loading: Promise<RazorpayConstructor> | null = null

function loadScript(): Promise<RazorpayConstructor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay)
  if (!loading) {
    loading = new Promise<RazorpayConstructor>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = SCRIPT_URL
      script.async = true
      script.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay did not load')))
      script.onerror = () => {
        loading = null
        reject(new Error('Could not load the payment window. Check your internet connection.'))
      }
      document.body.appendChild(script)
    })
  }
  return loading
}

interface OpenCheckoutOptions {
  checkout: CheckoutDetails
  description: string
  prefill?: { name?: string; email?: string }
}

// Opens the window and resolves with the signed result after a successful
// payment. Rejects with CheckoutClosedError if the student closes it.
// (A failed attempt is shown inside Razorpay's window, which lets the student
// try again there, so it is not treated as the end of the payment.)
export async function openRazorpayCheckout({
  checkout,
  description,
  prefill,
}: OpenCheckoutOptions): Promise<RazorpayCheckoutResult> {
  const Razorpay = await loadScript()
  return new Promise<RazorpayCheckoutResult>((resolve, reject) => {
    const instance = new Razorpay({
      key: checkout.keyId,
      amount: checkout.amount,
      currency: checkout.currency,
      order_id: checkout.gatewayOrderId,
      name: 'SmartPrint',
      description,
      prefill,
      theme: { color: '#4338ff' },
      handler: (response: RazorpayHandlerResponse) =>
        resolve({
          razorpayOrderId: response.razorpay_order_id,
          razorpayPaymentId: response.razorpay_payment_id,
          razorpaySignature: response.razorpay_signature,
        }),
      modal: { ondismiss: () => reject(new CheckoutClosedError()) },
    })
    instance.open()
  })
}
