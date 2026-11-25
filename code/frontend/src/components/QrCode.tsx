import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

interface QrCodeProps {
  value: string
  size?: number
  label?: string
}

// Renders `value` as a QR code image. Always drawn dark-on-white (with a
// white quiet-zone border) regardless of theme - scanners need the contrast.
export function QrCode({ value, size = 176, label }: QrCodeProps) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setSrc(url)
      })
      .catch(() => {
        if (!cancelled) setSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [value, size])

  if (!src) {
    return <div style={{ width: size, height: size, borderRadius: 12, background: 'var(--color-surface-sunken)' }} />
  }

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={label ?? `QR code for ${value}`}
      style={{ background: '#fff', borderRadius: 12, padding: 6, display: 'block' }}
    />
  )
}
