import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
