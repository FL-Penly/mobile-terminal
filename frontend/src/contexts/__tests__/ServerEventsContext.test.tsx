import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerEventsProvider, useServerEvents, useTerminalModes } from '../ServerEventsContext'

const terminalState: { clientTty: string | null; mux: 'tmux' | 'herdr'; paneId: string | null } = {
  clientTty: '/dev/ttys001',
  mux: 'tmux',
  paneId: null,
}

vi.mock('../TerminalContext', () => ({ useTerminal: () => terminalState }))

class EventSourceMock {
  static instances: EventSourceMock[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()
  constructor(public readonly url: string) { EventSourceMock.instances.push(this) }
}

const Probe = () => {
  const { sessionsLoaded, projectGroups, isOffline, tuiActive, herdrScrollback } = useServerEvents()
  const status = projectGroups[0]?.sessions[0]?.agentStatus
  return <div data-tui-active={tuiActive ? 'true' : 'false'} data-herdr-scrollback={herdrScrollback ? 'true' : 'false'}>{sessionsLoaded ? 'loaded' : 'loading'}:{projectGroups.length}:{isOffline ? 'offline' : 'online'}{status ? `:${status}` : ''}</div>
}

describe('ServerEventsProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    terminalState.clientTty = '/dev/ttys001'
    terminalState.mux = 'tmux'
    terminalState.paneId = null
    EventSourceMock.instances = []
    vi.stubGlobal('EventSource', EventSourceMock)
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/diff')) return Promise.resolve(new Response(JSON.stringify({ branch: 'main', git_root: '/repo' })))
      if (url.startsWith('/api/tmux/pane-mode')) return Promise.resolve(new Response(JSON.stringify({ tuiActive: false })))
      return Promise.resolve(new Response(JSON.stringify({ sessions: [], currentSession: null, scannedAt: 1, projectGroups: [], otherSessions: [] })))
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not rerender terminal mode consumers for unrelated session updates', async () => {
    terminalState.mux = 'herdr'
    terminalState.paneId = 'w4:p1'
    const rendered = vi.fn()
    const ModesProbe = () => {
      const modes = useTerminalModes()
      rendered(modes)
      return <div data-testid="modes">{JSON.stringify(modes)}</div>
    }
    render(<ServerEventsProvider><ModesProbe /></ServerEventsProvider>)
    await act(async () => { await Promise.resolve() })
    const sendSnapshot = (revision: number, lensChat = false) => act(() => {
      EventSourceMock.instances[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({
        herdr: { panes: [{ pane_id: 'w4:p1', workspace_id: 'w4', revision, lens_chat: lensChat }] },
      }) }))
    })
    sendSnapshot(1)
    const initialRenders = rendered.mock.calls.length
    for (let revision = 2; revision <= 21; revision++) sendSnapshot(revision)
    expect(rendered).toHaveBeenCalledTimes(initialRenders)
    sendSnapshot(22, true)
    expect(rendered).toHaveBeenCalledTimes(initialRenders + 1)
    expect(screen.getByTestId('modes')).toHaveTextContent('"lensChat":true')
    expect(screen.getByTestId('modes')).toHaveTextContent('"tuiActive":true')
  })

  it('handles an empty snapshot, falls back to polling, and reconnects SSE', async () => {
    render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    await waitFor(() => expect(screen.getByText('loaded:0:online')).toBeInTheDocument())
    expect(EventSourceMock.instances).toHaveLength(1)
    expect(EventSourceMock.instances[0].url).toContain('client_tty=%2Fdev%2Fttys001')

    act(() => { EventSourceMock.instances[0].onerror?.(new Event('error')) })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/diff?metadata_only=true&client_tty='), expect.anything()))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(EventSourceMock.instances).toHaveLength(2)
    act(() => { EventSourceMock.instances[1].onopen?.(new Event('open')) })
    expect(EventSourceMock.instances[0].close).toHaveBeenCalled()
  })

  it('applies realtime herdr status and notifies once when work becomes idle', async () => {
    terminalState.clientTty = null
    terminalState.mux = 'herdr'
    terminalState.paneId = 'w4:p1'
    const notifications: Array<{ title: string; body?: string }> = []
    class NotificationMock {
      static permission = 'granted'
      constructor(title: string, options?: NotificationOptions) {
        notifications.push({ title, body: options?.body })
      }
    }
    vi.stubGlobal('Notification', NotificationMock)
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/diff')) return Promise.resolve(new Response(JSON.stringify({ branch: '', cwd: '/tmp' })))
      return Promise.resolve(new Response(JSON.stringify({
        panes: [{ pane_id: 'w4:p1', workspace_id: 'w4', cwd: '/tmp', agent_status: 'working' }],
        workspaces: [{ workspace_id: 'w4', label: 'test' }],
        agents: [{ pane_id: 'w4:p1', agent: 'claude', agent_status: 'working' }],
      })))
    }))

    render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    await waitFor(() => expect(screen.getByText('loaded:1:online:working')).toBeInTheDocument())
    expect(screen.getByText('loaded:1:online:working')).toHaveAttribute('data-tui-active', 'true')
    expect(screen.getByText('loaded:1:online:working')).toHaveAttribute('data-herdr-scrollback', 'false')
    expect(EventSourceMock.instances[0].url).toContain('mux=herdr')
    expect(fetch).toHaveBeenCalledWith('/api/diff?metadata_only=true&mux=herdr&pane=w4%3Ap1', expect.anything())
    act(() => {
      EventSourceMock.instances[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({
        herdr: {
          panes: [{ pane_id: 'w4:p1', workspace_id: 'w4', cwd: '/tmp', agent_status: 'idle' }],
          workspaces: [{ workspace_id: 'w4', label: 'test' }],
          agents: [{ pane_id: 'w4:p1', agent: 'claude', agent_status: 'idle' }],
        },
      }) }))
    })
    await waitFor(() => expect(screen.getByText('loaded:1:online:idle')).toBeInTheDocument())
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(notifications).toEqual([{ title: 'Rust Terminal agent update', body: 'w4:p1 is idle' }])
  })

  it('routes Herdr agents without mouse reporting to Herdr scrollback', async () => {
    terminalState.clientTty = null
    terminalState.mux = 'herdr'
    terminalState.paneId = 'w5:pV'
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(new Response(JSON.stringify(
      String(input).startsWith('/api/diff')
        ? { branch: '', cwd: '/tmp' }
        : {
            panes: [{ pane_id: 'w5:pV', workspace_id: 'w5', cwd: '/tmp', agent_status: 'idle' }],
            workspaces: [{ workspace_id: 'w5', label: 'test' }],
            agents: [{ pane_id: 'w5:pV', agent: 'cursor', agent_status: 'idle' }],
          },
    )))))

    render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    await waitFor(() => expect(screen.getByText('loaded:1:online:idle')).toBeInTheDocument())
    expect(screen.getByText('loaded:1:online:idle')).toHaveAttribute('data-tui-active', 'false')
    expect(screen.getByText('loaded:1:online:idle')).toHaveAttribute('data-herdr-scrollback', 'true')
  })

  it('applies Herdr workspace and tab renames pushed over SSE while keeping pane ids', async () => {
    terminalState.clientTty = null
    terminalState.mux = 'herdr'
    terminalState.paneId = 'w4:p1'
    const snapshot = (workspaceLabel: string, tabLabel: string) => ({
      workspaces: [{ workspace_id: 'w4', label: workspaceLabel }],
      tabs: [{ tab_id: 'w4:t1', workspace_id: 'w4', label: tabLabel }],
      panes: [{ pane_id: 'w4:p1', workspace_id: 'w4', tab_id: 'w4:t1', terminal_title_stripped: 'Claude Code' }],
      agents: [],
    })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(new Response(JSON.stringify(
      String(input).startsWith('/api/diff') ? { branch: '', cwd: '/tmp' } : snapshot('test', '1'),
    )))))
    const NameProbe = () => {
      const { projectGroups } = useServerEvents()
      const group = projectGroups[0]
      const session = group?.sessions[0]
      return <div>{group ? `${group.displayName}/${session?.displayName}/${session?.name}` : 'empty'}</div>
    }

    render(<ServerEventsProvider><NameProbe /></ServerEventsProvider>)
    expect(await screen.findByText('test/Claude Code/w4:p1')).toBeInTheDocument()
    act(() => {
      EventSourceMock.instances[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({
        herdr: snapshot('api', 'review'),
        event: { event: 'tab.renamed', data: { tab_id: 'w4:t1', workspace_id: 'w4', label: 'review' } },
      }) }))
    })
    expect(await screen.findByText('api/review/w4:p1')).toBeInTheDocument()
  })
  it('keeps healthy Herdr data when Git times out after SSE recovery', async () => {
    terminalState.mux = 'herdr'
    let rejectDiff: (reason: Error) => void = () => undefined
    const diff = new Promise<Response>((_resolve, reject) => { rejectDiff = reject })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).startsWith('/api/diff')
      ? diff : Promise.resolve(new Response(JSON.stringify({ panes: [], workspaces: [] })))))
    render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    await act(async () => {
      EventSourceMock.instances[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({ herdr: { panes: [] } }) }))
    })
    await act(async () => { rejectDiff(new Error('timeout')) })
    expect(screen.getByText('loaded:0:online')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('ignores an older list failure after an SSE snapshot', async () => {
    terminalState.mux = 'herdr'
    let rejectList: (reason: Error) => void = () => undefined
    const list = new Promise<Response>((_resolve, reject) => { rejectList = reject })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).startsWith('/api/diff')
      ? Promise.resolve(new Response('{}')) : list))
    render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    act(() => { EventSourceMock.instances[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({ herdr: { panes: [] } }) })) })
    await act(async () => { rejectList(new Error('old timeout')) })
    expect(screen.getByText('loaded:0:online')).toBeInTheDocument()
  })

  it('retries failed lists even if SSE opened without delivering data', async () => {
    terminalState.mux = 'herdr'
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/diff')) return Promise.resolve(new Response('{}'))
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(new Response('{"panes":[]}'))
    }))
    render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    act(() => { EventSourceMock.instances[0].onopen?.(new Event('open')) })
    await waitFor(() => expect(screen.getByText('loading:0:offline')).toBeInTheDocument())
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByText('loaded:0:online')).toBeInTheDocument()
    expect(attempts).toBe(2)
  })

  it('ignores a previous target response after switching panes', async () => {
    terminalState.mux = 'herdr'
    terminalState.paneId = 'old'
    let resolveOld: (response: Response) => void = () => undefined
    const old = new Promise<Response>(resolve => { resolveOld = resolve })
    let lists = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/diff')) return Promise.resolve(new Response('{}'))
      return ++lists === 1 ? old : Promise.resolve(new Response('{"panes":[]}'))
    }))
    const view = render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    terminalState.paneId = 'new'
    view.rerender(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    await waitFor(() => expect(screen.getByText('loaded:0:online')).toBeInTheDocument())
    await act(async () => { resolveOld(new Response('error', { status: 503 })) })
    expect(screen.getByText('loaded:0:online')).toBeInTheDocument()
  })

  it('does not let an old tmux fallback overwrite a new Herdr connection', async () => {
    let failOld: (error: Error) => void = () => undefined
    const old = new Promise<Response>((_resolve, reject) => { failOld = reject })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/diff') && !url.includes('mux=herdr')) return old
      return Promise.resolve(new Response('{}'))
    }))
    const view = render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    await act(async () => { EventSourceMock.instances[0].onerror?.(new Event('error')) })
    terminalState.mux = 'herdr'
    terminalState.paneId = 'new'
    view.rerender(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    act(() => { EventSourceMock.instances[EventSourceMock.instances.length - 1]?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ herdr: { panes: [] } }) })) })
    await act(async () => { failOld(new Error('old tmux timeout')) })
    expect(screen.getByText('loaded:0:online')).toBeInTheDocument()
  })

  it('coalesces Herdr refreshes and cancels retries when unmounted', async () => {
    terminalState.mux = 'herdr'
    let fail: (error: Error) => void = () => undefined
    const pending = new Promise<Response>((_resolve, reject) => { fail = reject })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).startsWith('/api/diff')
      ? Promise.resolve(new Response('{}')) : pending))
    const view = render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    act(() => {
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new Event('online'))
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => { fail(new Error('offline')) })
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(EventSourceMock.instances[0].close).toHaveBeenCalledTimes(1)
  })

})
