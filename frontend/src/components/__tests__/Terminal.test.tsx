import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '../Terminal'

const state = vi.hoisted(() => ({
  csi: new Map<string, (params: number[]) => boolean>(),
  sendInput: vi.fn(() => ({ ok: true, byteLength: 1 })),
}))
const disposable = () => ({ dispose: () => undefined })
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
    buffer = { active: { type: 'normal' }, onBufferChange: disposable }
    parser = {
      registerOscHandler: disposable,
      registerCsiHandler: (id: { prefix: string; final: string }, handler: (params: number[]) => boolean) => {
        state.csi.set(id.prefix + id.final, handler)
        return disposable()
      },
    }
    textarea = document.createElement('textarea')
    open(container: HTMLElement) {
      this.textarea.className = 'xterm-helper-textarea'
      // xterm clears its helper textarea on blur; this is the IME regression risk.
      this.textarea.addEventListener('blur', () => { this.textarea.value = '' })
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      container.append(screen, this.textarea)
    }
    loadAddon() {}
    onSelectionChange() { return disposable() }
    getSelection() { return '' }
    onData() { return disposable() }
    onWriteParsed() { return disposable() }
    attachCustomKeyEventHandler() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} } }))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('xterm-zerolag-input', () => ({ ZerolagInputAddon: class { clear() {} } }))
const noop = () => undefined
const register = () => noop
const terminal = {
  subscribeOutput: register, sendInput: state.sendInput, registerPasteHandler: register,
  registerKeyHandler: register, sendControl: noop, resize: noop, setClientTty: noop,
  mux: 'herdr', paneId: 'p1',
}
vi.mock('../../contexts/TerminalContext', () => ({ useTerminal: () => terminal }))
vi.mock('../../contexts/ServerEventsContext', () => ({ useTerminalModes: () => ({ tuiActive: true, herdrScrollback: false, lensChat: false }) }))

const tap = (container: HTMLElement) => {
  const touch = { clientX: 10, clientY: 10 }
  fireEvent.touchStart(container, { touches: [touch] })
  return fireEvent.touchEnd(container, { touches: [], changedTouches: [touch] })
}

describe('mobile terminal keyboard focus', () => {
  beforeEach(() => {
    localStorage.clear()
    state.csi.clear()
    vi.useFakeTimers()
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('consumes the opening double tap and preserves the first composing character through full-frame output', () => {
    const view = render(<Terminal />)
    const textarea = view.container.querySelector('textarea')!
    const container = textarea.parentElement!
    expect(textarea).toHaveAttribute('inputmode', 'none')
    tap(container)
    expect(tap(container)).toBe(false) // canceled: no synthesized mouse click/double click
    expect(textarea).toHaveFocus()
    expect(textarea).not.toHaveAttribute('inputmode')
    fireEvent.compositionStart(textarea)
    textarea.value = '你'
    state.csi.get('?h')?.([1049])
    state.csi.get('?h')?.([47])
    expect(textarea).toHaveFocus()
    expect(textarea.value).toBe('你')
    fireEvent.compositionEnd(textarea, { data: '你' })
    // The next double tap still deliberately closes the keyboard.
    tap(container)
    expect(tap(container)).toBe(false)
    expect(textarea).toHaveAttribute('inputmode', 'none')
    expect(textarea).not.toHaveFocus()
  })
})

// The application must not delay clicks, force selection, or synthesize PTY mouse
// bytes. xterm's real protocol handler receives the original events unchanged.
describe('desktop mouse ownership', () => {
  afterEach(cleanup)
  it('leaves mouse and wheel events to xterm even in an active herdr TUI', () => {
    state.sendInput.mockClear()
    const view = render(<Terminal />)
    const screen = view.container.querySelector('.xterm-screen')!
    state.csi.get('?h')?.([1002, 1006])
    const received: Event[] = []
    for (const type of ['mousedown', 'mousemove', 'mouseup', 'wheel']) {
      screen.addEventListener(type, event => received.push(event))
    }
    const events = [
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1 }),
      new MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1, clientX: 40 }),
      new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 40 }),
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }),
    ]
    for (const event of events) screen.dispatchEvent(event)
    expect(received).toEqual(events)
    expect(events.every(event => !event.defaultPrevented)).toBe(true)
    expect(state.sendInput).not.toHaveBeenCalled()
  })
})
