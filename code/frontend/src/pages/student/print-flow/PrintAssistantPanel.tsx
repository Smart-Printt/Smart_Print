import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Icon } from '@/components/ui/Icon'
import { TextArea } from '@/components/ui/Input'
import { appendTranscript, useSpeechRecognition } from '@/hooks/useSpeechRecognition'
import { assistantApi } from '@/services/assistantApi'
import type { PrintAssistantResult } from '@/types'
import { formatMoney } from '@/utils/money'

const MAX_MESSAGE_LENGTH = 500

interface PrintAssistantPanelProps {
  documentIds: string[]
  onApply: (result: PrintAssistantResult) => Promise<void> | void
}

// Describe the job in plain language; the backend returns the same settings
// the form would submit (and the cheapest matching shop), which are applied
// to every selected document and can still be edited on the next step.
export function PrintAssistantPanel({ documentIds, onApply }: PrintAssistantPanelProps) {
  const [message, setMessage] = useState('')
  const [isWorking, setIsWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PrintAssistantResult | null>(null)

  // Voice input only fills the text box - the student sees (and can fix) what
  // was heard, then presses the button themselves. Nothing is sent by voice.
  const speech = useSpeechRecognition({
    onFinalText: (text) => setMessage((current) => appendTranscript(current, text, MAX_MESSAGE_LENGTH)),
  })

  async function handleSubmit() {
    if (!message.trim()) return
    speech.stop()
    setIsWorking(true)
    setError(null)
    setResult(null)
    try {
      const res = await assistantApi.interpretPrintRequest(message.trim(), documentIds)
      setResult(res)
      await onApply(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The assistant could not read that request.')
    } finally {
      setIsWorking(false)
    }
  }

  return (
    <Card padded>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>Print assistant</div>
      <p className="text-muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Describe what you need, e.g. "2 copies, double-sided, colour cover only, spiral bind, cheapest shop".
        It fills in the settings and shop for you; you can change anything afterwards.
      </p>
      <TextArea
        placeholder="Tell me how you want it printed…"
        value={message}
        maxLength={MAX_MESSAGE_LENGTH}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button onClick={handleSubmit} isLoading={isWorking} disabled={!message.trim() || isWorking}>
          Fill in my settings
        </Button>
        {speech.isSupported && (
          <Button
            type="button"
            variant={speech.isListening ? 'danger' : 'secondary'}
            aria-pressed={speech.isListening}
            onClick={speech.isListening ? speech.stop : speech.start}
            disabled={isWorking}
          >
            <Icon name="mic" size={16} />
            {speech.isListening ? 'Stop' : 'Speak'}
          </Button>
        )}
      </div>

      {speech.isListening && (
        <p role="status" className="text-secondary" style={{ fontSize: 13, marginTop: 10 }}>
          <span aria-hidden style={{ color: 'var(--color-danger)' }}>●</span> Listening…{' '}
          <em>{speech.interimText}</em>
        </p>
      )}
      {speech.error && (
        <p role="alert" style={{ fontSize: 13, marginTop: 10, color: 'var(--color-danger, #b42318)' }}>
          {speech.error}
        </p>
      )}
      {speech.isSupported && !speech.isListening && (
        <p className="text-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Voice: your browser turns speech into text (Chrome sends the audio to Google to do this). Only the text
          is sent to SmartPrint.
        </p>
      )}

      {error && (
        <p role="alert" style={{ fontSize: 13, marginTop: 12, color: 'var(--color-danger, #b42318)' }}>
          {error}
        </p>
      )}
      {result && (
        <div style={{ fontSize: 13, marginTop: 12 }}>
          {result.shopName && (
            <div style={{ fontWeight: 700 }}>
              {result.shopName}
              {result.estimatedTotal ? ` · ${formatMoney(result.estimatedTotal)}` : ''}
            </div>
          )}
          {result.notes.map((note) => (
            <div key={note} className="text-muted">
              {note}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
