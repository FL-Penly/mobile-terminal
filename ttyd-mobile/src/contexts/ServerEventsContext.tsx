import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import type { TmuxSession } from '../hooks/useTmuxSessions'

const DIFF_SERVER_PORT = 7683
const POLL_INTERVAL = 5000

interface ServerEventsContextValue {
  branch: string
  path: string
  tmuxSessions: TmuxSession[]
  currentTmuxSession: string | null
  isOffline: boolean
  refresh: () => void
}

const ServerEventsContext = createContext<ServerEventsContextValue | null>(null)

export const useServerEvents = () => {
  const context = useContext(ServerEventsContext)
  if (!context) {
    throw new Error('useServerEvents must be used within a ServerEventsProvider')
  }
  return context
}

export const ServerEventsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [branch, setBranch] = useState('')
  const [path, setPath] = useState('')
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[]>([])
  const [currentTmuxSession, setCurrentTmuxSession] = useState<string | null>(null)
  const [isOffline, setIsOffline] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const pollIntervalRef = useRef<number | null>(null)
  const usingSSERef = useRef(true)

  const applyData = useCallback((data: { branch: string; path: string; tmux: { sessions: TmuxSession[]; currentSession: string | null } }) => {
    setBranch(data.branch || '')
    setPath(data.path || '')
    setTmuxSessions(data.tmux?.sessions || [])
    setCurrentTmuxSession(data.tmux?.currentSession || null)
    setIsOffline(false)
  }, [])

  const fetchPollData = useCallback(async () => {
    try {
      const baseUrl = `http://${location.hostname}:${DIFF_SERVER_PORT}`
      const [diffRes, tmuxRes] = await Promise.all([
        fetch(`${baseUrl}/api/diff`, { signal: AbortSignal.timeout(3000) }),
        fetch(`${baseUrl}/api/tmux/list`, { signal: AbortSignal.timeout(3000) }),
      ])

      let branchVal = ''
      let pathVal = ''
      if (diffRes.ok) {
        const diffData = await diffRes.json()
        branchVal = diffData.branch || ''
        pathVal = diffData.git_root || diffData.cwd || ''
      }

      let sessions: TmuxSession[] = []
      let currentSession: string | null = null
      if (tmuxRes.ok) {
        const tmuxData = await tmuxRes.json()
        sessions = tmuxData.sessions || []
        currentSession = tmuxData.currentSession || null
      }

      setBranch(branchVal)
      setPath(pathVal)
      setTmuxSessions(sessions)
      setCurrentTmuxSession(currentSession)
      setIsOffline(false)
    } catch {
      setIsOffline(true)
    }
  }, [])

  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return
    fetchPollData()
    pollIntervalRef.current = window.setInterval(fetchPollData, POLL_INTERVAL)
  }, [fetchPollData])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const refresh = useCallback(() => {
    fetchPollData()
  }, [fetchPollData])

  useEffect(() => {
    const url = `http://${location.hostname}:${DIFF_SERVER_PORT}/api/events`
    const es = new EventSource(url)
    eventSourceRef.current = es

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        applyData(data)
      } catch {}
    }

    es.onerror = () => {
      es.close()
      eventSourceRef.current = null
      usingSSERef.current = false
      startPolling()
    }

    return () => {
      es.close()
      eventSourceRef.current = null
      stopPolling()
    }
  }, [applyData, startPolling, stopPolling])

  return (
    <ServerEventsContext.Provider value={{
      branch,
      path,
      tmuxSessions,
      currentTmuxSession,
      isOffline,
      refresh,
    }}>
      {children}
    </ServerEventsContext.Provider>
  )
}
