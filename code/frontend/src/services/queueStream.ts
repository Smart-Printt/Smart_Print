import { ApiError } from '@/types/api'
import type { SafeQueueEntry } from '@/types'

import { fetchAuthorizedStream } from './apiClient'

export interface SseFrame {
  event: string
  data: string
}

// Incremental Server-Sent-Events parser: feed it text chunks as they arrive
// and it calls onFrame for every complete frame (frames end with a blank
// line). Comment lines (": ping" heartbeats) produce no frame.
export function createSseParser(onFrame: (frame: SseFrame) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string) => {
    buffer = (buffer + chunk).replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      let event = 'message'
      const data: string[] = []
      for (const line of raw.split('\n')) {
        if (line === '' || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length > 0 || event !== 'message') {
        onFrame({ event, data: data.join('\n') })
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

export interface QueueStreamHandlers {
  onEntry: (entry: SafeQueueEntry) => void
  onOpen?: () => void
  onClose?: () => void
}

const RECONNECT_DELAY_MS = 5000
// The user can't use the stream at all (not signed in, not their order):
// retrying would never help, so give up and let normal polling take over.
const GIVE_UP_STATUSES = [401, 403, 404]

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// Subscribes to live updates for one order's queue entry. Reconnects on its
// own after a dropped connection; returns a function that stops everything.
export function subscribeToQueue(orderId: string, handlers: QueueStreamHandlers): () => void {
  const controller = new AbortController()
  const { signal } = controller
  let finished = false

  async function run() {
    while (!signal.aborted && !finished) {
      try {
        const response = await fetchAuthorizedStream(`/orders/${encodeURIComponent(orderId)}/queue/stream`, signal)
        handlers.onOpen?.()

        const feed = createSseParser((frame) => {
          if (frame.event === 'queue') {
            try {
              handlers.onEntry(JSON.parse(frame.data) as SafeQueueEntry)
            } catch {
              // Ignore a malformed frame; the next one (or polling) corrects it.
            }
          } else if (frame.event === 'end') {
            finished = true
          }
        })

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          feed(decoder.decode(value, { stream: true }))
        }
      } catch (err) {
        if (signal.aborted) return
        if (err instanceof ApiError && GIVE_UP_STATUSES.includes(err.status)) {
          finished = true
        }
      }

      handlers.onClose?.()
      if (signal.aborted || finished) return
      await wait(RECONNECT_DELAY_MS, signal)
    }
  }

  void run()
  return () => controller.abort()
}
