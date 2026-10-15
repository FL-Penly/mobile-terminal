import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InputSendResult, SubmitTextOptions } from '../../contexts/TerminalContext'
import { CopyModeOverlay, INSERT_TEXT_EVENT } from '../CopyModeOverlay'

const terminal = {
  mux: 'tmux' as 'tmux' | 'herdr',
  paneId: null as string | null,
  clientTty: null as string | null,
  submitText: vi.fn<(text: string, options?: SubmitTextOptions) => Promise<InputSendResult>>(),
}

const serverEvents = {
  tmuxSessions: [] as { name: string; agentStatus?: string }[],
  projectGroups: [] as { sessions: { name: string; command: string }[] }[],
  otherSessions: [] as { name: string; command: string }[],
  tuiActive: false,
}

vi.mock('../../contexts/TerminalContext', () => ({ useTerminal: () => terminal }))
vi.mock('../../contexts/ServerEventsContext', () => ({ useServerEvents: () => serverEvents }))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const transcriptPage = {
  agent: 'claude',
  agentStatus: 'idle',
  session: '/home/u/.claude/projects/-w/s.jsonl',
  cursor: null,
  hasMore: false,
  blocks: [
    { kind: 'user', id: '1-0', text: '跑一下测试' },
    { kind: 'assistant', id: '2-0', text: '好的，先看 `lib.rs`。' },
    { kind: 'code', id: '2-1', lang: 'rust', text: 'let x = 1;' },
    { kind: 'command', id: '3-0', command: 'cargo test', output: 'test a ... ok\ntest b ... FAILED', isError: true, exitCode: 101 },
  ],
}

const LOCAL_LINES = ['$ ls', 'a.txt', 'b.txt', '$ cat a.txt', 'hello']

const setHerdrAgentPane = (status = 'idle') => {
  terminal.mux = 'herdr'
  terminal.paneId = 'w1:p1'
  serverEvents.tmuxSessions = [{ name: 'w1:p1', agentStatus: status }]
  serverEvents.projectGroups = [{ sessions: [{ name: 'w1:p1', command: 'claude' }] }]
}

const gutter = (index: number) => {
  const row = document.querySelector(`[data-row="${index}"]`)
  const cell = row?.querySelector('[data-gutter]')
  if (!(cell instanceof HTMLElement)) throw new Error(`no gutter for row ${index}`)
  return cell
}

const dragGutter = (from: number, to: number) => {
  document.elementFromPoint = vi.fn(() => gutter(to))
  fireEvent.pointerDown(gutter(from), { button: 0, pointerId: 1, clientY: 10 })
  fireEvent.pointerMove(screen.getByTestId('terminal-copy-scroll'), { pointerId: 1, clientY: 60 })
  fireEvent.pointerUp(screen.getByTestId('terminal-copy-scroll'), { pointerId: 1, clientY: 60 })
}

describe('CopyModeOverlay', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    terminal.mux = 'tmux'
    terminal.paneId = null
    terminal.submitText.mockReset()
    serverEvents.tmuxSessions = []
    serverEvents.projectGroups = []
    serverEvents.otherSessions = []
    serverEvents.tuiActive = false
    fetchMock = vi.fn((url: string) => Promise.resolve(
      url.startsWith('/api/herdr/transcript') ? json(transcriptPage) : json({ error: 'no_session' }, 400),
    ))
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('selects logical lines by dragging the line-number gutter', async () => {
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={vi.fn()} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tmux/page-up?before=0', expect.anything()))

    dragGutter(1, 3)

    expect(screen.getByText('已选 3 行')).toBeInTheDocument()
    expect(screen.getByTestId('copy-preview').textContent).toBe('a.txt\nb.txt\n$ cat a.txt')
    expect(screen.getByLabelText('拖动调整起点')).toBeInTheDocument()
    expect(screen.getByLabelText('拖动调整终点')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '去掉前缀' }))
    expect(screen.getByTestId('copy-preview').textContent).toBe('a.txt\nb.txt\ncat a.txt')
    fireEvent.click(screen.getByRole('button', { name: '合并成一行' }))
    expect(screen.getByTestId('copy-preview').textContent).toBe('a.txt b.txt cat a.txt')
  })

  it('moves only the dragged end when a handle is pulled', async () => {
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={vi.fn()} />)
    dragGutter(1, 2)
    document.elementFromPoint = vi.fn(() => gutter(4))
    fireEvent.pointerDown(screen.getByLabelText('拖动调整终点'), { button: 0, pointerId: 2, clientY: 40 })
    fireEvent.pointerMove(screen.getByTestId('terminal-copy-scroll'), { pointerId: 2, clientY: 90 })
    fireEvent.pointerUp(screen.getByTestId('terminal-copy-scroll'), { pointerId: 2, clientY: 90 })
    expect(screen.getByText('已选 4 行')).toBeInTheDocument()
    expect(screen.getByTestId('copy-preview').textContent).toBe('a.txt\nb.txt\n$ cat a.txt\nhello')
  })

  it('prefers unwrapped server history and keeps the search box unfocused', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ lines: ['server line one', 'server line two', ''], cursor: 3, hasMore: false })))
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={vi.fn()} />)
    expect(await screen.findByText('server line two')).toBeInTheDocument()
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
    const search = screen.getByPlaceholderText('搜索终端内容…')
    expect(document.activeElement).not.toBe(search)
    expect(search).toHaveAttribute('autocapitalize', 'off')
    expect(search).toHaveAttribute('autocorrect', 'off')
    expect(search).toHaveAttribute('spellcheck', 'false')
  })

  it('shows a pre-selected manual copy box instead of claiming success when copying fails', async () => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={vi.fn()} />)
    dragGutter(0, 0)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))

    const dialog = await screen.findByRole('dialog', { name: '手动复制' })
    const textarea = within(dialog).getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('$ ls')
    expect(textarea).toHaveAttribute('readonly')
    expect(textarea.selectionStart).toBe(0)
    expect(textarea.selectionEnd).toBe(4)
    expect(screen.queryByText(/已复制/)).not.toBeInTheDocument()
  })

  it('confirms a successful copy', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={vi.fn()} />)
    dragGutter(1, 2)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(await screen.findByText('已复制 · 2 行')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith('a.txt\nb.txt')
  })

  it('opens the conversation view for an agent pane and copies picked blocks', async () => {
    setHerdrAgentPane()
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={vi.fn()} />)
    const user = await screen.findByText('跑一下测试')
    expect(screen.getByRole('button', { name: '对话' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(user)
    fireEvent.click(screen.getByText('let x = 1;'))
    expect(screen.getByText('已选 2 块 · 2 行')).toBeInTheDocument()
    expect(screen.getByTestId('copy-preview').textContent).toBe('跑一下测试\n\nlet x = 1;')
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect(screen.getByTestId('copy-preview').textContent).toBe('> 跑一下测试\n\n```rust\nlet x = 1;\n```')

    fireEvent.click(screen.getByText('跑一下测试'))
    expect(screen.getByText('已选 1 块 · 1 行')).toBeInTheDocument()
  })

  it('copies a command and its output separately from the command card', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    setHerdrAgentPane()
    render(<CopyModeOverlay lines={[]} initialScrollLine={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '复制命令' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('cargo test'))
    fireEvent.click(screen.getByRole('button', { name: '复制输出' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('test a ... ok\ntest b ... FAILED'))
    expect(screen.getByText('退出码 101')).toBeInTheDocument()
    expect(screen.queryByText(/已选/)).not.toBeInTheDocument()
  })

  it('warns that a blocked agent is waiting and switches to the terminal on tap', async () => {
    setHerdrAgentPane('blocked')
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={vi.fn()} />)
    const banner = await screen.findByText('agent 正在等待确认')
    fireEvent.click(banner)
    expect(screen.getByRole('button', { name: '终端' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('falls back to the terminal view and explains why the conversation is unavailable', async () => {
    terminal.mux = 'herdr'
    terminal.paneId = 'w1:p2'
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.startsWith('/api/herdr/transcript')
      ? json({ error: 'no_agent', message: '当前 pane 没有检测到 Claude Code 或 Codex' }, 404)
      : json({ lines: ['shell'], cursor: 1, hasMore: false })))
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={vi.fn()} />)
    expect(await screen.findByText('对话视图不可用：当前 pane 没有检测到 Claude Code 或 Codex')).toBeInTheDocument()
    const chatButton = screen.getByRole('button', { name: '对话' })
    expect(chatButton).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(chatButton)
    expect(screen.getByRole('button', { name: '终端' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('hands a quoted selection to the text input and closes', async () => {
    const onClose = vi.fn()
    const received: string[] = []
    const listener = (event: Event) => received.push((event as CustomEvent<{ text: string }>).detail.text)
    window.addEventListener(INSERT_TEXT_EVENT, listener)
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={onClose} />)
    dragGutter(1, 2)
    fireEvent.click(screen.getByRole('button', { name: '放进输入框' }))
    window.removeEventListener(INSERT_TEXT_EVENT, listener)
    expect(received).toEqual(['> a.txt\n> b.txt\n\n'])
    expect(onClose).toHaveBeenCalled()
  })

  it('submits the selection to the agent with Enter', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setHerdrAgentPane()
    terminal.submitText.mockResolvedValue({ ok: true, byteLength: 10 })
    const onClose = vi.fn()
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={onClose} />)
    fireEvent.click(await screen.findByText('跑一下测试'))
    fireEvent.click(screen.getByRole('button', { name: '问 agent' }))
    await waitFor(() => expect(terminal.submitText).toHaveBeenCalledWith(
      '请解释或处理下面这段内容：\n\n跑一下测试',
      { submit: true },
    ))
    expect(await screen.findByText('已发给 agent')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(onClose).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('refuses to send to an agent that is waiting for confirmation', async () => {
    setHerdrAgentPane('blocked')
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('跑一下测试'))
    fireEvent.click(screen.getByRole('button', { name: '问 agent' }))
    expect(await screen.findByText('agent 正在等待确认，先在终端里处理')).toBeInTheDocument()
    expect(terminal.submitText).not.toHaveBeenCalled()
  })

  it('never types a prompt into a plain shell', async () => {
    render(<CopyModeOverlay lines={LOCAL_LINES} initialScrollLine={0} onClose={vi.fn()} />)
    dragGutter(0, 1)
    fireEvent.click(screen.getByRole('button', { name: '问 agent' }))
    expect(await screen.findByText(/当前 pane 没有运行 agent/)).toBeInTheDocument()
    expect(terminal.submitText).not.toHaveBeenCalled()
  })
})
