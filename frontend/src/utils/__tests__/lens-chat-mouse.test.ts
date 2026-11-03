import { describe, expect, it } from 'vitest'
import { sgrClick, WheelStepper } from '../lens-chat-mouse'
import { isLensChatPane } from '../herdr-sessions'

describe('lens chat mouse', () => {
  it('encodes a left click as an SGR press and release at the cell', () => {
    expect(sgrClick(30, 28)).toBe('\x1b[<0;30;28M\x1b[<0;30;28m')
  })

  it('turns trackpad pixels into whole wheel steps and keeps the remainder', () => {
    const wheel = new WheelStepper()
    expect(wheel.steps(25, 0)).toEqual([])
    expect(wheel.steps(25, 0)).toEqual(['down'])
    expect(wheel.steps(-130, 0)).toEqual(['up', 'up', 'up'])
    expect(wheel.steps(3, 1)).toEqual(['down'])
  })

  it('recognises only panes the server marked as a lens chat view', () => {
    const payload = { panes: [
      { pane_id: 'w:p1', workspace_id: 'w', agent: 'claude' },
      { pane_id: 'w:p7', workspace_id: 'w', label: 'Chat', lens_chat: true },
    ] }
    expect(isLensChatPane(payload, 'w:p7')).toBe(true)
    expect(isLensChatPane(payload, 'w:p1')).toBe(false)
    expect(isLensChatPane(payload, null)).toBe(false)
    expect(isLensChatPane(null, 'w:p7')).toBe(false)
  })
})
