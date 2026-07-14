import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TerminalProvider,
  useTerminal,
  type TerminalContextValue,
} from '../TerminalContext'

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  send = vi.fn<(data: ArrayBufferView) => void>()
  close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED })

  constructor(_url: string, _protocols?: string | string[]) {
    MockWebSocket.instances.push(this)
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }
}

let contextValue: TerminalContextValue | null = null

const ContextCapture = () => {
  contextValue = useTerminal()
  return null
}

const getContext = (): TerminalContextValue => {
  if (!contextValue) throw new Error('Terminal context was not captured')
  return contextValue
}

describe('TerminalContext sendInput', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    MockWebSocket.instances = []
    contextValue = null
  })

  it('returns disconnected without attempting a WebSocket send', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]

    expect(getContext().sendInput('preserved')).toEqual({ ok: false, reason: 'disconnected' })
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('sends one complete ttyd UTF-8 frame and reports its byte length', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    ws.send.mockClear()
    const text = 'START\n中文 😀\nEND'
    const payload = new TextEncoder().encode(text)

    expect(getContext().sendInput(text)).toEqual({ ok: true, byteLength: payload.byteLength })
    expect(ws.send).toHaveBeenCalledOnce()
    const frame = ws.send.mock.calls[0][0]
    const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
    expect(bytes[0]).toBe(0x30)
    expect(Array.from(bytes.slice(1))).toEqual(Array.from(payload))
  })

  it('reports a synchronous WebSocket send error', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    ws.send.mockImplementationOnce(() => { throw new Error('socket failed') })

    expect(getContext().sendInput('keep me')).toEqual({ ok: false, reason: 'sendFailed' })
  })
})
