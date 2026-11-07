import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Layout } from '../Layout'

vi.mock('../../contexts/TerminalContext', () => ({ useTerminal: () => ({ terminalRef: { current: null } }) }))
vi.mock('../Toolbar', () => ({ Toolbar: () => null }))
vi.mock('../ConnectionOverlay', () => ({ ConnectionOverlay: () => null }))
vi.mock('../StatusBar', () => ({ StatusBar: ({ onOpenSessions }: { onOpenSessions: () => void }) => (
  <button onClick={onOpenSessions}>Sessions</button>
) }))
vi.mock('../TmuxSidebar', () => ({ TmuxSidebar: ({ mobile, onClose, onCollapseDesktop }: {
  mobile: boolean; onClose: () => void; onCollapseDesktop: () => void
}) => <aside aria-label={mobile ? 'Mobile sidebar' : 'Desktop sidebar'}>
  <button onClick={mobile ? onClose : onCollapseDesktop}>Close sidebar</button>
</aside> }))

let desktop = false
const listeners = new Set<() => void>()
const resize = (matches: boolean) => act(() => {
  desktop = matches
  listeners.forEach(listener => listener())
})

beforeEach(() => {
  desktop = false
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return desktop },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); listeners.clear() })

describe('responsive sidebar lifecycle', () => {
  it('supports the legacy media-query API used by older mobile Safari', () => {
    vi.stubGlobal('matchMedia', () => ({
      get matches() { return desktop },
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
    }))
    const view = render(<Layout><div>Terminal</div></Layout>)
    resize(true)
    expect(screen.getByLabelText('Desktop sidebar')).toBeInTheDocument()
    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it('mounts no hidden sidebar on mobile, and just one when opened', () => {
    render(<Layout><div>Terminal</div></Layout>)
    expect(screen.queryByRole('complementary')).toBeNull()
    fireEvent.click(screen.getByText('Sessions'))
    expect(screen.getAllByRole('complementary')).toHaveLength(1)
    expect(screen.getByLabelText('Mobile sidebar')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Close sidebar'))
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('tracks breakpoint changes without mounting both sidebars or losing desktop collapse preference', () => {
    render(<Layout><div>Terminal</div></Layout>)
    fireEvent.click(screen.getByText('Sessions'))
    resize(true)
    expect(screen.getAllByRole('complementary')).toHaveLength(1)
    expect(screen.getByLabelText('Desktop sidebar')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Close sidebar'))
    expect(localStorage.getItem('tmux_sidebar_collapsed')).toBe('true')
    resize(false)
    expect(screen.getByLabelText('Mobile sidebar')).toBeInTheDocument()
    resize(true)
    expect(screen.queryByRole('complementary')).toBeNull()
    fireEvent.click(screen.getByText('Sessions'))
    expect(screen.getByLabelText('Desktop sidebar')).toBeInTheDocument()
    expect(localStorage.getItem('tmux_sidebar_collapsed')).toBe('false')
  })
})
