import { StrictMode } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalKeyHandler } from '../../utils/terminal-key-input'
import type { PasteResultCapture } from '../../utils/terminal-paste'

import {
  TerminalProvider,
  useTerminal,
  type InputSendResult,
  type TerminalContextValue,
} from '../TerminalContext'
import flateFrames from '../../utils/__tests__/fixtures/flate2-frames.json'

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instances: MockWebSocket[] = []

  readonly url: string
  readyState = MockWebSocket.CONNECTING
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onclose: ((event: { reason: string }) => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  send = vi.fn<(data: ArrayBufferView) => void>()
  close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED })

  constructor(url: string, _protocols?: string | string[]) {
    this.url = url
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

describe('TerminalContext', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    MockWebSocket.instances = []
    contextValue = null
    window.history.replaceState({}, '', '/')
  })

  it('returns disconnected without attempting a WebSocket send', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]

    expect(getContext().sendInput('preserved')).toEqual({ ok: false, reason: 'disconnected' })
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('connects directly to the requested herdr pane', () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)

    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    expect(MockWebSocket.instances[0].url).toMatch(/\/ws\?mux=herdr&pane=w4%3Ap1$/)
    expect(getContext().mux).toBe('herdr')
    expect(getContext().paneId).toBe('w4:p1')
  })

  it('pastes multiline Herdr text through the acknowledged pane paste API', async () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    const text = '第一行\n第二行 😀'
    const byteLength = new TextEncoder().encode(text).byteLength
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ success: true, byteLength }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    await expect(getContext().submitText(text)).resolves.toEqual({ ok: true, byteLength })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/herdr/paste?pane=w4%3Ap1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
    )
  })

  it('returns the Herdr paste error without reporting a false success', async () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'paste_failed', message: 'pane input unavailable' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    ))
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    await expect(getContext().submitText('first\nsecond')).resolves.toEqual({
      ok: false,
      reason: 'sendFailed',
      message: 'pane input unavailable',
    })
  })

  it('keeps single-line Herdr input on the existing terminal paste path', async () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const pasteResult: InputSendResult = { ok: true, byteLength: 11 }
    const pasteHandler = vi.fn(() => pasteResult)
    getContext().registerPasteHandler(pasteHandler)

    await expect(getContext().submitText('single line')).resolves.toEqual(pasteResult)
    expect(pasteHandler).toHaveBeenCalledWith('single line')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not weaken the multiline safety gate outside Herdr', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const pasteHandler = vi.fn((): InputSendResult => ({
      ok: false,
      reason: 'unsafeMultiline',
    }))
    getContext().registerPasteHandler(pasteHandler)

    await expect(getContext().submitText('first\nsecond')).resolves.toEqual({
      ok: false,
      reason: 'unsafeMultiline',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not gate a visible herdr page on unreliable document focus', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)

    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0].url).toMatch(/\/ws\?mux=herdr&pane=w4%3Ap1$/)
  })

  it('stops automatic reconnect when another herdr controller takes over', () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())

    act(() => ws.onclose?.({ reason: 'terminal attach taken over' }))

    expect(getContext().connectionState).toBe('disconnected')
    expect(getContext().takeoverDetected).toBe(true)
    expect(getContext().disconnectReason).toBe('terminal attach taken over')
    expect(getContext().reconnectAttempt).toBe(0)
  })

  it('coalesces rapid pane selections and connects only the latest target without reloading', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const initialSocket = MockWebSocket.instances[0]

    act(() => {
      for (let index = 1; index <= 100; index++) {
        getContext().switchTerminal('herdr', `w9:p${index}`)
      }
    })
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => { vi.advanceTimersByTime(70) })

    expect(initialSocket.close).toHaveBeenCalledOnce()
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toMatch(/\/ws\?mux=herdr&pane=w9%3Ap100$/)
    expect(getContext().mux).toBe('herdr')
    expect(getContext().paneId).toBe('w9:p100')
    expect(window.location.search).toBe('?mux=herdr&pane=w9%3Ap100')
  })

  it('keeps a herdr controller on window blur while the page remains visible', () => {
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())

    act(() => window.dispatchEvent(new Event('blur')))
    expect(ws.close).not.toHaveBeenCalled()
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().connectionState).toBe('connected')
    expect(getContext().reconnectAttempt).toBe(0)
  })

  it('keeps a tmux connection alive on window blur', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())

    act(() => window.dispatchEvent(new Event('blur')))

    expect(ws.close).not.toHaveBeenCalled()
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().connectionState).toBe('connected')
  })

  it('cancels a pending herdr reconnect when the page becomes hidden', () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('visible')
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())

    act(() => ws.onclose?.({ reason: '' }))
    expect(getContext().reconnectAttempt).toBe(1)
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => { vi.runAllTimers() })

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().reconnectAttempt).toBe(0)
  })

  it('reacquires the current herdr pane exactly once when the page becomes visible', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('visible')
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    act(() => {
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => {
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toMatch(/\/ws\?mux=herdr&pane=w4%3Ap1$/)
  })

  it('defers pane changes while hidden and reacquires only the latest target', () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('visible')
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)

    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => {
      getContext().switchTerminal('herdr', 'w4:p2')
      getContext().switchTerminal('herdr', 'w4:p3')
      vi.advanceTimersByTime(70)
    })

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().paneId).toBe('w4:p3')

    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toMatch(/\/ws\?mux=herdr&pane=w4%3Ap3$/)
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

  it('sends the CSI-u Shift+Enter sequence', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    ws.send.mockClear()

    getContext().sendKey('SHIFT_ENTER')

    expect(ws.send).toHaveBeenCalledOnce()
    const frame = ws.send.mock.calls[0][0]
    const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
    expect(new TextDecoder().decode(bytes)).toBe(`0\x1b[13;2u`)
  })

  it('sends combo keys as ttyd input without changing existing shortcuts or pasted text', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    ws.send.mockClear()
    const capture: PasteResultCapture = { current: null }
    const unregister = getContext().registerKeyHandler(createTerminalKeyHandler({
      modes: { applicationCursorKeysMode: false },
      input: data => capture.current?.(getContext().sendInput(data)),
    }, capture))
    expect(getContext().sendKeystroke({ key: 'ArrowLeft', modifiers: { shift: true, ctrl: false, alt: false } })).toEqual({ ok: true, byteLength: 6 })
    getContext().sendKey('ARROW_LEFT')
    getContext().sendKey('CTRL_C')
    getContext().sendInput('中文 plain text')
    const frames = ws.send.mock.calls.map(([frame]) => new TextDecoder().decode(frame))
    expect(frames).toEqual(['0\x1b[1;2D', '0\x1b[D', '0\x03', '0中文 plain text'])
    unregister()
    expect(getContext().sendKeystroke({ key: 'Enter', modifiers: { shift: false, ctrl: false, alt: false } })).toEqual({ ok: false, reason: 'terminalUnavailable' })
  })

  it('blocks keystrokes while switching targets and does not replay them', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    act(() => MockWebSocket.instances[0].open())
    const handler = vi.fn(() => ({ ok: true as const, byteLength: 1 }))
    getContext().registerKeyHandler(handler)
    act(() => getContext().switchTerminal('herdr', 'w1:p1'))
    expect(getContext().sendKeystroke({ key: 'Enter', modifiers: { shift: false, ctrl: false, alt: false } })).toEqual({ ok: false, reason: 'disconnected' })
    expect(handler).not.toHaveBeenCalled()
  })
  it('backs off through twelve unstable opens and clears attempts only after ten stable seconds', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    for (let attempt = 1; attempt <= 12; attempt++) {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      act(() => ws.open())
      act(() => ws.onclose?.({ reason: '' }))
      expect(getContext().reconnectAttempt).toBe(attempt)
      const count = MockWebSocket.instances.length
      const delay = [500, 1000, 2000, 3000, 5000][Math.min(attempt - 1, 4)]
      act(() => { vi.advanceTimersByTime(delay - 1) })
      expect(MockWebSocket.instances).toHaveLength(count)
      act(() => { vi.advanceTimersByTime(1) })
      expect(MockWebSocket.instances).toHaveLength(count + 1)
    }
    act(() => MockWebSocket.instances[MockWebSocket.instances.length - 1].open())
    act(() => { vi.advanceTimersByTime(9999) })
    expect(getContext().reconnectAttempt).toBe(12)
    act(() => { vi.advanceTimersByTime(1) })
    expect(getContext().reconnectAttempt).toBe(0)
  })

  it('preserves takeover control when the close reason is lost and refuses online reconnect', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    act(() => ws.onmessage?.({ data: new TextEncoder().encode('4{"type":"closed","reason":"taken_over","retry":false}').buffer }))
    act(() => ws.onclose?.({ reason: '' }))
    expect(getContext().takeoverDetected).toBe(true)
    act(() => window.dispatchEvent(new Event('online')))
    act(() => { vi.advanceTimersByTime(60000) })
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('schedules one reconnect in StrictMode', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<StrictMode><TerminalProvider><ContextCapture /></TerminalProvider></StrictMode>)
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
    const count = MockWebSocket.instances.length
    act(() => ws.open())
    act(() => ws.onclose?.({ reason: '' }))
    act(() => { vi.advanceTimersByTime(500) })
    expect(MockWebSocket.instances).toHaveLength(count + 1)
    expect(getContext().reconnectAttempt).toBe(1)
  })


  it('advertises features without changing auth and size fields', () => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    expect(JSON.parse(new TextDecoder().decode(ws.send.mock.calls[0][0]))).toEqual({
      AuthToken: '', columns: 80, rows: 24, features: ['heartbeat', 'deflate', 'flow'],
    })
  })

  it('detects heartbeat silence without waiting for close and extends the deadline for any message', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    act(() => ws.onmessage?.({ data: new TextEncoder().encode('4{"type":"hello","features":["heartbeat"]}').buffer }))
    act(() => { vi.advanceTimersByTime(14000) })
    act(() => ws.onmessage?.({ data: new TextEncoder().encode('0still alive').buffer }))
    act(() => { vi.advanceTimersByTime(14000) })
    expect(ws.close).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(ws.close).toHaveBeenCalledOnce()
    expect(getContext().connectionState).toBe('disconnected')
    act(() => { vi.advanceTimersByTime(500) })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it.each(['/', '/?mux=herdr&pane=w4%3Ap1'])('does not time out an unnegotiated open connection: %s', path => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    window.history.replaceState({}, '', path)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    act(() => { vi.advanceTimersByTime(60000) })
    expect(ws.close).not.toHaveBeenCalled()
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('uses ten, fifteen, then twenty second connection timeouts and retries immediately', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    for (const [index, timeout] of [10000, 15000, 20000, 20000].entries()) {
      const ws = MockWebSocket.instances[index]
      act(() => { vi.advanceTimersByTime(timeout - 1) })
      expect(ws.close).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(ws.close).toHaveBeenCalledOnce()
      act(() => { vi.advanceTimersByTime(1) })
      expect(MockWebSocket.instances).toHaveLength(index + 2)
    }
  })

  it('subtracts time already spent connecting from the next backoff', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => { vi.advanceTimersByTime(200) })
    act(() => ws.onclose?.({ reason: 'handshake failed' }))
    act(() => { vi.advanceTimersByTime(299) })
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(1) })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(getContext().reconnectAttempt).toBe(1)
  })

  it('retries immediately when a never-opened attempt has already exceeded its backoff', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => { vi.advanceTimersByTime(2000) })
    act(() => ws.onclose?.({ reason: 'handshake failed' }))
    act(() => { vi.advanceTimersByTime(1) })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('waits the full backoff after open even when the handshake was slow', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => { vi.advanceTimersByTime(2000) })
    act(() => ws.open())
    act(() => ws.onclose?.({ reason: '' }))
    act(() => { vi.advanceTimersByTime(499) })
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(1) })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('reconnects immediately on online and cancels the old retry timer', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    act(() => MockWebSocket.instances[0].open())
    act(() => window.dispatchEvent(new Event('online')))
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => MockWebSocket.instances[0].onclose?.({ reason: '' }))
    act(() => window.dispatchEvent(new Event('online')))
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => { vi.advanceTimersByTime(500) })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('pauses tmux retries while hidden and reconnects once on visibility', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    act(() => MockWebSocket.instances[0].open())
    visibility.mockReturnValue('hidden')
    act(() => MockWebSocket.instances[0].onclose?.({ reason: '' }))
    act(() => { vi.advanceTimersByTime(60000) })
    expect(MockWebSocket.instances).toHaveLength(1)
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('does not resume a hidden herdr pane on online', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    act(() => MockWebSocket.instances[0].open())
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => window.dispatchEvent(new Event('online')))
    act(() => { vi.advanceTimersByTime(60000) })
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('honors retry false even for a close reason other than takeover', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    act(() => ws.onmessage?.({ data: new TextEncoder().encode('4{"type":"closed","reason":"ended","retry":false}').buffer }))
    act(() => ws.onclose?.({ reason: '' }))
    act(() => { vi.advanceTimersByTime(60000) })
    expect(getContext().takeoverDetected).toBe(false)
    expect(MockWebSocket.instances).toHaveLength(1)
  })


  it('decodes compressed output, preserves raw notices and detects the compressed tty marker', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    const received: string[] = []
    getContext().subscribeOutput(chunk => received.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)))
    act(() => ws.open())
    act(() => ws.onmessage?.({ data: new TextEncoder().encode('4{"type":"hello","features":["deflate"]}').buffer }))
    for (const [index, frame] of flateFrames.entries()) {
      const payload = Uint8Array.from(atob(frame), char => char.charCodeAt(0))
      const data = new Uint8Array(payload.length + 1)
      data[0] = 0x35
      data.set(payload, 1)
      act(() => ws.onmessage?.({ data: data.buffer }))
      if (index === 0) act(() => ws.onmessage?.({ data: new TextEncoder().encode('0NOTICE').buffer }))
    }
    act(() => { vi.advanceTimersByTime(20) })
    expect(received.join('')).toBe('hello\nNOTICE中文 😀\n\x1b]7337;/dev/pts/42\x1b\\')
    expect(getContext().clientTty).toBe('/dev/pts/42')
  })

  it('reconnects when the negotiated deflate stream is corrupt', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    act(() => ws.onmessage?.({ data: new TextEncoder().encode('4{"type":"hello","features":["deflate"]}').buffer }))
    act(() => ws.onmessage?.({ data: new Uint8Array([0x35, 0x07]).buffer }))
    expect(ws.close).toHaveBeenCalledOnce()
    act(() => { vi.advanceTimersByTime(500) })
    expect(MockWebSocket.instances).toHaveLength(2)
  })


  it('coalesces wire-byte acknowledgements even before any output subscriber exists', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    act(() => ws.onmessage?.({ data: new TextEncoder().encode('4{"type":"hello","features":["flow","deflate"]}').buffer }))
    const raw = new TextEncoder().encode('0中文')
    const payload = Uint8Array.from(atob(flateFrames[0]), char => char.charCodeAt(0))
    const compressed = new Uint8Array(payload.length + 1)
    compressed[0] = 0x35
    compressed.set(payload, 1)
    act(() => {
      ws.onmessage?.({ data: raw.buffer })
      ws.onmessage?.({ data: compressed.buffer })
      ws.onmessage?.({ data: new TextEncoder().encode('4{"type":"heartbeat"}').buffer })
      vi.advanceTimersByTime(29)
    })
    expect(ws.send).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1) })
    expect(new TextDecoder().decode(ws.send.mock.calls[1][0])).toBe(`4{"type":"ack","bytes":${raw.byteLength + compressed.byteLength}}`)
    act(() => ws.onmessage?.({ data: raw.buffer }))
    act(() => { vi.advanceTimersByTime(30) })
    expect(new TextDecoder().decode(ws.send.mock.calls[2][0])).toBe(`4{"type":"ack","bytes":${raw.byteLength * 2 + compressed.byteLength}}`)
  })

  it('never acknowledges output without negotiated flow', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    act(() => ws.onmessage?.({ data: new TextEncoder().encode('0raw').buffer }))
    act(() => { vi.advanceTimersByTime(100) })
    expect(ws.send).toHaveBeenCalledTimes(1)
  })

  it('retires old ack timers and starts the new connection byte count at zero', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const old = MockWebSocket.instances[0]
    act(() => old.open())
    act(() => {
      old.onmessage?.({ data: new TextEncoder().encode('4{"type":"hello","features":["flow"]}').buffer })
      old.onmessage?.({ data: new TextEncoder().encode('0old data').buffer })
      getContext().reconnect()
    })
    const current = MockWebSocket.instances[1]
    act(() => current.open())
    act(() => { vi.advanceTimersByTime(30) })
    expect(old.send).toHaveBeenCalledTimes(1)
    expect(current.send).toHaveBeenCalledTimes(1)
    act(() => {
      current.onmessage?.({ data: new TextEncoder().encode('4{"type":"hello","features":["flow"]}').buffer })
      current.onmessage?.({ data: new TextEncoder().encode('0x').buffer })
      vi.advanceTimersByTime(30)
    })
    expect(new TextDecoder().decode(current.send.mock.calls[1][0])).toBe('4{"type":"ack","bytes":2}')
  })

  it('retains a takeover received before close when visibility changes first', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    window.history.replaceState({}, '', '/?mux=herdr&pane=w4%3Ap1')
    render(<TerminalProvider><ContextCapture /></TerminalProvider>)
    const ws = MockWebSocket.instances[0]
    act(() => ws.open())
    act(() => ws.onmessage?.({ data: new TextEncoder().encode('4{"type":"closed","reason":"taken_over","retry":false}').buffer }))
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => window.dispatchEvent(new Event('online')))
    act(() => { vi.advanceTimersByTime(60000) })
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(getContext().takeoverDetected).toBe(true)
    expect(getContext().connectionState).toBe('disconnected')
  })

})
