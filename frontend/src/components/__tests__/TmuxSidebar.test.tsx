import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TmuxSidebar } from '../TmuxSidebar'

const sendInput = vi.fn()
const refresh = vi.fn()
const switchTerminal = vi.fn()
const terminalState = { sendInput, switchTerminal, mux: 'tmux' as const, paneId: null }
const serverState = {
  projectGroups: [
    {
      projectRoot: '/work/beta',
      displayName: 'beta',
      sessions: [
        { name: 'idle', path: '/work/beta', relativePath: '.', command: 'zsh', attached: false, windows: 1, lastActivity: 10, hasNewActivity: false },
      ],
    },
    {
      projectRoot: '/work/alpha',
      displayName: 'alpha',
      sessions: [
        { name: 'active-news', path: '/work/alpha/web', relativePath: 'web', command: 'node', attached: true, windows: 2, lastActivity: 30, hasNewActivity: true },
        { name: 'current', path: '/work/alpha', relativePath: '.', command: 'codex', attached: true, windows: 3, lastActivity: 20, hasNewActivity: false },
      ],
    },
  ],
  otherSessions: [
    { name: 'loose', path: '/tmp', relativePath: '/tmp', command: 'bash', attached: false, windows: 1, lastActivity: 5, hasNewActivity: false },
  ],
  herdrPayload: null,
  currentTmuxSession: 'current',
  clientTty: '/dev/ttys001',
  path: '/work/alpha',
  isOffline: false,
  sessionsLoaded: true,
  refresh,
}

vi.mock('../../contexts/TerminalContext', () => ({ useTerminal: () => terminalState }))
vi.mock('../../contexts/ServerEventsContext', () => ({ useServerEvents: () => serverState }))

describe('TmuxSidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sendInput.mockReset()
    switchTerminal.mockReset()
    refresh.mockReset()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('keeps persisted project order, highlights the active project, and preserves session order', () => {
    localStorage.setItem('tmux_sidebar_group_order', JSON.stringify(['/work/beta', '/work/alpha']))
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    const headings = screen.getAllByRole('button').filter(button => ['alpha', 'beta', 'Other'].some(label => button.textContent?.includes(label)))
    expect(headings.map(button => button.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('alpha'), expect.stringContaining('beta'), expect.stringContaining('Other')]))
    const names = ['active-news', 'current', 'idle', 'loose'].map(name => screen.getByText(name))
    expect(names[0].compareDocumentPosition(names[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('beta').compareDocumentPosition(screen.getByText('alpha')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('beta').compareDocumentPosition(screen.getByText('Other')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('alpha').closest('section')).toHaveAttribute('data-active-project', 'true')
    expect(screen.getByText('current').closest('button')).toHaveAttribute('aria-current', 'page')
  })

  it('reorders project groups by drag and persists the new order', () => {
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    const alphaSection = screen.getByText('alpha').closest('section')
    expect(alphaSection).not.toBeNull()
    fireEvent.dragStart(screen.getByRole('button', { name: 'Move beta project' }))
    fireEvent.dragOver(alphaSection as HTMLElement)
    fireEvent.drop(alphaSection as HTMLElement, { clientY: 0 })
    expect(screen.getByText('beta').compareDocumentPosition(screen.getByText('alpha')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('tmux_sidebar_group_order') ?? '[]')).toEqual(['/work/beta', '/work/alpha'])
  })

  it('reorders sessions only when the user drags them and persists the fixed order', () => {
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    const activeDropRow = screen.getByText('active-news').closest('[data-session-name]')
    expect(activeDropRow).not.toBeNull()

    fireEvent.dragStart(screen.getByRole('button', { name: 'Move current session' }))
    fireEvent.dragOver(activeDropRow as HTMLElement)
    fireEvent.drop(activeDropRow as HTMLElement, { clientY: 0 })

    const currentRow = document.querySelector('[data-session-name="current"]')
    const activeRow = document.querySelector('[data-session-name="active-news"]')
    expect(currentRow).not.toBeNull()
    expect(activeRow).not.toBeNull()
    expect((currentRow as HTMLElement).compareDocumentPosition(activeRow as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('tmux_sidebar_session_order') ?? '{}')).toMatchObject({
      'tmux:/work/alpha': ['current', 'active-news'],
    })
  })

  it('also exposes move controls in the session actions menu for touch users', async () => {
    const user = userEvent.setup()
    render(<TmuxSidebar mobile onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)

    await user.click(screen.getByLabelText('Session actions for current'))
    expect(screen.getByText('Session Actions')).toBeInTheDocument()
    await user.click(screen.getByText('Move Up'))

    const currentRow = document.querySelector('[data-session-name="current"]')
    const activeRow = document.querySelector('[data-session-name="active-news"]')
    expect(currentRow).not.toBeNull()
    expect(activeRow).not.toBeNull()
    expect((currentRow as HTMLElement).compareDocumentPosition(activeRow as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('searches all session metadata and persists group collapse', async () => {
    const user = userEvent.setup()
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    await user.type(screen.getByPlaceholderText('Search projects or sessions'), 'node')
    expect(screen.getByText('active-news')).toBeInTheDocument()
    expect(screen.queryByText('idle')).not.toBeInTheDocument()
    await user.clear(screen.getByPlaceholderText('Search projects or sessions'))
    await user.click(screen.getByText('alpha'))
    expect(screen.queryByText('current')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmux_sidebar_collapsed_groups') ?? '[]')).toContain('/work/alpha')
  })

  it('switches using encoded session and tty then closes a mobile drawer', async () => {
    const onClose = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    render(<TmuxSidebar mobile onClose={onClose} onCollapseDesktop={vi.fn()} />)
    fireEvent.click(screen.getByText('idle'))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/tmux/switch?session=idle&client_tty=%2Fdev%2Fttys001',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    expect(onClose).toHaveBeenCalled()
    expect(sessionStorage.getItem('ttyd_last_tmux_session')).toBe('idle')
  })

  it('restores highlight and uses a safely quoted terminal fallback on switch failure', async () => {
    serverState.projectGroups[0].sessions[0].name = "bad'name"
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    fireEvent.click(screen.getByText("bad'name"))
    await waitFor(() => expect(sendInput).toHaveBeenCalledWith(" tmux attach -t 'bad'\"'\"'name'\r"))
    expect(screen.getByText('current').closest('button')).toHaveAttribute('aria-current', 'page')
    serverState.projectGroups[0].sessions[0].name = 'idle'
  })

  it('keeps new session, quick shell, detach, and kill actions available', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    await user.click(screen.getByText('+ New Session'))
    expect(screen.getByText('New Tmux Session')).toBeInTheDocument()
    await user.click(screen.getByText('Cancel'))
    await user.click(screen.getByText('Quick Shell'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tmux/quick-shell?client_tty=%2Fdev%2Fttys001', expect.anything()))
    await user.click(screen.getByText('Detach to Shell'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tmux/detach?client_tty=%2Fdev%2Fttys001', expect.anything()))
    await user.click(screen.getByLabelText('Session actions for idle'))
    await user.click(screen.getByText('Kill Session'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tmux/kill?name=idle', expect.anything()))
  })

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const mockHerdr = (list: () => unknown, routes: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>> = {}) => (
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url === '/api/herdr/list') return Promise.resolve(json(list()))
      const route = Object.keys(routes).find(prefix => url.startsWith(prefix))
      if (route) return Promise.resolve(routes[route](url, init))
      if (url === '/api/herdr/long-run') return Promise.resolve(json({ panes: {} }))
      return Promise.resolve(json({}))
    })
  )

  const openHerdr = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    await user.click(screen.getByRole('tab', { name: 'Herdr' }))
  }

  const herdrFleet = {
    workspaces: [
      { workspace_id: 'w9', label: 'shells', active_tab_id: 'w9:t2' },
      { workspace_id: 'w3', label: 'rust-terminal' },
      { workspace_id: 'w1', label: 'api' },
    ],
    tabs: [
      { tab_id: 'w9:t1', workspace_id: 'w9', label: '1' },
      { tab_id: 'w9:t2', workspace_id: 'w9', label: '2' },
      { tab_id: 'w3:t1', workspace_id: 'w3', label: '1' },
      { tab_id: 'w3:t2', workspace_id: 'w3', label: 'logs' },
      { tab_id: 'w1:t1', workspace_id: 'w1', label: '1' },
    ],
    panes: [
      { pane_id: 'w9:p1', workspace_id: 'w9', tab_id: 'w9:t1', terminal_title_stripped: 'me@host:/work/shells' },
      { pane_id: 'w9:p2', workspace_id: 'w9', tab_id: 'w9:t2', terminal_title_stripped: 'me@host:/work/shells', focused: true },
      { pane_id: 'w3:p1', workspace_id: 'w3', tab_id: 'w3:t1', agent: 'claude', foreground_cwd: '/home/me/work/rust-terminal' },
      { pane_id: 'w3:p2', workspace_id: 'w3', tab_id: 'w3:t2', terminal_title_stripped: 'tail -f' },
      { pane_id: 'w3:p3', workspace_id: 'w3', tab_id: 'w3:t2', terminal_title_stripped: 'htop' },
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'codex' },
    ],
    agents: [
      { pane_id: 'w3:p1', agent: 'claude', agent_status: 'working', name: 'claude-2', terminal_title_stripped: 'Fix the sidebar' },
      { pane_id: 'w1:p1', agent: 'codex', agent_status: 'blocked' },
    ],
  }

  it('lists Herdr workspaces in Herdr order, tabs as rows, and terminal-only workspaces folded at the bottom', async () => {
    const user = userEvent.setup()
    mockHerdr(() => herdrFleet, { '/api/herdr/long-run': () => json({ panes: { 'w3:p1': 600000 } }) })
    await openHerdr(user)

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/herdr/list', expect.objectContaining({ signal: expect.any(AbortSignal) })))
    const agentHeads = [await screen.findByText('rust-terminal'), screen.getByText('api')]
    expect(agentHeads[0].compareDocumentPosition(agentHeads[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Fix the sidebar')).toBeInTheDocument()
    expect(screen.getByText('claude · @claude-2')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '工作中' })).toBeInTheDocument()
    expect(await screen.findByText('600k')).toHaveAttribute('title', '上下文到 600k tokens 才自动压缩（long run）')
    expect(screen.getByText('logs')).toBeInTheDocument()
    expect(document.querySelector('[data-tab-id="w3:t2"]')?.querySelectorAll('[data-pane-id]')).toHaveLength(2)
    expect(screen.queryByText('unknown')).not.toBeInTheDocument()

    const terminals = screen.getByRole('button', { name: /只有终端/ })
    expect(terminals).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('shells')).not.toBeInTheDocument()
    await user.click(terminals)
    await user.click(screen.getByText('shells'))
    expect(switchTerminal).toHaveBeenCalledWith('herdr', 'w9:p2')
    expect(screen.getByText(/Choose a Herdr pane to connect/)).toBeInTheDocument()
    expect(screen.getByText('+ New Workspace')).toBeInTheDocument()
  })

  it('collapses and expands every agent workspace at once and remembers it', async () => {
    const user = userEvent.setup()
    mockHerdr(() => herdrFleet)
    await openHerdr(user)

    await user.click(await screen.findByRole('button', { name: '全部收起' }))
    expect(screen.queryByText('Fix the sidebar')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: '工作中' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('herdr_sidebar_folded') ?? '[]')).toEqual(['w3', 'w1'])
    await user.click(screen.getByRole('button', { name: '全部展开' }))
    expect(screen.getByText('Fix the sidebar')).toBeInTheDocument()
  })

  it('accepts rapid Herdr clicks and forwards the latest target without blocking the list', async () => {
    const user = userEvent.setup()
    const fetchMock = mockHerdr(() => herdrFleet)
    await openHerdr(user)
    const firstPane = await screen.findByText('Fix the sidebar')
    await user.click(firstPane)
    fireEvent.click(screen.getByText('logs'))

    expect(firstPane.closest('button')).not.toBeDisabled()
    expect(screen.getByText('logs').closest('button')).toHaveAttribute('aria-busy', 'true')
    expect(switchTerminal).toHaveBeenNthCalledWith(1, 'herdr', 'w3:p1')
    expect(switchTerminal).toHaveBeenNthCalledWith(2, 'herdr', 'w3:p2')
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/herdr/focus')).length).toBe(0)
  })

  it('creates an unnamed Herdr tab straight from + and attaches to its pane', async () => {
    const user = userEvent.setup()
    const fetchMock = mockHerdr(() => herdrFleet, { '/api/herdr/create': () => json({ success: true, tabId: 'w3:t3', paneId: 'w3:p9' }) })
    await openHerdr(user)
    await user.click(await screen.findByRole('button', { name: 'New tab in rust-terminal' }))

    await waitFor(() => expect(switchTerminal).toHaveBeenCalledWith('herdr', 'w3:p9'))
    expect(fetchMock).toHaveBeenCalledWith('/api/herdr/create?workspace=w3', expect.anything())
    expect(screen.queryByPlaceholderText(/Tab name/)).not.toBeInTheDocument()
  })

  it('copies a pane id, agent name, and dispatch text from the row menu', async () => {
    const user = userEvent.setup()
    mockHerdr(() => herdrFleet)
    await openHerdr(user)
    const row = (await screen.findByText('Fix the sidebar')).closest('[data-pane-id]') as HTMLElement

    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 })
    const menu = screen.getByRole('menu', { name: 'Fix the sidebar' })
    expect(menu).toHaveTextContent('w3:p1')
    expect(menu).toHaveTextContent('claude-2')
    await user.click(screen.getByRole('menuitem', { name: /复制窗格 ID/ }))
    expect(await navigator.clipboard.readText()).toBe('w3:p1')
    expect(screen.getByRole('status')).toHaveTextContent('已复制窗格 ID')

    await user.click(screen.getByLabelText('Actions for w3:p1'))
    await user.click(screen.getByRole('menuitem', { name: '复制派活命令' }))
    expect(await navigator.clipboard.readText()).toBe('herdr agent prompt claude-2 "这里写任务" --wait --timeout 600000')

    await user.click(screen.getByLabelText('Actions for w3:p1'))
    await user.click(screen.getByRole('menuitem', { name: '复制派活说明（贴给其他 agent）' }))
    expect(await navigator.clipboard.readText()).toContain('herdr agent get claude-2')

    await user.click(screen.getByLabelText('Actions for w3:p2'))
    expect(screen.queryByRole('menuitem', { name: '复制派活命令' })).not.toBeInTheDocument()
  })

  it('writes tab and workspace moves back to Herdr', async () => {
    const user = userEvent.setup()
    const fetchMock = mockHerdr(() => herdrFleet, { '/api/herdr/move': () => json({ success: true }) })
    await openHerdr(user)

    await user.click(await screen.findByLabelText('Actions for w3:p2'))
    await user.click(screen.getByRole('menuitem', { name: '标签页上移' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/herdr/move?tab=w3%3At2&index=0', expect.anything()))

    const apiGroup = document.querySelector('[data-workspace-id="w1"]') as HTMLElement
    fireEvent.dragStart(apiGroup.querySelector('[aria-expanded]') as HTMLElement)
    fireEvent.dragOver(document.querySelector('[data-workspace-id="w3"]') as HTMLElement, { clientY: 0 })
    fireEvent.drop(document.querySelector('[data-workspace-id="w3"]') as HTMLElement, { clientY: 0 })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/herdr/move?workspace=w1&index=1', expect.anything()))
  })

  // The rename modal selects its text 50ms after opening; typing before that would be overwritten.
  const settleRenameModal = () => act(() => new Promise(resolve => window.setTimeout(resolve, 60)))

  const mockRenamableHerdr = (renameResponses: Array<() => Promise<Response>> = []) => {
    const labels: Record<string, string> = { w3: 'rust-terminal', 'w3:t1': '1', 'w3:t2': 'logs' }
    const renames: Array<{ kind: string; id: string; label: string }> = []
    mockHerdr(() => ({
      workspaces: [{ workspace_id: 'w3', label: labels.w3 }],
      tabs: [
        { tab_id: 'w3:t1', workspace_id: 'w3', label: labels['w3:t1'] },
        { tab_id: 'w3:t2', workspace_id: 'w3', label: labels['w3:t2'] },
      ],
      panes: [
        { pane_id: 'w3:p1', workspace_id: 'w3', tab_id: 'w3:t1', agent: 'claude', title: 'Clean git state' },
        { pane_id: 'w3:p2', workspace_id: 'w3', tab_id: 'w3:t2', terminal_title_stripped: 'tail -f' },
      ],
      agents: [{ pane_id: 'w3:p1', agent: 'claude', agent_status: 'idle' }],
    }), {
      '/api/herdr/rename': (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { kind: string; id: string; label: string }
        renames.push(body)
        const scripted = renameResponses.shift()
        if (scripted) return scripted()
        labels[body.id] = body.label
        return json({ success: true })
      },
    })
    return renames
  }

  it('renames workspaces and tabs from their menus without changing the pane target', async () => {
    const user = userEvent.setup()
    const renames = mockRenamableHerdr()
    await openHerdr(user)

    expect(await screen.findByText('Clean git state')).toBeInTheDocument()
    expect(screen.getByText('logs')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Search workspaces or panes'), 'w3:p2')
    expect(screen.getByText('logs')).toBeInTheDocument()
    expect(screen.queryByText('Clean git state')).not.toBeInTheDocument()
    await user.clear(screen.getByPlaceholderText('Search workspaces or panes'))

    await user.click(screen.getByRole('button', { name: 'Actions for workspace rust-terminal' }))
    await user.click(screen.getByRole('menuitem', { name: '重命名工作区' }))
    await settleRenameModal()
    const workspaceInput = screen.getByRole('textbox', { name: 'Workspace name' })
    expect(workspaceInput).toHaveValue('rust-terminal')
    await user.clear(workspaceInput)
    await user.type(workspaceInput, 'api{Enter}')
    expect(await screen.findByText('api')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Actions for w3:p1'))
    await user.click(screen.getByRole('menuitem', { name: '重命名标签页' }))
    await settleRenameModal()
    const tabInput = screen.getByRole('textbox', { name: 'Tab name' })
    expect(tabInput).toHaveValue('1')
    await user.clear(tabInput)
    await user.type(tabInput, 'deploy')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('deploy')).toBeInTheDocument()

    expect(renames).toEqual([
      { kind: 'workspace', id: 'w3', label: 'api' },
      { kind: 'tab', id: 'w3:t1', label: 'deploy' },
    ])
    await user.click(screen.getByText('deploy'))
    expect(switchTerminal).toHaveBeenCalledWith('herdr', 'w3:p1')
  })

  it('keeps the typed Herdr name after a failed rename, blocks double submit, and retries', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let rejectFirst: (response: Response) => void = () => undefined
    const renames = mockRenamableHerdr([
      () => new Promise(resolve => { rejectFirst = resolve }),
    ])
    await openHerdr(user)
    await user.click(await screen.findByLabelText('Actions for w3:p2'))
    await user.click(screen.getByRole('menuitem', { name: '重命名标签页' }))
    await settleRenameModal()
    const input = screen.getByRole('textbox', { name: 'Tab name' })
    await user.clear(input)
    await user.type(input, 'errors')
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(save)
    fireEvent.click(save)
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(renames).toHaveLength(1)

    rejectFirst(new Response(JSON.stringify({ error: 'rename_failed', message: 'tab_not_found: tab w3:t2 not found' }), { status: 502 }))
    expect(await screen.findByRole('alert')).toHaveTextContent('tab_not_found: tab w3:t2 not found')
    expect(screen.getByRole('textbox', { name: 'Tab name' })).toHaveValue('errors')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('errors')).toBeInTheDocument()
    expect(renames).toEqual([
      { kind: 'tab', id: 'w3:t2', label: 'errors' },
      { kind: 'tab', id: 'w3:t2', label: 'errors' },
    ])
  })

  it('closes a Herdr pane only after confirming', async () => {
    const user = userEvent.setup()
    const fetchMock = mockHerdr(() => herdrFleet)
    await openHerdr(user)
    await user.click(await screen.findByLabelText('Actions for w3:p2'))
    await user.click(screen.getByRole('menuitem', { name: '关闭窗格' }))
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/herdr/close'))).toBe(false)
    await user.click(screen.getByRole('button', { name: '确认关闭' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/herdr/close?pane=w3%3Ap2', expect.anything()))
  })

  it('shows an actionable Herdr unavailable state', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }))

    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    await user.click(screen.getByRole('tab', { name: 'Herdr' }))

    expect(await screen.findByText('Herdr 工作区刷新失败')).toBeInTheDocument()
    expect(screen.getByText(/正在自动重试/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
  it('keeps the last workspace list visible when a refresh fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let fail = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(input => Promise.resolve(
      String(input) === '/api/herdr/list'
        ? fail ? new Response('unavailable', { status: 503 }) : json(herdrFleet)
        : json({}),
    ))
    await openHerdr(user)
    expect(await screen.findByText('rust-terminal')).toBeInTheDocument()
    fail = true
    await user.click(screen.getByRole('button', { name: 'Refresh herdr workspaces' }))
    expect(await screen.findByText('Herdr 工作区刷新失败')).toBeInTheDocument()
    expect(screen.getByText('rust-terminal')).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('Herdr 工作区刷新失败')).not.toBeInTheDocument())
    expect(screen.getByText('rust-terminal')).toBeInTheDocument()
  })

})
