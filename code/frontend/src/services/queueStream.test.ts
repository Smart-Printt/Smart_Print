import { describe, expect, it, vi } from 'vitest'

import { createSseParser } from './queueStream'
import type { SseFrame } from './queueStream'

function collect(chunks: string[]): SseFrame[] {
  const frames: SseFrame[] = []
  const feed = createSseParser((frame) => frames.push(frame))
  chunks.forEach(feed)
  return frames
}

describe('createSseParser', () => {
  it('parses a complete frame', () => {
    expect(collect(['event: queue\ndata: {"position":2}\n\n'])).toEqual([
      { event: 'queue', data: '{"position":2}' },
    ])
  })

  it('reassembles a frame split across chunks, even mid-line', () => {
    expect(collect(['event: qu', 'eue\ndata: {"a"', ':1}\n', '\n'])).toEqual([{ event: 'queue', data: '{"a":1}' }])
  })

  it('handles several frames in one chunk', () => {
    const frames = collect(['event: queue\ndata: 1\n\nevent: end\ndata: {}\n\n'])
    expect(frames.map((f) => f.event)).toEqual(['queue', 'end'])
  })

  it('ignores heartbeat comments and the retry hint', () => {
    expect(collect([': ping\n\n', 'retry: 5000\n\n'])).toEqual([])
  })

  it('accepts CRLF line endings, including a CR/LF split across chunks', () => {
    expect(collect(['event: queue\r\ndata: x\r', '\n\r\n'])).toEqual([{ event: 'queue', data: 'x' }])
  })

  it('joins multi-line data and defaults the event name to "message"', () => {
    expect(collect(['data: a\ndata: b\n\n'])).toEqual([{ event: 'message', data: 'a\nb' }])
  })

  it('does not emit a frame until the blank line arrives', () => {
    const onFrame = vi.fn()
    const feed = createSseParser(onFrame)
    feed('event: queue\ndata: 1\n')
    expect(onFrame).not.toHaveBeenCalled()
    feed('\n')
    expect(onFrame).toHaveBeenCalledTimes(1)
  })
})
