import { describe, expect, it, vi } from 'vitest'

import type { InputSendResult } from '../../contexts/TerminalContext'
import { createTerminalPasteHandler, type PasteResultCapture } from '../terminal-paste'

const success: InputSendResult = { ok: true, byteLength: 123 }

describe('createTerminalPasteHandler', () => {
  it('passes a large multiline payload to xterm unchanged', () => {
    const text = [
      'START-唯一标记-中文-😀',
      ...Array.from({ length: 100 }, (_, index) => `${index + 1}: line ${index + 1}`),
      '',
      '```ts',
      'const value = "保持原样"',
      '```',
      'END-唯一标记',
    ].join('\n')
    const capture: PasteResultCapture = { current: null }
    const paste = vi.fn(() => capture.current?.(success))
    const handler = createTerminalPasteHandler({
      modes: { bracketedPasteMode: true },
      paste,
    }, capture)

    expect(handler(text)).toEqual(success)
    expect(paste).toHaveBeenCalledOnce()
    expect(paste).toHaveBeenCalledWith(text)
  })

  it('does not send multiline text when bracketed paste is unavailable', () => {
    const capture: PasteResultCapture = { current: null }
    const paste = vi.fn()
    const handler = createTerminalPasteHandler({
      modes: { bracketedPasteMode: false },
      paste,
    }, capture)

    expect(handler('first\nsecond')).toEqual({ ok: false, reason: 'unsafeMultiline' })
    expect(paste).not.toHaveBeenCalled()
  })

  it('returns the WebSocket send failure reported by the xterm onData path', () => {
    const failure: InputSendResult = { ok: false, reason: 'disconnected' }
    const capture: PasteResultCapture = { current: null }
    const handler = createTerminalPasteHandler({
      modes: { bracketedPasteMode: true },
      paste: () => capture.current?.(failure),
    }, capture)

    expect(handler('完整内容')).toEqual(failure)
    expect(capture.current).toBeNull()
  })
})
