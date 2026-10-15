import { describe, expect, it } from 'vitest'
import { mapHerdrSessions } from '../herdr-sessions'

const workspaces = [{ workspace_id: 'w1', label: 'rust-terminal' }]

describe('mapHerdrSessions', () => {
  it('shows the automatic title for an unnamed tab and keeps the pane id as identity', () => {
    const { projectGroups } = mapHerdrSessions({
      workspaces,
      tabs: [{ tab_id: 'w1:t4', workspace_id: 'w1', label: '1' }],
      panes: [{ pane_id: 'w1:p6', workspace_id: 'w1', tab_id: 'w1:t4', terminal_title_stripped: 'Clean git state' }],
    })
    expect(projectGroups[0].sessions[0]).toMatchObject({
      name: 'w1:p6',
      displayName: 'Clean git state',
      detail: 'Tab 1',
      tabId: 'w1:t4',
      tabLabel: '1',
    })
  })

  it('lets a custom tab name win over automatic titles, judged by tab position rather than digits', () => {
    const { projectGroups } = mapHerdrSessions({
      workspaces,
      tabs: [
        { tab_id: 'w1:t1', workspace_id: 'w1', label: 'build' },
        { tab_id: 'w1:t2', workspace_id: 'w1', label: '7' },
      ],
      panes: [
        { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', title: 'agent title', terminal_title_stripped: 'zsh' },
        { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2', terminal_title_stripped: 'vim' },
      ],
    })
    expect(projectGroups[0].sessions.map(session => [session.displayName, session.detail])).toEqual([
      ['build', undefined],
      ['7', undefined],
    ])
  })

  it('prefers a manual pane label, then the agent title, then the terminal title', () => {
    const { otherSessions } = mapHerdrSessions({
      panes: [
        { pane_id: 'w9:p1', workspace_id: 'w9', label: 'notes', title: 'agent', terminal_title_stripped: 'term' },
        { pane_id: 'w9:p2', workspace_id: 'w9', label: ' ', title: 'agent', terminal_title_stripped: 'term' },
        { pane_id: 'w9:p3', workspace_id: 'w9', terminal_title_stripped: 'term' },
        { pane_id: 'w9:p4', workspace_id: 'w9' },
      ],
    })
    expect(otherSessions.map(session => session.displayName)).toEqual(['notes', 'agent', 'term', 'w9:p4'])
  })

  it('shares one tab name across its panes and distinguishes them, allowing duplicate names', () => {
    const { projectGroups } = mapHerdrSessions({
      workspaces,
      tabs: [
        { tab_id: 'w1:t1', workspace_id: 'w1', label: 'api' },
        { tab_id: 'w1:t2', workspace_id: 'w1', label: 'api' },
      ],
      panes: [
        { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_title_stripped: 'server' },
        { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1' },
        { pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t2' },
      ],
    })
    expect(projectGroups[0].sessions.map(session => [session.name, session.displayName, session.detail, session.tabId])).toEqual([
      ['w1:p1', 'api', 'server', 'w1:t1'],
      ['w1:p2', 'api', 'w1:p2', 'w1:t1'],
      ['w1:p3', 'api', undefined, 'w1:t2'],
    ])
  })

  it('keeps panes connectable when tab metadata is missing or does not match', () => {
    const { projectGroups } = mapHerdrSessions({
      workspaces,
      panes: [
        { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_title_stripped: 'vim' },
        { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t9' },
      ],
    })
    expect(projectGroups[0].sessions.map(session => [session.name, session.displayName, session.tabId, session.tabLabel])).toEqual([
      ['w1:p1', 'vim', 'w1:t1', undefined],
      ['w1:p2', 'w1:p2', 'w1:t9', undefined],
    ])
  })
})
