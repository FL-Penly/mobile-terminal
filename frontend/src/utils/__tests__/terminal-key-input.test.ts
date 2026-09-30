import { describe, expect, it, vi } from 'vitest'
import { createTerminalKeyHandler } from '../terminal-key-input'
import type { PasteResultCapture } from '../terminal-paste'

describe('terminal key input bridge', () => {
  it('uses current modes and reports the actual onData send result', () => {
    const capture: PasteResultCapture = { current: null }
    const input = vi.fn(() => capture.current?.({ ok: false, reason: 'disconnected' }))
    const terminal = { input, modes: { applicationCursorKeysMode: false } }
    const send = createTerminalKeyHandler(terminal, capture)
    const stroke = { key: 'ArrowLeft', modifiers: { ctrl: false, alt: false, shift: false } }
    expect(send(stroke)).toEqual({ ok: false, reason: 'disconnected' })
    expect(input).toHaveBeenLastCalledWith('\x1b[D', true)
    terminal.modes.applicationCursorKeysMode = true
    input.mockImplementation(() => capture.current?.({ ok: true, byteLength: 3 }))
    expect(send(stroke)).toEqual({ ok: true, byteLength: 3 })
    expect(input).toHaveBeenLastCalledWith('\x1bOD', true)
    expect(capture.current).toBeNull()
  })

  it('never sends an unsupported combination', () => {
    const input = vi.fn()
    const send = createTerminalKeyHandler({ input, modes: { applicationCursorKeysMode: false } }, { current: null })
    expect(send({ key: 'Tab', modifiers: { ctrl: true, alt: false, shift: false } })).toMatchObject({ ok: false, reason: 'unsupportedKey' })
    expect(input).not.toHaveBeenCalled()
  })

  it('does not claim success when xterm suppresses input', () => {
    const send = createTerminalKeyHandler({ input: () => undefined, modes: { applicationCursorKeysMode: false } }, { current: null })
    expect(send({ key: 'Enter', modifiers: { ctrl: false, alt: false, shift: false } })).toEqual({ ok: false, reason: 'sendFailed' })
  })
})
