import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerEventsProvider, useServerEvents } from '../ServerEventsContext'

vi.mock('../TerminalContext', () => ({ useTerminal: () => ({ clientTty: '/dev/ttys001' }) }))

class EventSourceMock {
  static instances: EventSourceMock[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()
  constructor(public readonly url: string) { EventSourceMock.instances.push(this) }
}

const Probe = () => {
  const { sessionsLoaded, projectGroups, isOffline } = useServerEvents()
  return <div>{sessionsLoaded ? 'loaded' : 'loading'}:{projectGroups.length}:{isOffline ? 'offline' : 'online'}</div>
}

describe('ServerEventsProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
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
  })

  it('handles an empty snapshot, falls back to polling, and reconnects SSE', async () => {
    render(<ServerEventsProvider><Probe /></ServerEventsProvider>)
    await waitFor(() => expect(screen.getByText('loaded:0:online')).toBeInTheDocument())
    expect(EventSourceMock.instances).toHaveLength(1)
    expect(EventSourceMock.instances[0].url).toContain('client_tty=%2Fdev%2Fttys001')

    act(() => { EventSourceMock.instances[0].onerror?.(new Event('error')) })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/diff', expect.anything()))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(EventSourceMock.instances).toHaveLength(2)
    act(() => { EventSourceMock.instances[1].onopen?.(new Event('open')) })
    expect(EventSourceMock.instances[0].close).toHaveBeenCalled()
  })
})
