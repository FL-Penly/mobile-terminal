import { describe, expect, it } from 'vitest'
import { buildHerdrTree, compactWindowLabel, herdrDispatchInstructions, herdrMoveBoundary, mapHerdrSessions } from '../herdr-sessions'

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

describe('buildHerdrTree', () => {
  it('keeps Herdr order, makes each tab one row with its split panes under it, and marks agent workspaces', () => {
    const tree = buildHerdrTree({
      workspaces: [{ workspace_id: 'w9', label: 'zeta' }, { workspace_id: 'w1', label: 'alpha', active_tab_id: 'w1:t2' }],
      tabs: [
        { tab_id: 'w1:t2', workspace_id: 'w1', label: '1' },
        { tab_id: 'w1:t1', workspace_id: 'w1', label: 'build' },
        { tab_id: 'w9:t1', workspace_id: 'w9', label: '1' },
      ],
      panes: [
        { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_title_stripped: 'make' },
        { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2', agent: 'claude' },
        { pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t2', terminal_title_stripped: 'me@host:/data00/home/me/work/api' },
        { pane_id: 'w9:p1', workspace_id: 'w9', tab_id: 'w9:t1', terminal_title_stripped: 'me@host:/home/me' },
      ],
      agents: [{ pane_id: 'w1:p2', agent: 'claude', agent_status: 'working', name: 'claude-2', terminal_title_stripped: 'Ship it' }],
    })
    expect(tree.map(workspace => [workspace.label, workspace.hasAgent])).toEqual([['zeta', false], ['alpha', true]])
    const [first, second] = tree[1].tabs
    expect([first.tabId, first.position, first.customName, first.head.paneId, first.under.map(pane => pane.paneId)])
      .toEqual(['w1:t2', 1, undefined, 'w1:p2', ['w1:p3']])
    expect([second.tabId, second.position, second.customName]).toEqual(['w1:t1', 2, 'build'])
    expect(first.head).toMatchObject({ title: 'Ship it', agent: 'claude', agentName: 'claude-2', status: 'working' })
    expect(first.under[0]).toMatchObject({ title: 'api', agent: undefined, status: 'unknown' })
    expect(tree[0].tabs[0].head.title).toBe('~')
  })

  it('keeps panes Herdr reports without a known tab or workspace', () => {
    const tree = buildHerdrTree({
      workspaces: [{ workspace_id: 'w1', label: 'alpha' }],
      panes: [
        { pane_id: 'w1:p1', workspace_id: 'w1' },
        { pane_id: 'w7:p1', workspace_id: 'w7' },
        { pane_id: 'w8:p1', workspace_id: 'w8' },
      ],
    })
    expect(tree.map(workspace => [workspace.workspaceId, workspace.label, workspace.tabs.map(tab => tab.head.paneId)])).toEqual([
      ['w1', 'alpha', ['w1:p1']],
      ['', 'Other', ['w7:p1', 'w8:p1']],
    ])
  })
})

describe('herdr sidebar helpers', () => {
  it('counts move boundaries the way Herdr does, before the moved item is taken out', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(herdrMoveBoundary(ids, 'c', 'b', false)).toBe(1)
    expect(herdrMoveBoundary(ids, 'a', 'b', true)).toBe(2)
    expect(herdrMoveBoundary(ids, 'a', 'd', true)).toBe(4)
    expect(herdrMoveBoundary(ids, 'b', 'c', false)).toBeNull()
    expect(herdrMoveBoundary(ids, 'b', 'a', true)).toBeNull()
    expect(herdrMoveBoundary(ids, 'x', 'a', true)).toBeNull()
  })

  it('reads the open /goal herdr-lens reports on the pane or its agent, only for agent panes', () => {
    const tree = buildHerdrTree({
      workspaces: [{ workspace_id: 'w1' }],
      tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
      panes: [
        { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', tokens: { lens_goal: 'goal', lens_ctx: '828k' } },
        { pane_id: 'p2', workspace_id: 'w1', tab_id: 't1', agent: 'codex' },
        { pane_id: 'p3', workspace_id: 'w1', tab_id: 't1', agent: 'claude', tokens: { lens_goal: 'unknown' } },
        { pane_id: 'p4', workspace_id: 'w1', tab_id: 't1', tokens: { lens_goal: 'goal' } },
        { pane_id: 'p5', workspace_id: 'w1', tab_id: 't1', agent: 'claude', tokens: { lens_goal: 3 } },
      ],
      agents: [{ pane_id: 'p2', agent: 'codex', tokens: { lens_goal: 'paused' } }],
    })
    const { head, under } = tree[0].tabs[0]
    expect([head, ...under].map(pane => pane.goal)).toEqual(['active', 'paused', undefined, undefined, undefined])
  })

  it('reads the context window and running background tasks herdr-lens reports', () => {
    const tree = buildHerdrTree({
      workspaces: [{ workspace_id: 'w1' }],
      tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
      panes: [
        { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', agent: 'codex', tokens: { lens_ctx: '258k', lens_bg: '2' } },
        { pane_id: 'p2', workspace_id: 'w1', tab_id: 't1', agent: 'claude', tokens: { lens_ctx: ' ', lens_bg: '0' } },
        { pane_id: 'p3', workspace_id: 'w1', tab_id: 't1', agent: 'claude', tokens: { lens_bg: 'x' } },
        { pane_id: 'p4', workspace_id: 'w1', tab_id: 't1', tokens: { lens_ctx: '500k', lens_bg: '3' } },
      ],
      agents: [{ pane_id: 'p3', agent: 'claude', tokens: { lens_ctx: '1m' } }],
    })
    const { head, under } = tree[0].tabs[0]
    expect([head, ...under].map(pane => [pane.contextWindow, pane.backgroundTasks])).toEqual([
      ['258k', 2], [undefined, undefined], ['1m', undefined], [undefined, undefined],
    ])
  })

  it('labels auto-compact windows as Claude Code users write them', () => {
    expect(compactWindowLabel(500000)).toBe('500k')
    expect(compactWindowLabel(600000)).toBe('600k')
    expect(compactWindowLabel(1000000)).toBe('1m')
    expect(compactWindowLabel(1200000)).toBe('1.2m')
  })

  it('writes dispatch instructions that target the agent name and shorten the home folder', () => {
    const [workspace] = buildHerdrTree({
      workspaces: [{ workspace_id: 'w1', label: 'alpha' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', foreground_cwd: '/data00/home/me/work', label: 'Fix' }],
      agents: [{ pane_id: 'w1:p1', agent: 'claude', name: 'claude-2' }],
    })
    const text = herdrDispatchInstructions(workspace.tabs[0].head)
    expect(text).toContain('agent claude-2（claude「Fix」，目录 ~/work）')
    expect(text).toContain('`herdr agent read claude-2`')
  })
})
