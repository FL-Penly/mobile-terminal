import type { InputSendResult, KeyInputHandler } from '../contexts/TerminalContext'
import { encodeTerminalKey, type KeyboardModes } from './terminal-keys'
import type { PasteResultCapture } from './terminal-paste'

interface TerminalKeyTarget {
  modes: KeyboardModes
  input: (data: string, wasUserInput?: boolean) => void
}

export const createTerminalKeyHandler = (
  terminal: TerminalKeyTarget,
  capture: PasteResultCapture,
): KeyInputHandler => (stroke) => {
  const encoded = encodeTerminalKey(stroke, terminal.modes)
  if (!encoded.ok) return encoded
  let result: InputSendResult | null = null
  capture.current = sendResult => { result = sendResult }
  try {
    terminal.input(encoded.data, true)
    return result ?? { ok: false, reason: 'sendFailed' }
  } catch (error) {
    console.error('[Terminal] Failed to send key:', error)
    return { ok: false, reason: 'sendFailed' }
  } finally {
    capture.current = null
  }
}
