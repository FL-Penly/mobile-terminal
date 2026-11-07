import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal } from './TerminalContext'
import { isLensChatPane, mapHerdrSessions, type HerdrListPayload } from '../utils/herdr-sessions'
import { withTerminalTarget } from '../utils/terminal-api'
import { createPollThrottle, isNetworkDegraded, requestSignal } from '../utils/network-quality'

const POLL_INTERVAL = 5000
// Herdr hides pane mouse modes, so these agents scroll Herdr's scrollback instead of receiving
// wheel sequences that would arrive as typed text.
const NO_MOUSE_AGENTS = new Set(['cursor'])

interface RawTmuxSession {
  name: string
  windows: number
  attached: boolean
  last_activity: number
  agent_status?: AgentStatus
}

interface RawDiscoveredSession {
  name: string
  path: string
  relativePath: string
  command: string
  attached: boolean
  windows: number
  lastActivity: number
  agentStatus?: AgentStatus
  displayName?: string
  detail?: string
  tabId?: string
  tabLabel?: string
}

interface RawProjectGroup {
  projectRoot: string
  displayName: string
  sessions: RawDiscoveredSession[]
}

interface RawTmuxPayload {
  sessions?: RawTmuxSession[]
  currentSession?: string | null
  scannedAt?: number
  projectGroups?: RawProjectGroup[]
  otherSessions?: RawDiscoveredSession[]
}

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface TmuxSession {
  name: string
  windows: number
  attached: boolean
  lastActivity: number
  hasNewActivity: boolean
  agentStatus?: AgentStatus
}

export interface DiscoveredTmuxSession extends TmuxSession {
  path: string
  relativePath: string
  command: string
  displayName?: string
  detail?: string
  tabId?: string
  tabLabel?: string
}

export interface TmuxProjectGroup {
  projectRoot: string
  displayName: string
  sessions: DiscoveredTmuxSession[]
}

interface ServerEventsContextValue {
  branch: string
  path: string
  tuiActive: boolean
  herdrScrollback: boolean
  tmuxSessions: TmuxSession[]
  projectGroups: TmuxProjectGroup[]
  otherSessions: DiscoveredTmuxSession[]
  herdrPayload: HerdrListPayload | null
  tmuxScannedAt: number
  currentTmuxSession: string | null
  isOffline: boolean
  clientTty: string | null
  sessionsLoaded: boolean
  refresh: () => void
}

interface EventPayload {
  branch?: string
  path?: string
  tuiActive?: boolean
  tmux?: RawTmuxPayload
  herdr?: HerdrListPayload
  event?: unknown
}

const ServerEventsContext = createContext<ServerEventsContextValue | null>(null)

interface TerminalModes {
  tuiActive: boolean
  herdrScrollback: boolean
  lensChat: boolean
}

// Output rendering and input handlers do not need every session-list revision.
const TerminalModesContext = createContext<TerminalModes | null>(null)

export const useTerminalModes = () => {
  const context = useContext(TerminalModesContext)
  if (!context) throw new Error('useTerminalModes must be used within ServerEventsProvider')
  return context
}


export const useServerEvents = () => {
  const context = useContext(ServerEventsContext)
  if (!context) throw new Error('useServerEvents must be used within ServerEventsProvider')
  return context
}

export const ServerEventsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { clientTty, mux, paneId } = useTerminal()
  const clientTtyRef = useRef<string | null>(null)
  const [branch, setBranch] = useState('')
  const [path, setPath] = useState('')
  const [rawSessions, setRawSessions] = useState<RawTmuxSession[]>([])
  const [rawProjectGroups, setRawProjectGroups] = useState<RawProjectGroup[]>([])
  const [rawOtherSessions, setRawOtherSessions] = useState<RawDiscoveredSession[]>([])
  const [tmuxScannedAt, setTmuxScannedAt] = useState(0)
  const [currentTmuxSession, setCurrentTmuxSession] = useState<string | null>(null)
  const [isOffline, setIsOffline] = useState(false)
  const [tuiActive, setTuiActive] = useState(false)
  const [herdrScrollback, setHerdrScrollback] = useState(false)
  const [herdrPayload, setHerdrPayload] = useState<HerdrListPayload | null>(null)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [lastViewedMap, setLastViewedMap] = useState<Record<string, number>>({})
  const targetGeneration = useRef(0)
  useEffect(() => {
    targetGeneration.current += 1
    return () => { targetGeneration.current += 1 }
  }, [mux, paneId, clientTty])
  const herdrRefreshRef = useRef<() => void>(() => undefined)
  const pollIntervalRef = useRef<number | null>(null)
  const agentStatusesRef = useRef<Record<string, AgentStatus>>({})
  const notificationTimersRef = useRef<Record<string, number>>({})

  useEffect(() => {
    if (currentTmuxSession) {
      setLastViewedMap(previous => ({ ...previous, [currentTmuxSession]: Math.floor(Date.now() / 1000) }))
    }
  }, [currentTmuxSession])

  const hasNewActivity = useCallback((name: string, lastActivity: number) => (
    mux !== 'herdr'
    &&
    !!currentTmuxSession
    && name !== currentTmuxSession
    && lastActivity > (lastViewedMap[name] ?? 0)
  ), [currentTmuxSession, lastViewedMap, mux])

  const tmuxSessions = useMemo<TmuxSession[]>(() => rawSessions.map(session => ({
    name: session.name,
    windows: session.windows,
    attached: session.attached,
    lastActivity: session.last_activity,
    hasNewActivity: hasNewActivity(session.name, session.last_activity),
    agentStatus: session.agent_status,
  })), [rawSessions, hasNewActivity])

  const mapDiscovered = useCallback((session: RawDiscoveredSession): DiscoveredTmuxSession => ({
    ...session,
    hasNewActivity: hasNewActivity(session.name, session.lastActivity),
  }), [hasNewActivity])

  const projectGroups = useMemo<TmuxProjectGroup[]>(() => rawProjectGroups.map(group => ({
    ...group,
    sessions: group.sessions.map(mapDiscovered),
  })), [rawProjectGroups, mapDiscovered])

  const otherSessions = useMemo(() => rawOtherSessions.map(mapDiscovered), [rawOtherSessions, mapDiscovered])

  const applyTmux = useCallback((tmux: RawTmuxPayload | undefined) => {
    setRawSessions(tmux?.sessions ?? [])
    setRawProjectGroups(tmux?.projectGroups ?? [])
    setRawOtherSessions(tmux?.otherSessions ?? [])
    setTmuxScannedAt(tmux?.scannedAt ?? 0)
    setCurrentTmuxSession(tmux?.currentSession ?? null)
    setSessionsLoaded(true)
  }, [])

  const applyHerdr = useCallback((payload: HerdrListPayload) => {
    const panes = payload.panes ?? []
    const agents = new Map((payload.agents ?? []).map(agent => [agent.pane_id, agent]))
    const nextStatuses = Object.fromEntries(panes.map(pane => [
      pane.pane_id,
      agents.get(pane.pane_id)?.agent_status ?? pane.agent_status ?? 'unknown',
    ])) as Record<string, AgentStatus>
    for (const [statusPaneId, nextStatus] of Object.entries(nextStatuses)) {
      const previousStatus = agentStatusesRef.current[statusPaneId]
      if (nextStatus === 'working' && notificationTimersRef.current[statusPaneId]) {
        window.clearTimeout(notificationTimersRef.current[statusPaneId])
        delete notificationTimersRef.current[statusPaneId]
      }
      if (previousStatus !== 'working' || !['idle', 'blocked', 'done'].includes(nextStatus)) continue
      if (notificationTimersRef.current[statusPaneId]) {
        window.clearTimeout(notificationTimersRef.current[statusPaneId])
      }
      notificationTimersRef.current[statusPaneId] = window.setTimeout(() => {
        delete notificationTimersRef.current[statusPaneId]
        if (agentStatusesRef.current[statusPaneId] !== nextStatus) return
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const body = nextStatus === 'blocked'
            ? `${statusPaneId} is waiting for confirmation`
            : `${statusPaneId} is ${nextStatus}`
          new Notification('Rust Terminal agent update', { body, tag: `herdr-${statusPaneId}-${nextStatus}` })
        }
        navigator.vibrate?.(nextStatus === 'blocked' ? [120, 80, 120] : 120)
      }, 1500)
    }
    agentStatusesRef.current = nextStatuses
    const { projectGroups: groups, otherSessions: other } = mapHerdrSessions(payload)
    setRawSessions(panes.map(pane => ({
      name: pane.pane_id,
      windows: 1,
      attached: pane.focused ?? false,
      last_activity: pane.revision ?? 0,
      agent_status: agents.get(pane.pane_id)?.agent_status ?? pane.agent_status ?? 'unknown',
    })))
    setRawProjectGroups(groups)
    setRawOtherSessions(other)
    setHerdrPayload(payload)
    setTmuxScannedAt(Math.floor(Date.now() / 1000))
    setCurrentTmuxSession(paneId)
    const currentPane = panes.find(pane => pane.pane_id === paneId)
    const currentAgent = paneId ? agents.get(paneId) : undefined
    const agent = currentAgent?.agent ?? currentPane?.agent
    const noMouseAgent = NO_MOUSE_AGENTS.has(agent ?? '')
    setTuiActive((Boolean(agent) && !noMouseAgent) || currentPane?.lens_chat === true)
    setHerdrScrollback(noMouseAgent)
    setSessionsLoaded(true)
  }, [paneId])

  useEffect(() => () => {
    Object.values(notificationTimersRef.current).forEach(timer => window.clearTimeout(timer))
    notificationTimersRef.current = {}
  }, [])

  const applyData = useCallback((data: EventPayload) => {
    setBranch(data.branch ?? '')
    setPath(data.path ?? '')
    setTuiActive(data.tuiActive ?? false)
    applyTmux(data.tmux)
    setIsOffline(false)
  }, [applyTmux])

  const pollPendingRef = useRef(false)
  const fetchPollData = useCallback(async () => {
    const generation = targetGeneration.current
    if (mux === 'herdr') {
      herdrRefreshRef.current()
      return
    }
    if (pollPendingRef.current) return
    pollPendingRef.current = true
    try {
      const ttyParam = clientTtyRef.current ? `?client_tty=${encodeURIComponent(clientTtyRef.current)}` : ''
      const [diffRes, tmuxRes, paneModeRes] = await Promise.all([
        fetch(withTerminalTarget('/api/diff?metadata_only=true', mux, paneId, clientTtyRef.current), { signal: requestSignal(3000) }),
        fetch(`/api/tmux/list${ttyParam}`, { signal: requestSignal(3000) }),
        fetch(`/api/tmux/pane-mode${ttyParam}`, { signal: requestSignal(3000) }),
      ])
      if (generation !== targetGeneration.current) return
      if (diffRes.ok) {
        const data = await diffRes.json()
        if (generation !== targetGeneration.current) return
        setBranch(data.branch ?? '')
        setPath(data.git_root ?? data.cwd ?? '')
      }
      if (tmuxRes.ok) {
        const data = await tmuxRes.json()
        if (generation !== targetGeneration.current) return
        applyTmux(data)
      }
      if (paneModeRes.ok) {
        const data = await paneModeRes.json()
        if (generation !== targetGeneration.current) return
        setTuiActive(data.tuiActive ?? false)
      }
      setIsOffline(false)
    } catch (error) {
      if (generation !== targetGeneration.current) return
      console.error('[ServerEvents] Poll failed:', error)
      setIsOffline(true)
    } finally {
      pollPendingRef.current = false
    }
  }, [applyHerdr, applyTmux, mux, paneId])

  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return
    void fetchPollData()
    const shouldPoll = createPollThrottle()
    pollIntervalRef.current = window.setInterval(() => {
      if (shouldPoll()) void fetchPollData()
    }, POLL_INTERVAL)
  }, [fetchPollData])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) window.clearInterval(pollIntervalRef.current)
    pollIntervalRef.current = null
  }, [])

  const refresh = useCallback(() => { void fetchPollData() }, [fetchPollData])

  useEffect(() => { clientTtyRef.current = clientTty }, [clientTty])

  useEffect(() => {
    if (mux === 'herdr') return
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/tmux/list', { signal: requestSignal(3000) })
        if (response.ok && !cancelled) {
          const data = await response.json()
          if (!cancelled) applyTmux(data)
        }
      } catch (error) {
        console.error('[ServerEvents] Initial session load failed:', error)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [applyTmux, fetchPollData, mux])

  useEffect(() => {
    if (mux === 'herdr') return
    if (!clientTty) return
    let eventSource: EventSource | null = null
    let reconnectTimer: number | null = null
    let stopped = false
    const connect = () => {
      if (stopped) return
      eventSource = new EventSource(`/api/events?client_tty=${encodeURIComponent(clientTty)}`)
      eventSource.onopen = () => stopPolling()
      eventSource.onmessage = event => {
        if (stopped) return
        try {
          applyData(JSON.parse(event.data) as EventPayload)
        } catch (error) {
          console.error('[ServerEvents] Invalid SSE payload:', error)
        }
      }
      eventSource.onerror = () => {
        if (stopped) return
        eventSource?.close()
        eventSource = null
        startPolling()
        if (reconnectTimer) window.clearTimeout(reconnectTimer)
        reconnectTimer = window.setTimeout(connect, POLL_INTERVAL)
      }
    }
    connect()
    return () => {
      stopped = true
      eventSource?.close()
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      stopPolling()
    }
  }, [clientTty, mux, paneId, applyData, applyHerdr, startPolling, stopPolling])

  // Each target owns its requests and retry timers. SSE data wins over older HTTP results.
  useEffect(() => {
    if (mux !== 'herdr') return
    let stopped = false
    let pending = false
    let revision = 0
    let sseHealthy = false
    let retry: number | undefined
    let reconnect: number | undefined
    let source: EventSource | null = null
    const retryLater = () => {
      if (stopped || retry !== undefined) return
      const delay = isNetworkDegraded() ? POLL_INTERVAL * 4 : POLL_INTERVAL
      retry = window.setTimeout(() => { retry = undefined; void load() }, delay)
    }
    const load = async () => {
      if (stopped || pending) return
      pending = true
      const startedAt = revision
      try {
        const response = await fetch('/api/herdr/list', { signal: requestSignal(3000) })
        if (!response.ok) throw new Error(`Herdr list HTTP ${response.status}`)
        const payload = await response.json() as HerdrListPayload
        if (stopped || startedAt !== revision) return
        applyHerdr(payload)
        setIsOffline(false)
      } catch (error) {
        if (stopped || startedAt !== revision) return
        console.error('[ServerEvents] Herdr list failed:', error)
        setIsOffline(true)
        retryLater()
      } finally {
        pending = false
        if (!sseHealthy) retryLater()
      }
    }
    let diffPending = false
    const refreshGit = async () => {
      if (stopped || diffPending) return
      diffPending = true
      try {
        const response = await fetch(withTerminalTarget('/api/diff?metadata_only=true', mux, paneId, clientTtyRef.current), { signal: requestSignal(3000) })
        if (!response.ok) return
        const data = await response.json()
        if (!stopped) {
          setBranch(data.branch ?? '')
          setPath(data.git_root ?? data.cwd ?? '')
        }
      } catch (error) {
        if (!stopped) console.error('[ServerEvents] Git refresh failed:', error)
      } finally { diffPending = false }
    }
    const refreshHerdr = () => { void load(); void refreshGit() }
    herdrRefreshRef.current = refreshHerdr
    const connect = () => {
      if (stopped) return
      const current = new EventSource(`/api/events?mux=herdr${paneId ? `&pane=${encodeURIComponent(paneId)}` : ''}`)
      source = current
      current.onmessage = event => {
        if (stopped || source !== current) return
        try {
          const data = JSON.parse(event.data) as EventPayload
          if (!data.herdr) return
          sseHealthy = true
          revision += 1
          applyHerdr(data.herdr)
          setIsOffline(false)
          window.clearTimeout(retry)
          retry = undefined
        } catch (error) {
          console.error('[ServerEvents] Invalid herdr SSE payload:', error)
          retryLater()
        }
      }
      current.onerror = () => {
        if (stopped || source !== current) return
        current.close()
        sseHealthy = false
        source = null
        void load()
        retryLater()
        window.clearTimeout(reconnect)
        reconnect = window.setTimeout(connect, POLL_INTERVAL)
      }
    }
    const resume = () => {
      if (document.visibilityState === 'hidden') return
      refreshHerdr()
      if (!source) { window.clearTimeout(reconnect); connect() }
    }
    refreshHerdr()
    connect()
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      stopped = true
      herdrRefreshRef.current = () => undefined
      source?.close()
      window.clearTimeout(retry)
      window.clearTimeout(reconnect)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [mux, paneId, applyHerdr])

  const value = useMemo<ServerEventsContextValue>(() => ({
    branch,
    path,
    tuiActive,
    herdrScrollback,
    tmuxSessions,
    projectGroups,
    otherSessions,
    herdrPayload,
    tmuxScannedAt,
    currentTmuxSession,
    isOffline,
    clientTty,
    sessionsLoaded,
    refresh,
  }), [branch, path, tuiActive, herdrScrollback, tmuxSessions, projectGroups, otherSessions, herdrPayload, tmuxScannedAt, currentTmuxSession, isOffline, clientTty, sessionsLoaded, refresh])

  const lensChat = mux === 'herdr' && isLensChatPane(herdrPayload, paneId)
  const terminalModes = useMemo(() => ({ tuiActive, herdrScrollback, lensChat }), [tuiActive, herdrScrollback, lensChat])

  return (
    <TerminalModesContext.Provider value={terminalModes}>
      <ServerEventsContext.Provider value={value}>{children}</ServerEventsContext.Provider>
    </TerminalModesContext.Provider>
  )
}
