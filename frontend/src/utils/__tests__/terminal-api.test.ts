import { describe, expect, it } from 'vitest'
import { isMissingHerdrPaneReason, pickHerdrFallbackPane } from '../terminal-api'

describe('herdr fallback pane', () => {
  it('only treats a missing terminal target as recoverable', () => {
    expect(isMissingHerdrPaneReason('terminal session control failed: terminal target w1:p18 not found')).toBe(true)
    expect(isMissingHerdrPaneReason('terminal attach taken over')).toBe(false)
    expect(isMissingHerdrPaneReason('Connection lost')).toBe(false)
  })

  it('prefers the focused pane in the same workspace, then any pane elsewhere', () => {
    const panes = [
      { pane_id: 'w2:p1', workspace_id: 'w2', focused: true },
      { pane_id: 'w1:p3', workspace_id: 'w1' },
      { pane_id: 'w1:p4', workspace_id: 'w1', focused: true },
    ]
    expect(pickHerdrFallbackPane(panes, 'w1:p18')).toBe('w1:p4')
    expect(pickHerdrFallbackPane(panes.slice(0, 2), 'w1:p18')).toBe('w1:p3')
    expect(pickHerdrFallbackPane(panes, 'w9:p1')).toBe('w2:p1')
    expect(pickHerdrFallbackPane([{ pane_id: 'w1:p18', workspace_id: 'w1' }], 'w1:p18')).toBeNull()
  })
})
