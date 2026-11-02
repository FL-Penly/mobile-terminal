import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
