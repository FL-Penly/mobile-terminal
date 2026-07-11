import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TmuxSidebar } from '../TmuxSidebar'

const sendInput = vi.fn()
const refresh = vi.fn()
const terminalState = { sendInput }
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
  currentTmuxSession: 'current',
  clientTty: '/dev/ttys001',
  path: '/work/alpha',
  sessionsLoaded: true,
  refresh,
}

vi.mock('../../contexts/TerminalContext', () => ({ useTerminal: () => terminalState }))
vi.mock('../../contexts/ServerEventsContext', () => ({ useServerEvents: () => serverState }))

describe('TmuxSidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sendInput.mockReset()
    refresh.mockReset()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('keeps persisted project order, highlights the active project, and sorts the current session first', () => {
    localStorage.setItem('tmux_sidebar_group_order', JSON.stringify(['/work/beta', '/work/alpha']))
    render(<TmuxSidebar mobile={false} onClose={vi.fn()} onCollapseDesktop={vi.fn()} />)
    const headings = screen.getAllByRole('button').filter(button => ['alpha', 'beta', 'Other'].some(label => button.textContent?.includes(label)))
    expect(headings.map(button => button.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('alpha'), expect.stringContaining('beta'), expect.stringContaining('Other')]))
    const names = ['current', 'active-news', 'idle', 'loose'].map(name => screen.getByText(name))
    expect(names[0].compareDocumentPosition(names[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('beta').compareDocumentPosition(screen.getByText('alpha')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('beta').compareDocumentPosition(screen.getByText('Other')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('alpha').closest('section')).toHaveAttribute('data-active-project', 'true')
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
    await user.click(screen.getByLabelText('Kill idle'))
    await user.click(screen.getByText('Kill Session'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tmux/kill?name=idle', expect.anything()))
  })
})
