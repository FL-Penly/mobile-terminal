import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AltScreenTranscript } from '../alt-screen-transcript'

function flushRaf(): void {
  vi.runAllTimers()
}

describe('AltScreenTranscript', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    let nextId = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      const id = nextId++
      setTimeout(() => cb(performance.now()), 0)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts inactive with empty transcript', () => {
    const t = new AltScreenTranscript()
    expect(t.isActive()).toBe(false)
    expect(t.getLines()).toEqual([])
  })

  it('activates on enter alt buffer and resets transcript', () => {
    const t = new AltScreenTranscript()
    t.onEnterAltBuffer()
    expect(t.isActive()).toBe(true)
    expect(t.getLines()).toEqual([])
  })

  it('deactivates on leave alt buffer', () => {
    const t = new AltScreenTranscript()
    t.onEnterAltBuffer()
    t.onLeaveAltBuffer()
    expect(t.isActive()).toBe(false)
  })

  it('scheduleCaptureFrame is no-op when inactive', () => {
    const t = new AltScreenTranscript()
    const reader = vi.fn(() => 'line')
    t.scheduleCaptureFrame(3, reader)
    flushRaf()
    expect(reader).not.toHaveBeenCalled()
    expect(t.getLines()).toEqual([])
  })

  it('captures initial frame as transcript when active', () => {
    const t = new AltScreenTranscript()
    t.onEnterAltBuffer()
    const lines = ['a', 'b', 'c']
    t.scheduleCaptureFrame(3, (y) => lines[y])
    flushRaf()
    expect(t.getLines()).toEqual(['a', 'b', 'c'])
  })

  it('does not duplicate transcript when frame is unchanged', () => {
    const t = new AltScreenTranscript()
    t.onEnterAltBuffer()
    const lines = ['a', 'b', 'c']
    t.scheduleCaptureFrame(3, (y) => lines[y])
    flushRaf()
    t.scheduleCaptureFrame(3, (y) => lines[y])
    flushRaf()
    expect(t.getLines()).toEqual(['a', 'b', 'c'])
  })

  it('appends new lines on scroll-down', () => {
    const t = new AltScreenTranscript()
    t.onEnterAltBuffer()
    const first = ['a', 'b', 'c', 'd', 'e']
    t.scheduleCaptureFrame(5, (y) => first[y])
    flushRaf()

    const second = ['c', 'd', 'e', 'X', 'Y']
    t.scheduleCaptureFrame(5, (y) => second[y])
    flushRaf()

    const lines = t.getLines()
    expect(lines).toContain('a')
    expect(lines).toContain('b')
    expect(lines).toContain('X')
    expect(lines).toContain('Y')
  })

  it('replaces transcript when no scroll overlap detected', () => {
    const t = new AltScreenTranscript()
    t.onEnterAltBuffer()
    t.scheduleCaptureFrame(3, (y) => ['a', 'b', 'c'][y])
    flushRaf()
    t.scheduleCaptureFrame(3, (y) => ['x', 'y', 'z'][y])
    flushRaf()
    expect(t.getLines()).toEqual(['x', 'y', 'z'])
  })

  it('dispose does not throw', () => {
    const t = new AltScreenTranscript()
    t.onEnterAltBuffer()
    t.scheduleCaptureFrame(3, () => 'x')
    expect(() => t.dispose()).not.toThrow()
  })

  it('re-entering alt buffer clears prior transcript', () => {
    const t = new AltScreenTranscript()
    t.onEnterAltBuffer()
    t.scheduleCaptureFrame(2, (y) => ['old', 'data'][y])
    flushRaf()
    expect(t.getLines().length).toBeGreaterThan(0)

    t.onLeaveAltBuffer()
    t.onEnterAltBuffer()
    expect(t.getLines()).toEqual([])
  })
})
