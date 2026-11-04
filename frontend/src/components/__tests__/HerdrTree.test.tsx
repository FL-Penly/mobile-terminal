import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HerdrTree } from '../HerdrTree'
import type { HerdrListPayload } from '../../utils/herdr-sessions'

const payload: HerdrListPayload = {
  workspaces: [{ workspace_id: 'w1', label: '开发' }],
  tabs: [{ tab_id: 't1', workspace_id: 'w1', label: '修复输入' }],
  panes: [{ pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', agent: 'codex', agent_status: 'working', title: '输入任务' }],
}
const props = {
  payload, loaded: true, query: '', selectedPaneId: 'p1', switchingPaneId: null,
  onSelect: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onChanged: vi.fn(),
}

describe('Herdr workspace folding', () => {
  beforeEach(() => localStorage.clear())
  afterEach(cleanup)

  it('folds the selected workspace, retaining its location and live status across refreshes', () => {
    const view = render(<HerdrTree {...props} />)
    const heading = screen.getByRole('button', { name: '工作区 开发' })
    fireEvent.click(heading)
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    expect(heading).toHaveTextContent('当前')
    expect(heading).toHaveTextContent('修复输入')
    expect(view.container.querySelector('[data-pane-id="p1"]')).toBeNull()
    expect(screen.getByRole('img', { name: '工作中' })).toHaveClass('motion-safe:animate-spin')
    view.rerender(<HerdrTree {...props} payload={{ ...payload, panes: payload.panes?.map(pane => ({ ...pane, agent_status: 'done' })) }} />)
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('img', { name: '已完成，还没看' })).toBeInTheDocument()
    view.unmount()
    render(<HerdrTree {...props} />)
    expect(screen.getByRole('button', { name: '工作区 开发' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('collapses all including the active workspace, and search does not overwrite the preference', () => {
    const view = render(<HerdrTree {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '全部收起' }))
    expect(screen.getByRole('button', { name: '工作区 开发' })).toHaveAttribute('aria-expanded', 'false')
    view.rerender(<HerdrTree {...props} query="开发" />)
    expect(screen.getByRole('button', { name: '工作区 开发' })).toHaveAttribute('aria-expanded', 'true')
    view.rerender(<HerdrTree {...props} />)
    expect(screen.getByRole('button', { name: '工作区 开发' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: '全部展开' }))
    expect(view.container.querySelector('[data-pane-id="p1"]')).not.toBeNull()
  })

  it('lets the terminals-only section collapse while retaining the active workspace label', () => {
    render(<HerdrTree {...props} payload={{ ...payload, panes: payload.panes?.map(pane => ({ ...pane, agent: null })) }} />)
    const heading = screen.getByRole('button', { name: /只有终端/ })
    fireEvent.click(heading)
    expect(heading).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(heading)
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    expect(heading).toHaveTextContent('当前 · 开发')
  })
})

describe('Herdr goal badge', () => {
  afterEach(cleanup)

  it('marks an open or paused /goal next to the agent and shows nothing without one', () => {
    const withGoal = (lens_goal?: string): HerdrListPayload => ({
      ...payload,
      panes: payload.panes?.map(pane => ({ ...pane, tokens: lens_goal ? { lens_goal } : {} })),
    })
    const view = render(<HerdrTree {...props} payload={withGoal('goal')} />)
    expect(screen.getByTitle('有进行中的 /goal，目标尚未达成')).toHaveTextContent('goal')
    view.rerender(<HerdrTree {...props} payload={withGoal('paused')} />)
    expect(screen.getByTitle('/goal 已暂停')).toHaveTextContent('paused')
    view.rerender(<HerdrTree {...props} payload={withGoal()} />)
    expect(screen.queryByTitle(/\/goal/)).toBeNull()
  })
})

describe('Herdr lens window and background badges', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows the reported window and background tasks without duplicating the long-run window', async () => {
    const tokens = { lens_ctx: '258k', lens_bg: '2' }
    const view = render(<HerdrTree {...props} payload={{ ...payload, panes: payload.panes?.map(pane => ({ ...pane, tokens })) }} />)
    expect(screen.getByTitle('上下文窗口 258k tokens')).toHaveTextContent('258k')
    expect(screen.getByTitle('还有 2 个后台任务在运行')).toHaveTextContent('后台 2')
    view.unmount()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ panes: { p1: 500000 } }))))
    const claude = { ...payload, panes: payload.panes?.map(pane => ({ ...pane, agent: 'claude', tokens: { lens_ctx: '500k' } })) }
    const pane = render(<HerdrTree {...props} payload={claude} />).container.querySelector('[data-pane-id="p1"]')
    await waitFor(() => expect(screen.getByTitle('上下文到 500k tokens 才自动压缩（long run）')).toBeInTheDocument())
    expect(pane?.textContent?.match(/500k/g)).toHaveLength(1)
  })
})

describe('Herdr lens chat view', () => {
  const jsonResponse = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    fetchMock = vi.fn((url: string) => jsonResponse(url.startsWith('/api/herdr/chat') ? { success: true, paneId: 'p9' } : {}))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const openMenu = (view: ReturnType<typeof render>, paneId = 'p1') => {
    const row = view.container.querySelector(`[data-pane-id="${paneId}"]`)
    if (!row) throw new Error(`pane ${paneId} not rendered`)
    fireEvent.contextMenu(row)
  }

  it('offers the chat view on an agent pane only when herdr-lens is available', () => {
    const view = render(<HerdrTree {...props} payload={{ ...payload, lens: { chat: true } }} />)
    openMenu(view)
    expect(screen.getByRole('menuitem', { name: /会话视图/ })).toBeInTheDocument()
    cleanup()

    const without = render(<HerdrTree {...props} />)
    openMenu(without)
    expect(screen.queryByRole('menuitem', { name: /会话视图/ })).toBeNull()
    cleanup()

    const shell = render(<HerdrTree {...props} payload={{
      ...payload,
      lens: { chat: true },
      tabs: [...(payload.tabs ?? []), { tab_id: 't2', workspace_id: 'w1', label: 'shell' }],
      panes: [...(payload.panes ?? []), { pane_id: 'p2', workspace_id: 'w1', tab_id: 't2', title: 'zsh' }],
    }} />)
    openMenu(shell, 'p2')
    expect(screen.queryByRole('menuitem', { name: /会话视图/ })).toBeNull()
  })

  it('opens the chat view for the pane and switches to the returned chat pane once', async () => {
    const onOpen = vi.fn()
    const view = render(<HerdrTree {...props} onOpen={onOpen} payload={{ ...payload, lens: { chat: true } }} />)
    openMenu(view)
    fireEvent.click(screen.getByRole('menuitem', { name: /会话视图/ }))
    openMenu(view)
    fireEvent.click(screen.getByRole('menuitem', { name: /会话视图/ }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('p9'))
    const chatCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/herdr/chat'))
    expect(chatCalls).toEqual([['/api/herdr/chat?pane=p1', expect.anything()]])
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('labels a chat pane as the chat view in the tree', () => {
    const view = render(<HerdrTree {...props} payload={{
      ...payload,
      lens: { chat: true },
      panes: [...(payload.panes ?? []), { pane_id: 'p9', workspace_id: 'w1', tab_id: 't1', label: 'Chat', lens_chat: true }],
    }} />)
    expect(view.container.querySelector('[data-pane-id="p9"]')).toHaveTextContent('会话视图')
  })
})

describe('Herdr workspace closing', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const closeRequests = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/herdr/close'))

  it('requires confirmation, sends the workspace target, and refreshes after success', async () => {
    render(<HerdrTree {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Actions for workspace 开发' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭工作区' }))
    expect(screen.getByRole('dialog', { name: '关闭工作区' })).toHaveTextContent('全部标签页和窗格（当前 1 个窗格）')
    expect(closeRequests()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(closeRequests()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Actions for workspace 开发' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '确认关闭' }))
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1))
    expect(closeRequests()).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/herdr/close?workspace=w1', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('offers close after a touch long press', async () => {
    vi.useFakeTimers()
    render(<HerdrTree {...props} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: '工作区 开发' }), { pointerType: 'touch', clientX: 40, clientY: 80 })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.getByRole('menuitem', { name: '关闭工作区' })).toBeInTheDocument()
    expect(closeRequests()).toHaveLength(0)
  })

  it('also closes an empty terminals-only workspace through its menu', async () => {
    render(<HerdrTree {...props} payload={{ workspaces: [{ workspace_id: 'empty:1', label: '空工作区' }], tabs: [], panes: [] }} />)
    fireEvent.click(screen.getByRole('button', { name: /只有终端/ }))
    expect(screen.getByRole('button', { name: '空工作区' })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for workspace 空工作区' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭工作区' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('当前 0 个窗格')
    fireEvent.click(screen.getByRole('button', { name: '确认关闭' }))
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/herdr/close?workspace=empty%3A1', expect.anything())
  })

  it('shows server errors without reporting a successful removal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{"message":"busy"}', { status: 503 })))
    render(<HerdrTree {...props} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '工作区 开发' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '确认关闭' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('关闭失败: busy')
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '工作区 开发' })).toBeInTheDocument()
  })
})
