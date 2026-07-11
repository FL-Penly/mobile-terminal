import { describe, expect, it, vi } from 'vitest'
import { observeTerminalResize } from '../terminal-resize'

describe('observeTerminalResize', () => {
  it('runs the terminal fit callback on resize and disconnects on cleanup', () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    const holder: { callback?: ResizeObserverCallback } = {}
    class ResizeObserverMock {
      constructor(next: ResizeObserverCallback) { holder.callback = next }
      observe = observe
      disconnect = disconnect
      unobserve = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const onResize = vi.fn()
    const element = document.createElement('div')
    const cleanup = observeTerminalResize(element, onResize)
    expect(observe).toHaveBeenCalledWith(element)
    holder.callback?.([], {} as ResizeObserver)
    expect(onResize).toHaveBeenCalledTimes(1)
    cleanup()
    expect(disconnect).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})
