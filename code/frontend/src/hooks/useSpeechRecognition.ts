import { useCallback, useEffect, useRef, useState } from 'react'

// Minimal typing for the browser's Web Speech API (not in every TypeScript
// DOM lib). Supported in Chrome and Edge; absent in Firefox - callers hide
// the microphone when `isSupported` is false.
interface RecognitionResultLike {
  isFinal: boolean
  0: { transcript: string }
}
interface RecognitionEventLike {
  resultIndex: number
  results: { length: number; [index: number]: RecognitionResultLike }
}
interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: RecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type RecognitionConstructor = new () => RecognitionLike

function getRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor
    webkitSpeechRecognition?: RecognitionConstructor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

// Friendly text for the API's error codes; null = nothing worth showing
// (e.g. the user stopped it themselves).
export function speechErrorMessage(code: string): string | null {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Allow it in the browser’s address bar, or type your request instead.'
    case 'no-speech':
      return 'I didn’t hear anything. Tap the microphone and try again.'
    case 'audio-capture':
      return 'No microphone was found on this device.'
    case 'network':
      return 'Voice input needs an internet connection. You can still type your request.'
    case 'aborted':
      return null
    default:
      return 'Voice input didn’t work this time. You can type your request instead.'
  }
}

// Adds spoken text to what is already in the box, with one space between,
// never beyond the box's character limit.
export function appendTranscript(current: string, spoken: string, maxLength: number): string {
  const addition = spoken.trim()
  if (!addition) return current
  const joined = current.trim() ? `${current.trimEnd()} ${addition}` : addition
  return joined.slice(0, maxLength)
}

interface UseSpeechRecognitionOptions {
  lang?: string
  // Called once per finished phrase with the recognised text.
  onFinalText: (text: string) => void
}

export function useSpeechRecognition({ lang = 'en-IN', onFinalText }: UseSpeechRecognitionOptions) {
  const isSupported = getRecognitionConstructor() !== null
  const [isListening, setIsListening] = useState(false)
  const [interimText, setInterimText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const recognitionRef = useRef<RecognitionLike | null>(null)
  const onFinalTextRef = useRef(onFinalText)
  useEffect(() => {
    onFinalTextRef.current = onFinalText
  }, [onFinalText])

  const start = useCallback(() => {
    const Recognition = getRecognitionConstructor()
    if (!Recognition || recognitionRef.current) return

    const recognition = new Recognition()
    recognition.lang = lang
    recognition.continuous = false // one request per tap
    recognition.interimResults = true // show words as they are heard
    recognition.maxAlternatives = 1

    recognition.onresult = (event) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        if (!result) continue
        if (result.isFinal) final += result[0].transcript
        else interim += result[0].transcript
      }
      setInterimText(interim)
      if (final.trim()) onFinalTextRef.current(final)
    }
    recognition.onerror = (event) => {
      setError(speechErrorMessage(event.error))
    }
    recognition.onend = () => {
      recognitionRef.current = null
      setIsListening(false)
      setInterimText('')
    }

    setError(null)
    recognitionRef.current = recognition
    try {
      recognition.start()
      setIsListening(true)
    } catch {
      recognitionRef.current = null
      setError(speechErrorMessage('other'))
    }
  }, [lang])

  const stop = useCallback(() => {
    recognitionRef.current?.stop()
  }, [])

  // Never leave the microphone open after the component goes away.
  useEffect(
    () => () => {
      const recognition = recognitionRef.current
      if (recognition) {
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
        recognition.abort()
        recognitionRef.current = null
      }
    },
    [],
  )

  return { isSupported, isListening, interimText, error, start, stop }
}
