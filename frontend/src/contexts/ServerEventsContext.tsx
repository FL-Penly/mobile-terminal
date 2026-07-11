import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal } from './TerminalContext'

const POLL_INTERVAL = 5000

interface RawTmuxSession {
  name: string
  windows: number
  attached: boolean
  last_activity: number
}

interface RawDiscoveredSession {
  name: string
  path: string
  relativePath: string
  command: string
  attached: boolean
  windows: number
  lastActivity: number
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

export interface TmuxSession {
  name: string
  windows: number
  attached: boolean
  lastActivity: number
  hasNewActivity: boolean
}

export interface DiscoveredTmuxSession extends TmuxSession {
  path: string
  relativePath: string
  command: string
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
  tmuxSessions: TmuxSession[]
  projectGroups: TmuxProjectGroup[]
  otherSessions: DiscoveredTmuxSession[]
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
}

const ServerEventsContext = createContext<ServerEventsContextValue | null>(null)

export const useServerEvents = () => {
  const context = useContext(ServerEventsContext)
  if (!context) throw new Error('useServerEvents must be used within ServerEventsProvider')
  return context
}

export const ServerEventsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { clientTty } = useTerminal()
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
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [lastViewedMap, setLastViewedMap] = useState<Record<string, number>>({})
  const pollIntervalRef = useRef<number | null>(null)

  useEffect(() => {
    if (currentTmuxSession) {
      setLastViewedMap(previous => ({ ...previous, [currentTmuxSession]: Math.floor(Date.now() / 1000) }))
    }
  }, [currentTmuxSession])

  const hasNewActivity = useCallback((name: string, lastActivity: number) => (
    !!currentTmuxSession
    && name !== currentTmuxSession
    && lastActivity > (lastViewedMap[name] ?? 0)
  ), [currentTmuxSession, lastViewedMap])

  const tmuxSessions = useMemo<TmuxSession[]>(() => rawSessions.map(session => ({
    name: session.name,
    windows: session.windows,
    attached: session.attached,
    lastActivity: session.last_activity,
    hasNewActivity: hasNewActivity(session.name, session.last_activity),
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

  const applyData = useCallback((data: EventPayload) => {
    setBranch(data.branch ?? '')
    setPath(data.path ?? '')
    setTuiActive(data.tuiActive ?? false)
    applyTmux(data.tmux)
    setIsOffline(false)
  }, [applyTmux])

  const fetchPollData = useCallback(async () => {
    try {
      const ttyParam = clientTtyRef.current ? `?client_tty=${encodeURIComponent(clientTtyRef.current)}` : ''
      const [diffRes, tmuxRes, paneModeRes] = await Promise.all([
        fetch('/api/diff', { signal: AbortSignal.timeout(3000) }),
        fetch(`/api/tmux/list${ttyParam}`, { signal: AbortSignal.timeout(3000) }),
        fetch(`/api/tmux/pane-mode${ttyParam}`, { signal: AbortSignal.timeout(3000) }),
      ])
      if (diffRes.ok) {
        const data = await diffRes.json()
        setBranch(data.branch ?? '')
        setPath(data.git_root ?? data.cwd ?? '')
      }
      if (tmuxRes.ok) applyTmux(await tmuxRes.json())
      if (paneModeRes.ok) setTuiActive((await paneModeRes.json()).tuiActive ?? false)
      setIsOffline(false)
    } catch (error) {
      console.error('[ServerEvents] Poll failed:', error)
      setIsOffline(true)
    }
  }, [applyTmux])

  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return
    void fetchPollData()
    pollIntervalRef.current = window.setInterval(fetchPollData, POLL_INTERVAL)
  }, [fetchPollData])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) window.clearInterval(pollIntervalRef.current)
    pollIntervalRef.current = null
  }, [])

  const refresh = useCallback(() => { void fetchPollData() }, [fetchPollData])

  useEffect(() => { clientTtyRef.current = clientTty }, [clientTty])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/tmux/list', { signal: AbortSignal.timeout(3000) })
        if (response.ok && !cancelled) applyTmux(await response.json())
      } catch (error) {
        console.error('[ServerEvents] Initial tmux load failed:', error)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [applyTmux])

  useEffect(() => {
    if (!clientTty) return
    let eventSource: EventSource | null = null
    let reconnectTimer: number | null = null
    let stopped = false
    const connect = () => {
      if (stopped) return
      eventSource = new EventSource(`/api/events?client_tty=${encodeURIComponent(clientTty)}`)
      eventSource.onopen = () => stopPolling()
      eventSource.onmessage = event => {
        try {
          applyData(JSON.parse(event.data) as EventPayload)
        } catch (error) {
          console.error('[ServerEvents] Invalid SSE payload:', error)
        }
      }
      eventSource.onerror = () => {
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
  }, [clientTty, applyData, startPolling, stopPolling])

  const value = useMemo<ServerEventsContextValue>(() => ({
    branch,
    path,
    tuiActive,
    tmuxSessions,
    projectGroups,
    otherSessions,
    tmuxScannedAt,
    currentTmuxSession,
    isOffline,
    clientTty,
    sessionsLoaded,
    refresh,
  }), [branch, path, tuiActive, tmuxSessions, projectGroups, otherSessions, tmuxScannedAt, currentTmuxSession, isOffline, clientTty, sessionsLoaded, refresh])

  return <ServerEventsContext.Provider value={value}>{children}</ServerEventsContext.Provider>
}
