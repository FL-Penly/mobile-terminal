import { describe, expect, it } from 'vitest'

import {
  beginDrag,
  beginHandleDrag,
  dragTo,
  edgeScrollSpeed,
  rangeSize,
  shiftSelection,
  toRange,
} from '../line-selection'

describe('gutter drag selection', () => {
  it('starts on one line and extends in either direction', () => {
    const start = beginDrag(10, 50)
    expect(toRange(start)).toEqual({ from: 10, to: 10 })
    expect(toRange(dragTo(start, 14, 50))).toEqual({ from: 10, to: 14 })
    expect(toRange(dragTo(start, 3, 50))).toEqual({ from: 3, to: 10 })
  })

  it('clamps to the available lines', () => {
    expect(toRange(dragTo(beginDrag(-4, 5), 99, 5))).toEqual({ from: 0, to: 4 })
  })

  it('returns the same object when the focus line does not change', () => {
    const selection = beginDrag(2, 5)
    expect(dragTo(selection, 2, 5)).toBe(selection)
  })

  it('moves only the dragged handle and lets it cross the other end', () => {
    const range = { from: 10, to: 20 }
    const fromStart = beginHandleDrag(range, 'start')
    expect(toRange(dragTo(fromStart, 12, 100))).toEqual({ from: 12, to: 20 })
    expect(toRange(dragTo(fromStart, 25, 100))).toEqual({ from: 20, to: 25 })
    const fromEnd = beginHandleDrag(range, 'end')
    expect(toRange(dragTo(fromEnd, 30, 100))).toEqual({ from: 10, to: 30 })
    expect(toRange(dragTo(fromEnd, 4, 100))).toEqual({ from: 4, to: 10 })
  })

  it('follows lines when older history is prepended', () => {
    expect(toRange(shiftSelection({ anchor: 2, focus: 5 }, 100))).toEqual({ from: 102, to: 105 })
    expect(rangeSize({ from: 3, to: 3 })).toBe(1)
  })
})

describe('edgeScrollSpeed', () => {
  it('is zero in the middle and grows towards and past each edge', () => {
    expect(edgeScrollSpeed(300, 100, 700)).toBe(0)
    expect(edgeScrollSpeed(130, 100, 700)).toBe(0)
    expect(edgeScrollSpeed(115, 100, 700)).toBeLessThan(0)
    expect(edgeScrollSpeed(100, 100, 700)).toBe(-16)
    expect(edgeScrollSpeed(20, 100, 700)).toBe(-16)
    expect(edgeScrollSpeed(685, 100, 700)).toBeGreaterThan(0)
    expect(edgeScrollSpeed(900, 100, 700)).toBe(16)
    expect(Math.abs(edgeScrollSpeed(120, 100, 700))).toBeLessThan(Math.abs(edgeScrollSpeed(105, 100, 700)))
  })
})
