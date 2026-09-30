import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toolbar } from '../Toolbar'

const sendKey = vi.fn()
const sendKeystroke = vi.fn(() => ({ ok: true, byteLength: 6 }))
const terminal = { sendKey, sendKeystroke, sendInput: vi.fn(), submitText: vi.fn(), connectionState: 'connected', mux: 'tmux', paneId: null as string | null, clientTty: '/dev/pts/1' }
const events = { currentTmuxSession: 'first' }
vi.mock('../../contexts/TerminalContext', () => ({ useTerminal: () => terminal }))
vi.mock('../../contexts/ServerEventsContext', () => ({ useServerEvents: () => events }))
vi.mock('../SettingsModal', () => ({
  SettingsModal: () => null,
  DEFAULT_CONFIG: { commands: [], presetGroups: [], activePresetGroupId: '', presets: [] },
  loadUserConfig: async () => ({ commands: [], presetGroups: [], activePresetGroupId: '', presets: [] }),
  saveUserConfig: vi.fn(),
}))
vi.mock('../TextInputModal', () => ({ TextInputModal: () => null }))
vi.mock('../GitPanel', () => ({ GitPanel: () => null }))

describe('toolbar combo integration', () => {
  beforeEach(() => {
    localStorage.clear()
    sendKey.mockClear()
    sendKeystroke.mockClear()
    terminal.connectionState = 'connected'
    terminal.paneId = null
    terminal.mux = 'tmux'
    events.currentTmuxSession = 'first'
  })
  afterEach(cleanup)

  it('replaces the ordinary keyboard and restores it when returning', async () => {
    await act(async () => { render(<Toolbar />) })
    expect(screen.queryByRole('region', { name: '组合键面板' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '^C' }))
    expect(sendKey).toHaveBeenLastCalledWith('CTRL_C')
    fireEvent.click(screen.getByRole('button', { name: '组合键' }))
    fireEvent.click(screen.getByRole('button', { name: 'Shift' }))
    expect(screen.queryByRole('button', { name: '←' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '^C' })).not.toBeInTheDocument()
    expect(sendKeystroke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'ArrowLeft' }))
    expect(sendKeystroke).toHaveBeenLastCalledWith({ key: 'ArrowLeft', modifiers: { ctrl: false, alt: false, shift: true } })
    fireEvent.click(screen.getByRole('button', { name: '返回普通键盘' }))
    expect(screen.getByRole('button', { name: 'Collapse toolbar' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '←' }))
    expect(sendKey).toHaveBeenLastCalledWith('ARROW_LEFT')
    fireEvent.click(screen.getByRole('button', { name: '组合键' }))
    expect(screen.getByRole('button', { name: 'Shift' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('closes on session changes or disconnection and never restores locked modifiers', async () => {
    const view = await act(async () => render(<Toolbar />))
    fireEvent.click(screen.getByRole('button', { name: '组合键' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }))
    events.currentTmuxSession = 'second'
    view.rerender(<Toolbar />)
    expect(screen.queryByRole('region', { name: '组合键面板' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '组合键' }))
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'false')
    terminal.connectionState = 'disconnected'
    view.rerender(<Toolbar />)
    expect(screen.queryByRole('region', { name: '组合键面板' })).not.toBeInTheDocument()
  })

  it('also exposes the panel when the toolbar is collapsed', async () => {
    localStorage.setItem('ttyd_toolbar_expanded', 'false')
    await act(async () => { render(<Toolbar />) })
    fireEvent.click(screen.getByRole('button', { name: '组合键' }))
    expect(screen.getByRole('region', { name: '组合键面板' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Expand toolbar' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回普通键盘' }))
    expect(screen.getByRole('button', { name: 'Expand toolbar' })).toBeInTheDocument()
    expect(localStorage.getItem('ttyd_toolbar_expanded')).toBe('false')
  })
})
