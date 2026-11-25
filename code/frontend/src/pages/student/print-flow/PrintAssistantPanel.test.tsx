import '@testing-library/jest-dom/vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appendTranscript, speechErrorMessage } from '@/hooks/useSpeechRecognition'
import type { PrintAssistantResult } from '@/types'
import { PrintAssistantPanel } from './PrintAssistantPanel'

const mockInterpret = vi.fn()
vi.mock('@/services/assistantApi', () => ({
  assistantApi: { interpretPrintRequest: (message: string, ids: string[]) => mockInterpret(message, ids) },
}))

// A stand-in for the browser's speech engine that tests can drive by hand.
class FakeRecognition {
  static last: FakeRecognition | null = null
  lang = ''
  continuous = true
  interimResults = false
  maxAlternatives = 0
  onresult: ((e: unknown) => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => this.onend?.())
  abort = vi.fn()
  constructor() {
    FakeRecognition.last = this
  }
  hear(transcript: string, isFinal: boolean) {
    this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal, 0: { transcript } } } })
  }
}

const RESULT: PrintAssistantResult = {
  settings: { copies: 1, sides: 'DOUBLE' },
  shopId: 'shop-1',
  shopName: 'G Block Print',
  finishingRuleId: null,
  estimatedTotal: '20.00',
  notes: [],
  source: 'rules',
}

function installSpeech() {
  ;(window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition
}
function removeSpeech() {
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition
}

beforeEach(() => {
  vi.clearAllMocks()
  FakeRecognition.last = null
})
afterEach(removeSpeech)

describe('appendTranscript / speechErrorMessage', () => {
  it('joins with one space and respects the length limit', () => {
    expect(appendTranscript('', ' two copies ', 100)).toBe('two copies')
    expect(appendTranscript('two copies', 'double sided', 100)).toBe('two copies double sided')
    expect(appendTranscript('abc', 'defgh', 6)).toBe('abc de')
    expect(appendTranscript('keep', '   ', 100)).toBe('keep')
  })

  it('gives plain-language messages, and says nothing for a self-initiated stop', () => {
    expect(speechErrorMessage('not-allowed')).toMatch(/blocked/i)
    expect(speechErrorMessage('no-speech')).toMatch(/didn’t hear/)
    expect(speechErrorMessage('audio-capture')).toMatch(/No microphone/)
    expect(speechErrorMessage('network')).toMatch(/internet/)
    expect(speechErrorMessage('aborted')).toBeNull()
    expect(speechErrorMessage('something-new')).toMatch(/type your request/)
  })
})

describe('PrintAssistantPanel without speech support (e.g. Firefox)', () => {
  it('hides the microphone and still works by typing', async () => {
    removeSpeech()
    mockInterpret.mockResolvedValue(RESULT)
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(<PrintAssistantPanel documentIds={['d1']} onApply={onApply} />)

    expect(screen.queryByRole('button', { name: /speak/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/Chrome sends the audio/)).not.toBeInTheDocument()

    await user.type(screen.getByPlaceholderText(/how you want it printed/i), '2 copies double sided')
    await user.click(screen.getByRole('button', { name: /fill in my settings/i }))
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(RESULT))
    expect(mockInterpret).toHaveBeenCalledWith('2 copies double sided', ['d1'])
  })
})

describe('PrintAssistantPanel voice input', () => {
  it('starts listening in Indian English, shows live words, and puts the final text in the box', async () => {
    installSpeech()
    const user = userEvent.setup()
    render(<PrintAssistantPanel documentIds={['d1']} onApply={vi.fn()} />)

    expect(screen.getByText(/Chrome sends the audio to Google/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /speak/i }))

    const engine = FakeRecognition.last!
    expect(engine.start).toHaveBeenCalled()
    expect(engine.lang).toBe('en-IN')
    expect(engine.continuous).toBe(false)
    expect(engine.interimResults).toBe(true)
    expect(screen.getByRole('status')).toHaveTextContent('Listening')
    expect(screen.getByRole('button', { name: /stop/i })).toHaveAttribute('aria-pressed', 'true')

    act(() => engine.hear('one copy spiral', false))
    expect(screen.getByRole('status')).toHaveTextContent('one copy spiral')

    act(() => engine.hear('one copy spiral double sided', true))
    expect(screen.getByPlaceholderText(/how you want it printed/i)).toHaveValue('one copy spiral double sided')

    act(() => engine.onend?.())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /speak/i })).toBeInTheDocument()
  })

  it('never sends anything by voice: the student must press the button, and can fix the text first', async () => {
    installSpeech()
    const user = userEvent.setup()
    render(<PrintAssistantPanel documentIds={['d1']} onApply={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /speak/i }))
    act(() => FakeRecognition.last!.hear('two copies black and white', true))

    expect(mockInterpret).not.toHaveBeenCalled()
    const box = screen.getByPlaceholderText(/how you want it printed/i)
    await user.type(box, ' on A3')
    expect(box).toHaveValue('two copies black and white on A3')
  })

  it('appends to what was already typed', async () => {
    installSpeech()
    const user = userEvent.setup()
    render(<PrintAssistantPanel documentIds={['d1']} onApply={vi.fn()} />)
    await user.type(screen.getByPlaceholderText(/how you want it printed/i), 'G Block shop')
    await user.click(screen.getByRole('button', { name: /speak/i }))
    act(() => FakeRecognition.last!.hear('spiral bind', true))
    expect(screen.getByPlaceholderText(/how you want it printed/i)).toHaveValue('G Block shop spiral bind')
  })

  it('stops the microphone when the request is submitted', async () => {
    installSpeech()
    mockInterpret.mockResolvedValue(RESULT)
    const user = userEvent.setup()
    render(<PrintAssistantPanel documentIds={['d1']} onApply={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /speak/i }))
    act(() => FakeRecognition.last!.hear('one copy', true))
    await user.click(screen.getByRole('button', { name: /fill in my settings/i }))
    expect(FakeRecognition.last!.stop).toHaveBeenCalled()
  })

  it('explains a blocked microphone and keeps typing available', async () => {
    installSpeech()
    const user = userEvent.setup()
    render(<PrintAssistantPanel documentIds={['d1']} onApply={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /speak/i }))
    act(() => FakeRecognition.last!.onerror?.({ error: 'not-allowed' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/blocked/i)
    expect(screen.getByPlaceholderText(/how you want it printed/i)).toBeEnabled()
  })

  it('does not show an error for a manual stop (aborted)', async () => {
    installSpeech()
    const user = userEvent.setup()
    render(<PrintAssistantPanel documentIds={['d1']} onApply={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /speak/i }))
    act(() => FakeRecognition.last!.onerror?.({ error: 'aborted' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('releases the microphone when the panel goes away', async () => {
    installSpeech()
    const user = userEvent.setup()
    const { unmount } = render(<PrintAssistantPanel documentIds={['d1']} onApply={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /speak/i }))
    const engine = FakeRecognition.last!
    unmount()
    expect(engine.abort).toHaveBeenCalled()
  })

  it('does not run two recognitions at once', async () => {
    installSpeech()
    const user = userEvent.setup()
    render(<PrintAssistantPanel documentIds={['d1']} onApply={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /speak/i }))
    const first = FakeRecognition.last!
    expect(first.start).toHaveBeenCalledTimes(1)
    // While listening the same button is "Stop", so a second start can't be triggered.
    expect(screen.queryByRole('button', { name: /^speak$/i })).not.toBeInTheDocument()
  })
})
