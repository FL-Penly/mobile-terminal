import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionOverlay } from '../ConnectionOverlay'

const state = vi.hoisted(() => ({
  connectionState: 'reconnecting', reconnect: vi.fn(), reconnectAttempt: 3,
  disconnectReason: null, takeoverDetected: false,
}))
vi.mock('../../contexts/TerminalContext', () => ({ useTerminal: () => state }))

describe('ConnectionOverlay', () => {
  it('shows the attempt without a fixed retry limit or terminal failure branch', () => {
    const { rerender } = render(<ConnectionOverlay />)
    expect(screen.getByText('Attempt 3')).toBeInTheDocument()
    expect(screen.queryByText(/of 10/)).not.toBeInTheDocument()
    state.connectionState = 'disconnected'
    state.reconnectAttempt = 12
    rerender(<ConnectionOverlay />)
    expect(screen.getByText('Disconnected')).toBeInTheDocument()
    expect(screen.queryByText('Connection Failed')).not.toBeInTheDocument()
  })
})
