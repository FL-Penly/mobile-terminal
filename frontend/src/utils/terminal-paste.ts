import type { InputSendResult, PasteInputHandler } from '../contexts/TerminalContext'

interface TerminalPasteTarget {
  modes: {
    bracketedPasteMode: boolean
  }
  paste: (text: string) => void
}

export interface PasteResultCapture {
  current: ((result: InputSendResult) => void) | null
}

export const createTerminalPasteHandler = (
  terminal: TerminalPasteTarget,
  capture: PasteResultCapture,
): PasteInputHandler => (text) => {
  if (/\r|\n/.test(text) && !terminal.modes.bracketedPasteMode) {
    return { ok: false, reason: 'unsafeMultiline' }
  }

  let result: InputSendResult | null = null
  capture.current = sendResult => { result = sendResult }

  try {
    terminal.paste(text)
    return result ?? { ok: false, reason: 'sendFailed' }
  } catch (err) {
    console.error('[Terminal] Failed to paste input:', err)
    return { ok: false, reason: 'sendFailed' }
  } finally {
    capture.current = null
  }
}
