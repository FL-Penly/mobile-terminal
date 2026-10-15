export interface LineSelection {
  anchor: number
  focus: number
}

export interface LineRange {
  from: number
  to: number
}

export type SelectionHandle = 'start' | 'end'

const clamp = (index: number, count: number) => Math.max(0, Math.min(count - 1, index))

export const toRange = (selection: LineSelection): LineRange => ({
  from: Math.min(selection.anchor, selection.focus),
  to: Math.max(selection.anchor, selection.focus),
})

export const rangeSize = (range: LineRange): number => range.to - range.from + 1

export const beginDrag = (index: number, count: number): LineSelection => {
  const line = clamp(index, count)
  return { anchor: line, focus: line }
}

// Dragging a handle pins the opposite end, so either end can cross the other.
export const beginHandleDrag = (range: LineRange, handle: SelectionHandle): LineSelection => (
  handle === 'start'
    ? { anchor: range.to, focus: range.from }
    : { anchor: range.from, focus: range.to }
)

export const dragTo = (selection: LineSelection, index: number, count: number): LineSelection => {
  const focus = clamp(index, count)
  return focus === selection.focus ? selection : { ...selection, focus }
}

export const shiftSelection = (selection: LineSelection, offset: number): LineSelection => ({
  anchor: selection.anchor + offset,
  focus: selection.focus + offset,
})

// Pixels per frame to auto-scroll while the finger sits near or beyond an edge.
export const edgeScrollSpeed = (y: number, top: number, bottom: number, edge = 24, max = 16): number => {
  if (y < top + edge) return -Math.ceil(max * Math.min(1, (top + edge - y) / edge))
  if (y > bottom - edge) return Math.ceil(max * Math.min(1, (y - (bottom - edge)) / edge))
  return 0
}
