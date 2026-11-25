import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import jsQR from 'jsqr'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { OrderStatusBadge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/hooks/useToast'
import { orderApi } from '@/services/orderApi'
import { queueApi } from '@/services/queueApi'
import type { SafeOrder } from '@/types'
import { ApiError } from '@/types/api'

interface PickupScannerProps {
  // Called after an order has been handed over, so the page can refresh.
  onCollected?: () => void
}

// Staff pickup desk. The student's QR code simply encodes their order code,
// so there are three equivalent ways in: scan with the camera, use a
// handheld scanner (it types the code into the box and presses Enter), or
// type the code. The lookup is scoped server-side to the staff member's own
// shop, and handing over only works for an order that is READY.
export function PickupScanner({ onCollected }: PickupScannerProps) {
  const { showToast } = useToast()

  const [code, setCode] = useState('')
  const [isLooking, setIsLooking] = useState(false)
  const [found, setFound] = useState<SafeOrder | null>(null)
  const [isCollecting, setIsCollecting] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<number | null>(null)

  const stopCamera = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setIsScanning(false)
  }, [])

  useEffect(() => stopCamera, [stopCamera])

  const lookUp = useCallback(
    async (rawCode: string) => {
      const trimmed = rawCode.trim()
      if (!trimmed) return
      setIsLooking(true)
      try {
        setFound(await orderApi.getByCode(trimmed))
        setCode('')
      } catch (err) {
        showToast(
          err instanceof ApiError && err.status === 404
            ? 'No order with that code at your shop.'
            : err instanceof ApiError
              ? err.message
              : 'Could not look up that order.',
          'error',
        )
      } finally {
        setIsLooking(false)
      }
    },
    [showToast],
  )

  async function startCamera() {
    setCameraError(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser cannot use the camera here. Type the code instead.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      setIsScanning(true)
    } catch {
      setCameraError('Camera access was blocked. Allow it in the browser, or type the code instead.')
    }
  }

  // Once the <video> element exists, attach the stream and scan frames.
  useEffect(() => {
    if (!isScanning) return
    const video = videoRef.current
    const canvas = canvasRef.current
    const stream = streamRef.current
    if (!video || !canvas || !stream) return

    video.srcObject = stream
    void video.play().catch(() => undefined)

    function tick() {
      if (!video || !canvas) return
      if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          const image = context.getImageData(0, 0, canvas.width, canvas.height)
          const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
          if (result?.data) {
            stopCamera()
            void lookUp(result.data)
            return
          }
        }
      }
      frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [isScanning, lookUp, stopCamera])

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    void lookUp(code)
  }

  async function handleConfirm() {
    if (!found) return
    setIsCollecting(true)
    try {
      await queueApi.collect(found.orderId)
      showToast(`${found.orderCode} handed over.`, 'success')
      setFound(null)
      onCollected?.()
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not mark this order as collected.', 'error')
    } finally {
      setIsCollecting(false)
    }
  }

  const isReady = found?.orderStatus === 'READY'

  return (
    <>
      <Card padded style={{ marginBottom: 20 }}>
        <p
          className="text-muted"
          style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}
        >
          Pickup desk
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px' }}>
            <Input
              label="Order code"
              placeholder="Scan the QR or type e.g. SP-LXK3F9-A1B2"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button type="submit" isLoading={isLooking} disabled={code.trim().length === 0}>
            Find order
          </Button>
          <Button type="button" variant="secondary" onClick={isScanning ? stopCamera : () => void startCamera()}>
            <Icon name="qr" size={15} />
            {isScanning ? 'Stop camera' : 'Scan QR'}
          </Button>
        </form>

        {cameraError && (
          <p role="alert" className="text-secondary" style={{ fontSize: 13, marginTop: 10, color: 'var(--color-danger)' }}>
            {cameraError}
          </p>
        )}

        {isScanning && (
          <div style={{ marginTop: 14, maxWidth: 360 }}>
            <video
              ref={videoRef}
              muted
              playsInline
              aria-label="Camera preview"
              style={{ width: '100%', borderRadius: 12, background: '#000' }}
            />
            <canvas ref={canvasRef} hidden />
            <p className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
              Hold the student's QR code in front of the camera.
            </p>
          </div>
        )}
      </Card>

      <Modal isOpen={found !== null} title="Confirm pickup" onClose={() => setFound(null)}>
        {found && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <p style={{ fontWeight: 800, fontSize: 18 }}>{found.orderCode}</p>
              <OrderStatusBadge status={found.orderStatus} />
            </div>
            <p className="text-secondary" style={{ fontSize: 13.5, marginTop: 4 }}>
              {found.customerName} · {found.shopName}
            </p>
            <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--color-text-secondary)' }}>
              {found.items.map((item) => (
                <li key={item.orderDocumentId}>
                  {item.fileName} — {item.printPageCount} pages × {item.copies}
                </li>
              ))}
            </ul>
            {!isReady && (
              <p role="alert" style={{ fontSize: 13.5, marginTop: 12, color: 'var(--color-danger)', fontWeight: 600 }}>
                {found.orderStatus === 'COLLECTED'
                  ? 'This order has already been collected.'
                  : 'This order is not ready for pickup yet.'}
              </p>
            )}
            <div className="modal__actions" style={{ marginTop: 18 }}>
              <Button variant="secondary" onClick={() => setFound(null)} disabled={isCollecting}>
                Close
              </Button>
              {isReady && (
                <Button onClick={() => void handleConfirm()} isLoading={isCollecting}>
                  Confirm handover
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
