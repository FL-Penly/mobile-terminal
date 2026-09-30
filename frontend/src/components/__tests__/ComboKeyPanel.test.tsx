import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeyInputHandler } from '../../contexts/TerminalContext'
import { ComboKeyPanel } from '../ComboKeyPanel'

const sendKeystroke = vi.fn<KeyInputHandler>()
const terminal = { sendKeystroke, connectionState: 'connected' }
vi.mock('../../contexts/TerminalContext', () => ({ useTerminal: () => terminal }))

const pointerDown = (name: string, pointerId: number) => fireEvent.pointerDown(screen.getByRole('button', { name }), { pointerId, button: 0 })
const pointerUp = (name: string, pointerId: number) => fireEvent.pointerUp(screen.getByRole('button', { name }), { pointerId, button: 0 })

describe('combination key panel', () => {
  beforeEach(() => {
    // jsdom has no pointer capture; preserve ids for realistic multi-touch tests.
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options)
        this.pointerId = options.pointerId ?? 1
      }
    }
    vi.stubGlobal('PointerEvent', TestPointerEvent)
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
    sendKeystroke.mockReset().mockReturnValue({ ok: true, byteLength: 6 })
    terminal.connectionState = 'connected'
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('keeps a tapped modifier active until tapped again without duplicating pointer clicks', () => {
    render(<ComboKeyPanel onClose={() => undefined} />)
    pointerDown('Shift', 1)
    pointerUp('Shift', 1)
    expect(screen.getByRole('button', { name: 'Shift' })).toHaveAttribute('aria-pressed', 'true')
    pointerDown('ArrowLeft', 2)
    pointerUp('ArrowLeft', 2)
    fireEvent.click(screen.getByRole('button', { name: 'ArrowLeft' }), { detail: 1 })
    expect(sendKeystroke).toHaveBeenCalledOnce()
    expect(sendKeystroke).toHaveBeenLastCalledWith({ key: 'ArrowLeft', modifiers: { shift: true, ctrl: false, alt: false } })
    fireEvent.click(screen.getByRole('button', { name: 'ArrowRight' }))
    expect(sendKeystroke).toHaveBeenLastCalledWith({ key: 'ArrowRight', modifiers: { shift: true, ctrl: false, alt: false } })
    pointerDown('Shift', 3)
    pointerUp('Shift', 3)
    expect(screen.getByRole('button', { name: 'Shift' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'ArrowRight' }))
    expect(sendKeystroke).toHaveBeenLastCalledWith({ key: 'ArrowRight', modifiers: { shift: false, ctrl: false, alt: false } })
  })

  it('holds multiple modifiers across keys and releases them without latching', () => {
    render(<ComboKeyPanel onClose={() => undefined} />)
    pointerDown('Ctrl', 1)
    pointerDown('Alt', 2)
    pointerDown('ArrowLeft', 3)
    pointerUp('Ctrl', 1)
    pointerUp('ArrowLeft', 3)
    expect(sendKeystroke).toHaveBeenLastCalledWith({ key: 'ArrowLeft', modifiers: { ctrl: true, alt: true, shift: false } })
    pointerDown('ArrowRight', 4)
    pointerUp('ArrowRight', 4)
    expect(sendKeystroke).toHaveBeenLastCalledWith({ key: 'ArrowRight', modifiers: { ctrl: false, alt: true, shift: false } })
    pointerUp('Alt', 2)
    expect(screen.getByRole('button', { name: 'Alt' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps modifiers for repeated use and clears them when the page loses focus', () => {
    render(<ComboKeyPanel onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Shift' }))
    fireEvent.click(screen.getByRole('button', { name: 'ArrowLeft' }))
    fireEvent.click(screen.getByRole('button', { name: 'ArrowRight' }))
    expect(sendKeystroke.mock.calls.every(([stroke]) => stroke.modifiers.shift)).toBe(true)
    fireEvent(window, new Event('blur'))
    expect(screen.getByRole('button', { name: 'Shift' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: '锁定' })).not.toBeInTheDocument()
  })

  it('does not latch a cancelled modifier', () => {
    render(<ComboKeyPanel onClose={() => undefined} />)
    pointerDown('Ctrl', 1)
    fireEvent.pointerCancel(screen.getByRole('button', { name: 'Ctrl' }), { pointerId: 1 })
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('preserves selected modifiers after failure, without retrying automatically', () => {
    vi.useFakeTimers()
    sendKeystroke.mockReturnValue({ ok: false, reason: 'sendFailed' })
    render(<ComboKeyPanel onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Shift' }))
    pointerDown('ArrowLeft', 1)
    act(() => vi.advanceTimersByTime(2000))
    expect(sendKeystroke).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert')).toHaveTextContent('按键未发送')
    expect(screen.getByRole('button', { name: 'Shift' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('repeats the initial chord and stops immediately on pointer cancellation', () => {
    vi.useFakeTimers()
    render(<ComboKeyPanel onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Shift' }))
    pointerDown('ArrowLeft', 9)
    act(() => vi.advanceTimersByTime(570))
    expect(sendKeystroke).toHaveBeenCalledTimes(4)
    expect(sendKeystroke.mock.calls.every(([stroke]) => stroke.modifiers.shift)).toBe(true)
    fireEvent.pointerCancel(screen.getByRole('button', { name: 'ArrowLeft' }), { pointerId: 9 })
    act(() => vi.advanceTimersByTime(1000))
    expect(sendKeystroke).toHaveBeenCalledTimes(4)
  })

  it('provides letters and function keys without using the system keyboard', () => {
    render(<ComboKeyPanel onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }))
    fireEvent.click(screen.getByRole('button', { name: 'Alt' }))
    fireEvent.click(screen.getByRole('button', { name: '字母 / 数字' }))
    fireEvent.click(screen.getByRole('button', { name: 'p' }))
    expect(sendKeystroke).toHaveBeenLastCalledWith({ key: 'p', modifiers: { ctrl: true, alt: true, shift: false } })
    fireEvent.click(screen.getByRole('button', { name: '功能键' }))
    fireEvent.click(screen.getByRole('button', { name: 'F12' }))
    expect(sendKeystroke.mock.calls[sendKeystroke.mock.calls.length - 1]?.[0].key).toBe('F12')
  })

  it('captures modifiers for letters before either finger is released', () => {
    render(<ComboKeyPanel onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '字母 / 数字' }))
    pointerDown('Ctrl', 1)
    pointerDown('p', 2)
    expect(sendKeystroke).not.toHaveBeenCalled()
    pointerUp('Ctrl', 1)
    pointerUp('p', 2)
    expect(sendKeystroke).toHaveBeenLastCalledWith({ key: 'p', modifiers: { ctrl: true, alt: false, shift: false } })
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('cancels a letter when its pointer gesture turns into scrolling', () => {
    render(<ComboKeyPanel onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '字母 / 数字' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }))
    pointerDown('c', 1)
    fireEvent.pointerCancel(screen.getByRole('button', { name: 'c' }), { pointerId: 1 })
    pointerUp('c', 1)
    expect(sendKeystroke).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('stops held navigation when the panel closes', () => {
    vi.useFakeTimers()
    const view = render(<ComboKeyPanel onClose={() => undefined} />)
    pointerDown('ArrowLeft', 1)
    view.unmount()
    act(() => vi.advanceTimersByTime(2000))
    expect(sendKeystroke).toHaveBeenCalledOnce()
  })
})
