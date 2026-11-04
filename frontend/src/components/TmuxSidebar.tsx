import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServerEvents, type DiscoveredTmuxSession, type TmuxProjectGroup } from '../contexts/ServerEventsContext'
import { useTerminal, type TerminalMux } from '../contexts/TerminalContext'
import { HerdrRenameModal, type HerdrRenameTarget } from './HerdrRenameModal'
import { HerdrTree } from './HerdrTree'
import { NewSessionModal } from './TmuxManager'
import { mapHerdrSessions, type HerdrListPayload } from '../utils/herdr-sessions'
import { createPollThrottle, requestSignal } from '../utils/network-quality'

const COLLAPSED_GROUPS_KEY = 'tmux_sidebar_collapsed_groups'
const GROUP_ORDER_KEY = 'tmux_sidebar_group_order'
const SESSION_ORDER_KEY = 'tmux_sidebar_session_order'
const LONG_PRESS_DURATION = 1200
const DISCOVERY_POLL_INTERVAL = 5000

interface TmuxSidebarProps {
  mobile: boolean
  onClose: () => void
  onCollapseDesktop: () => void
}

interface TmuxListPayload {
  currentSession?: string | null
  projectGroups?: TmuxProjectGroup[]
  otherSessions?: DiscoveredTmuxSession[]
}

interface DiscoveryState {
  mux: TerminalMux | null
  projectGroups: TmuxProjectGroup[]
  otherSessions: DiscoveredTmuxSession[]
  currentSession: string | null
  herdrPayload: HerdrListPayload | null
  loaded: boolean
  unavailable: boolean
}

const shellQuote = (value: string) => `'${value.split("'").join(`'"'"'`)}'`

export const TmuxSidebar: React.FC<TmuxSidebarProps> = ({ mobile, onClose, onCollapseDesktop }) => {
  const { sendInput, mux, paneId, switchTerminal } = useTerminal()
  const {
    projectGroups,
    otherSessions,
    herdrPayload,
    currentTmuxSession,
    clientTty,
    path,
    isOffline,
    sessionsLoaded,
    refresh,
  } = useServerEvents()
  const [browserMux, setBrowserMux] = useState<TerminalMux>(mux)
  const [discovery, setDiscovery] = useState<DiscoveryState>({
    mux: null,
    projectGroups: [],
    otherSessions: [],
    currentSession: null,
    herdrPayload: null,
    loaded: false,
    unavailable: false,
  })
  const [search, setSearch] = useState('')
  const [optimisticSession, setOptimisticSession] = useState<string | null>(null)
  const [switchingSession, setSwitchingSession] = useState<string | null>(null)
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false)
  const [quickShellLoading, setQuickShellLoading] = useState(false)
  const [killTarget, setKillTarget] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<HerdrRenameTarget | null>(null)
  const [draggedGroup, setDraggedGroup] = useState<string | null>(null)
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  const [draggedSession, setDraggedSession] = useState<{ groupKey: string; name: string } | null>(null)
  const [dragOverSession, setDragOverSession] = useState<{ groupKey: string; name: string } | null>(null)
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(GROUP_ORDER_KEY) ?? '[]') as string[]
    } catch {
      return []
    }
  })
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem(SESSION_ORDER_KEY) ?? '{}') as Record<string, string[]>
    } catch {
      return {}
    }
  })
  const longPressTimer = useRef<number | null>(null)
  const longPressTriggered = useRef(false)
  const switchingSessionRef = useRef<string | null>(null)
  const browsingConnectedMux = browserMux === mux
  const sourceProjectGroups = browsingConnectedMux ? projectGroups : discovery.projectGroups
  const sourceOtherSessions = browsingConnectedMux ? otherSessions : discovery.otherSessions
  const sourceHerdrPayload = browsingConnectedMux ? herdrPayload : discovery.herdrPayload
  const sourceCurrentSession = browsingConnectedMux ? currentTmuxSession : discovery.currentSession
  const sourceLoaded = browsingConnectedMux ? sessionsLoaded : discovery.mux === browserMux && discovery.loaded
  const sourceUnavailable = browsingConnectedMux ? isOffline : discovery.mux === browserMux && discovery.unavailable
  const selectedSession = optimisticSession ?? sourceCurrentSession
  const sessionSwitchLocked = browserMux === 'tmux' && switchingSession !== null

  const sessionGroupKey = (groupKey: string) => `${browserMux}:${groupKey}`

  const orderSessions = (sessions: DiscoveredTmuxSession[], groupKey: string) => {
    const positions = new Map((sessionOrder[sessionGroupKey(groupKey)] ?? []).map((name, index) => [name, index]))
    return sessions
      .map((session, sourceIndex) => ({ session, sourceIndex, orderIndex: positions.get(session.name) }))
      .sort((left, right) => {
        if (left.orderIndex !== undefined || right.orderIndex !== undefined) {
          if (left.orderIndex === undefined) return 1
          if (right.orderIndex === undefined) return -1
          return left.orderIndex - right.orderIndex
        }
        return left.sourceIndex - right.sourceIndex
      })
      .map(item => item.session)
  }

  const discoveryGeneration = useRef(0)
  const discoveryPending = useRef<number | null>(null)
  const loadDiscovery = useCallback(async (targetMux: TerminalMux) => {
    const generation = discoveryGeneration.current
    if (discoveryPending.current === generation) return
    discoveryPending.current = generation
    setDiscovery(previous => ({
      ...previous,
      mux: targetMux,
      projectGroups: previous.mux === targetMux ? previous.projectGroups : [],
      otherSessions: previous.mux === targetMux ? previous.otherSessions : [],
      currentSession: previous.mux === targetMux ? previous.currentSession : null,
      herdrPayload: previous.mux === targetMux ? previous.herdrPayload : null,
      loaded: previous.mux === targetMux && previous.loaded,
      unavailable: previous.mux === targetMux && previous.unavailable,
    }))
    try {
      const response = await fetch(targetMux === 'herdr' ? '/api/herdr/list' : '/api/tmux/list', {
        signal: requestSignal(3000),
      })
      if (!response.ok) throw new Error(await response.text())
      const herdr = targetMux === 'herdr' ? await response.json() as HerdrListPayload : null
      const data: TmuxListPayload = herdr ? mapHerdrSessions(herdr) : await response.json() as TmuxListPayload
      if (generation !== discoveryGeneration.current) return
      setDiscovery({
        mux: targetMux,
        projectGroups: data.projectGroups ?? [],
        otherSessions: data.otherSessions ?? [],
        currentSession: data.currentSession ?? null,
        herdrPayload: herdr,
        loaded: true,
        unavailable: false,
      })
    } catch (error) {
      if (generation !== discoveryGeneration.current) return
      console.error(`[TmuxSidebar] ${targetMux} discovery failed:`, error)
      setDiscovery(previous => previous.mux === targetMux ? {
        ...previous,
        loaded: true,
        unavailable: true,
      } : previous)
    } finally {
      if (discoveryPending.current === generation) discoveryPending.current = null
    }
  }, [])

  useEffect(() => {
    setOptimisticSession(null)
    if (browserMux === mux) return
    void loadDiscovery(browserMux)
    const shouldPoll = createPollThrottle()
    const poll = window.setInterval(() => {
      if (shouldPoll()) void loadDiscovery(browserMux)
    }, DISCOVERY_POLL_INTERVAL)
    const resume = () => { if (document.visibilityState !== 'hidden') void loadDiscovery(browserMux) }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      discoveryGeneration.current += 1
      window.clearInterval(poll)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [browserMux, loadDiscovery, mux])

  useEffect(() => {
    if (switchingSession && paneId === switchingSession) {
      switchingSessionRef.current = null
      setSwitchingSession(null)
      setOptimisticSession(null)
    }
  }, [paneId, switchingSession])

  useEffect(() => {
    const sources = [
      ...sourceProjectGroups.map(group => ({ key: group.projectRoot, names: group.sessions.map(session => session.name) })),
      { key: '__other__', names: sourceOtherSessions.map(session => session.name) },
    ]
    setSessionOrder(previous => {
      let changed = false
      const next = { ...previous }
      for (const source of sources) {
        const key = sessionGroupKey(source.key)
        const existing = previous[key] ?? []
        const names = new Set(source.names)
        const merged = [
          ...existing.filter(name => names.has(name)),
          ...source.names.filter(name => !existing.includes(name)),
        ]
        if (merged.length !== existing.length || merged.some((name, index) => name !== existing[index])) {
          next[key] = merged
          changed = true
        }
      }
      if (changed) localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(next))
      return changed ? next : previous
    })
  }, [browserMux, sourceOtherSessions, sourceProjectGroups])

  const sortedGroups = useMemo(() => {
    const order = new Map(groupOrder.map((projectRoot, index) => [projectRoot, index]))
    return [...sourceProjectGroups].sort((left, right) => {
      const leftIndex = order.get(left.projectRoot)
      const rightIndex = order.get(right.projectRoot)
      if (leftIndex !== undefined || rightIndex !== undefined) {
        if (leftIndex === undefined) return 1
        if (rightIndex === undefined) return -1
        return leftIndex - rightIndex
      }
      return left.projectRoot.localeCompare(right.projectRoot)
    })
  }, [sourceProjectGroups, groupOrder])

  const query = search.trim().toLocaleLowerCase()
  const matches = (session: DiscoveredTmuxSession, group?: TmuxProjectGroup) => !query || [
    group?.displayName,
    group?.projectRoot,
    session.name,
    session.displayName,
    session.detail,
    session.command,
    session.relativePath,
    session.path,
  ].some(value => value?.toLocaleLowerCase().includes(query))

  const toggleGroup = (key: string) => {
    setCollapsedGroups(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const reorderGroup = (targetRoot: string, placeAfter: boolean) => {
    if (!draggedGroup || draggedGroup === targetRoot) return
    const next = sortedGroups.map(group => group.projectRoot).filter(projectRoot => projectRoot !== draggedGroup)
    const targetIndex = next.indexOf(targetRoot)
    next.splice(targetIndex + (placeAfter ? 1 : 0), 0, draggedGroup)
    setGroupOrder(next)
    localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify(next))
  }

  const finishGroupDrag = () => {
    setDraggedGroup(null)
    setDragOverGroup(null)
  }

  const reorderSession = (groupKey: string, targetName: string, placeAfter: boolean) => {
    if (!draggedSession || draggedSession.groupKey !== groupKey || draggedSession.name === targetName) return
    const sourceSessions = groupKey === '__other__'
      ? sourceOtherSessions
      : sourceProjectGroups.find(group => group.projectRoot === groupKey)?.sessions ?? []
    const next = orderSessions(sourceSessions, groupKey)
      .map(session => session.name)
      .filter(name => name !== draggedSession.name)
    const targetIndex = next.indexOf(targetName)
    if (targetIndex < 0) return
    next.splice(targetIndex + (placeAfter ? 1 : 0), 0, draggedSession.name)
    const key = sessionGroupKey(groupKey)
    setSessionOrder(previous => {
      const updated = { ...previous, [key]: next }
      localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(updated))
      return updated
    })
  }

  const moveSessionByOffset = (name: string, offset: -1 | 1) => {
    const group = sourceProjectGroups.find(candidate => candidate.sessions.some(session => session.name === name))
    const groupKey = group?.projectRoot ?? '__other__'
    const sourceSessions = group?.sessions ?? sourceOtherSessions
    const next = orderSessions(sourceSessions, groupKey).map(session => session.name)
    const currentIndex = next.indexOf(name)
    const targetIndex = currentIndex + offset
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= next.length) return
    const displaced = next[targetIndex]
    next[targetIndex] = next[currentIndex]
    next[currentIndex] = displaced
    const key = sessionGroupKey(groupKey)
    setSessionOrder(previous => {
      const updated = { ...previous, [key]: next }
      localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(updated))
      return updated
    })
  }

  const getSessionPosition = (name: string) => {
    const group = sourceProjectGroups.find(candidate => candidate.sessions.some(session => session.name === name))
    const groupKey = group?.projectRoot ?? '__other__'
    const ordered = orderSessions(group?.sessions ?? sourceOtherSessions, groupKey)
    return { index: ordered.findIndex(session => session.name === name), count: ordered.length }
  }

  const finishSessionDrag = () => {
    setDraggedSession(null)
    setDragOverSession(null)
  }

  const switchSession = async (sessionName: string) => {
    if (longPressTriggered.current || sessionName === selectedSession) return
    const previous = sourceCurrentSession
    if (browserMux === 'herdr') {
      switchingSessionRef.current = sessionName
      setSwitchingSession(sessionName)
      setOptimisticSession(sessionName)
      if (mobile) onClose()
      switchTerminal('herdr', sessionName)
      return
    }
    if (switchingSessionRef.current) return
    switchingSessionRef.current = sessionName
    setSwitchingSession(sessionName)
    setOptimisticSession(sessionName)
    try {
      if (mux !== 'tmux') {
        sessionStorage.setItem('ttyd_last_tmux_session', sessionName)
        if (mobile) onClose()
        switchTerminal('tmux')
        return
      }
      if (!clientTty) throw new Error('No client tty')
      const url = `/api/tmux/switch?session=${encodeURIComponent(sessionName)}&client_tty=${encodeURIComponent(clientTty)}`
      const response = await fetch(url, { signal: requestSignal(3000) })
      if (!response.ok) throw new Error(await response.text())
      sessionStorage.setItem('ttyd_last_tmux_session', sessionName)
      if (mobile) onClose()
      window.setTimeout(refresh, 300)
    } catch (error) {
      console.error('[TmuxSidebar] Switch failed:', error)
      setOptimisticSession(previous)
      if (mux !== 'tmux') return
      sendInput(` tmux attach -t ${shellQuote(sessionName)}\r`)
      sessionStorage.setItem('ttyd_last_tmux_session', sessionName)
      window.setTimeout(refresh, 500)
    } finally {
      if (switchingSessionRef.current === sessionName) switchingSessionRef.current = null
      setSwitchingSession(null)
    }
  }

  const refreshSource = () => browsingConnectedMux ? refresh() : void loadDiscovery(browserMux)

  const killTargetSession = killTarget
    ? [...sourceProjectGroups.flatMap(group => group.sessions), ...sourceOtherSessions].find(session => session.name === killTarget)
    : undefined

  const killSession = async () => {
    if (!killTarget) return
    try {
      const url = `/api/tmux/kill?name=${encodeURIComponent(killTarget)}`
      const response = await fetch(url, { signal: requestSignal(5000) })
      if (!response.ok) throw new Error(await response.text())
      if (browsingConnectedMux) refresh()
      else void loadDiscovery(browserMux)
    } catch (error) {
      console.error('[TmuxSidebar] Kill failed:', error)
    } finally {
      setKillTarget(null)
    }
  }

  const detach = async () => {
    if (!browsingConnectedMux) return
    try {
      if (mux === 'herdr') {
        if (!paneId) throw new Error('No herdr pane')
        const response = await fetch(`/api/herdr/release?pane=${encodeURIComponent(paneId)}`, { signal: requestSignal(3000) })
        if (!response.ok) throw new Error(await response.text())
        if (mobile) onClose()
        return
      }
      if (!clientTty) throw new Error('No client tty')
      const response = await fetch(`/api/tmux/detach?client_tty=${encodeURIComponent(clientTty)}`, { signal: requestSignal(3000) })
      if (!response.ok) throw new Error(await response.text())
    } catch (error) {
      console.error('[TmuxSidebar] Detach failed:', error)
      if (mux === 'herdr') return
      sendInput(' tmux detach\r')
    }
    if (mobile) onClose()
    window.setTimeout(refresh, 500)
  }

  const quickShell = async () => {
    if (!browsingConnectedMux || (mux === 'herdr' ? !paneId : !clientTty)) return
    setQuickShellLoading(true)
    try {
      const url = mux === 'herdr'
        ? `/api/herdr/quick-shell?pane=${encodeURIComponent(paneId ?? '')}${path ? `&cwd=${encodeURIComponent(path)}` : ''}`
        : `/api/tmux/quick-shell?client_tty=${encodeURIComponent(clientTty ?? '')}`
      const response = await fetch(url, { signal: requestSignal(3000) })
      if (!response.ok) throw new Error(await response.text())
      if (mobile) onClose()
      if (mux === 'herdr') {
        const data = await response.json() as { paneId?: string }
        if (!data.paneId) throw new Error('Herdr did not return the new pane id')
        switchTerminal('herdr', data.paneId)
        return
      }
      window.setTimeout(refresh, 300)
    } catch (error) {
      console.error('[TmuxSidebar] Quick Shell failed:', error)
    } finally {
      setQuickShellLoading(false)
    }
  }

  const startLongPress = (name: string) => {
    longPressTriggered.current = false
    longPressTimer.current = window.setTimeout(() => {
      longPressTriggered.current = true
      setKillTarget(name)
    }, LONG_PRESS_DURATION)
  }

  const endLongPress = () => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = null
    window.setTimeout(() => { longPressTriggered.current = false }, 0)
  }

  const renderSession = (session: DiscoveredTmuxSession, groupKey: string) => {
    const current = session.name === selectedSession
    const dragging = draggedSession?.groupKey === groupKey && draggedSession.name === session.name
    const dragOver = dragOverSession?.groupKey === groupKey && dragOverSession.name === session.name
    return (
      <div
        key={session.name}
        data-session-name={session.name}
        data-session-group={groupKey}
        onDragOver={event => {
          if (!draggedSession || draggedSession.groupKey !== groupKey || search) return
          event.preventDefault()
          setDragOverSession({ groupKey, name: session.name })
        }}
        onDrop={event => {
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          reorderSession(groupKey, session.name, event.clientY > bounds.top + bounds.height / 2)
          finishSessionDrag()
        }}
        className={`group flex items-stretch rounded-lg transition-colors ${current ? 'bg-accent-purple/20' : dragOver ? 'bg-accent-purple/10' : 'hover:bg-bg-tertiary'} ${dragging ? 'opacity-50' : ''}`}
      >
        <span
          draggable={!search && !sessionSwitchLocked}
          onDragStart={() => {
            setDraggedSession({ groupKey, name: session.name })
            setDragOverSession({ groupKey, name: session.name })
          }}
          onDragEnd={finishSessionDrag}
          onKeyDown={event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            moveSessionByOffset(session.name, event.key === 'ArrowUp' ? -1 : 1)
          }}
          role="button"
          tabIndex={0}
          aria-label={`Move ${session.name} session`}
          title={search ? 'Clear search to reorder' : 'Drag to reorder session'}
          className={`self-stretch px-1.5 py-3 text-[10px] text-text-muted select-none ${search || sessionSwitchLocked ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing'}`}
        >⋮⋮</span>
        <button
          onClick={() => { void switchSession(session.name) }}
          onTouchStart={() => startLongPress(session.name)}
          onTouchEnd={endLongPress}
          onMouseDown={() => startLongPress(session.name)}
          onMouseUp={endLongPress}
          onMouseLeave={endLongPress}
          disabled={sessionSwitchLocked}
          className="min-w-0 flex-1 px-2 py-2 text-left disabled:cursor-wait"
          aria-current={current ? 'page' : undefined}
          aria-busy={switchingSession === session.name ? true : undefined}
        >
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${session.hasNewActivity ? 'bg-accent-orange animate-pulse' : session.attached ? 'bg-accent-green' : 'bg-text-muted'}`} />
            <span className={`truncate text-sm font-medium ${current ? 'text-accent-purple' : 'text-text-primary'}`} title={session.name}>{session.displayName ?? session.name}</span>
            <span className="ml-auto shrink-0 text-[10px] text-text-muted">{session.windows}w</span>
          </div>
          <div className="mt-1 flex gap-2 pl-4 text-[11px] text-text-muted">
            {session.detail && <span className="max-w-[60%] shrink-0 truncate text-text-secondary" title={session.detail}>{session.detail}</span>}
            <span className="truncate" title={session.path}>{session.relativePath}</span>
            <span className="ml-auto shrink-0 font-mono">{session.command}</span>
          </div>
        </button>
        <button
          onClick={() => setKillTarget(session.name)}
          disabled={sessionSwitchLocked}
          className="px-2 text-text-muted hover:text-accent-red"
          aria-label={`Session actions for ${session.name}`}
        >
          ⋯
        </button>
      </div>
    )
  }

  const visibleGroups = sortedGroups
    .map(group => ({ ...group, sessions: orderSessions(group.sessions.filter(session => matches(session, group)), group.projectRoot) }))
    .filter(group => group.sessions.length > 0)
  const visibleOther = orderSessions(sourceOtherSessions.filter(session => matches(session)), '__other__')
  const empty = visibleGroups.length === 0 && visibleOther.length === 0
  const unavailableNotice = (
    <div className="mx-1 rounded-lg border border-accent-red/30 bg-accent-red/10 px-3 py-4 text-center text-sm">
      <p className="font-medium text-accent-red">{browserMux === 'herdr' ? 'Herdr 工作区刷新失败' : 'tmux discovery unavailable'}</p>
      {browserMux === 'herdr' && <p className="mt-1 text-xs text-text-muted">正在自动重试。已有列表可能过期；请检查网络或服务连接。</p>}
      <button onClick={refreshSource} className="mt-3 rounded-md bg-bg-tertiary px-3 py-1.5 text-xs">Retry</button>
    </div>
  )

  return (
    <aside className="flex h-full w-[280px] flex-col border-r border-border-subtle bg-bg-secondary text-text-primary">
      <div className="border-b border-border-subtle p-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Workspaces</span>
          <button
            onClick={refreshSource}
            className="ml-auto rounded px-2 py-1 text-text-muted hover:bg-bg-tertiary"
            aria-label={`Refresh ${browserMux} workspaces`}
          >↻</button>
          <button onClick={mobile ? onClose : onCollapseDesktop} className="rounded px-2 py-1 text-text-muted hover:bg-bg-tertiary" aria-label="Close sessions sidebar">×</button>
        </div>
        <div className="mt-3 grid grid-cols-2 rounded-lg bg-bg-primary p-1" role="tablist" aria-label="Workspace source">
          {(['tmux', 'herdr'] as const).map(source => (
            <button
              key={source}
              type="button"
              role="tab"
              aria-selected={browserMux === source}
              onClick={() => setBrowserMux(source)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${browserMux === source ? 'bg-accent-purple text-white' : 'text-text-muted hover:text-text-primary'}`}
            >{source === 'tmux' ? 'tmux' : 'Herdr'}</button>
          ))}
        </div>
      </div>
      <div className="p-3">
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder={browserMux === 'herdr' ? 'Search workspaces or panes' : 'Search projects or sessions'}
          className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm outline-none focus:border-accent-purple"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {!browsingConnectedMux && (
          <div className="mx-1 mb-3 rounded-lg border border-accent-purple/30 bg-accent-purple/10 px-3 py-2 text-xs text-text-secondary">
            Choose a {browserMux === 'herdr' ? 'Herdr pane' : 'tmux session'} to connect. Your current terminal stays open until then.
          </div>
        )}
        {browserMux === 'herdr' ? (
          <>
          {sourceUnavailable && unavailableNotice}
          {(!sourceUnavailable || sourceHerdrPayload !== null) && (
            <HerdrTree
              payload={sourceHerdrPayload}
              loaded={sourceLoaded}
              query={query}
              selectedPaneId={selectedSession}
              switchingPaneId={switchingSession}
              onSelect={paneId => { void switchSession(paneId) }}
              onOpen={paneId => {
                if (mobile) onClose()
                switchTerminal('herdr', paneId)
              }}
              onRename={setRenameTarget}
              onChanged={refreshSource}
            />
          )}
          </>
        ) : <>
        {visibleGroups.map(group => {
          const active = group.sessions.some(session => session.name === selectedSession)
          return (
          <section
            key={group.projectRoot}
            data-project-root={group.projectRoot}
            data-active-project={active ? 'true' : undefined}
            onDragOver={event => {
              if (!draggedGroup || search) return
              event.preventDefault()
              setDragOverGroup(group.projectRoot)
            }}
            onDrop={event => {
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              reorderGroup(group.projectRoot, event.clientY > bounds.top + bounds.height / 2)
              finishGroupDrag()
            }}
            className={`mb-2 rounded-xl border transition-colors ${
              active
                ? 'border-accent-purple/50 bg-accent-purple/10 shadow-[inset_3px_0_0_var(--accent-purple)]'
                : dragOverGroup === group.projectRoot
                  ? 'border-accent-purple/50 bg-accent-purple/5'
                  : 'border-transparent'
            } ${draggedGroup === group.projectRoot ? 'opacity-50' : ''}`}
          >
            <div className="flex items-center">
              <span
                draggable={!search}
                onDragStart={() => {
                  setDraggedGroup(group.projectRoot)
                  setDragOverGroup(group.projectRoot)
                }}
                onDragEnd={finishGroupDrag}
                role="button"
                tabIndex={0}
                aria-label={`Move ${group.displayName} project`}
                title={search ? 'Clear search to reorder projects' : 'Drag to reorder project'}
                className={`ml-1 px-1.5 py-2 text-xs text-text-muted select-none ${search ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing'}`}
              >
                ⋮⋮
              </span>
              <button onClick={() => toggleGroup(group.projectRoot)} className="flex min-w-0 flex-1 items-center gap-2 px-1 py-2 text-left text-xs font-semibold text-text-secondary">
                <span>{collapsedGroups.has(group.projectRoot) ? '▸' : '▾'}</span>
                <span className={`truncate ${active ? 'text-accent-purple' : ''}`} title={group.projectRoot}>{group.displayName}</span>
                <span className="ml-auto pr-2 text-text-muted">{group.sessions.length}</span>
              </button>
            </div>
            {!collapsedGroups.has(group.projectRoot) && (
              <div className="space-y-1">
                {group.sessions.map(session => renderSession(session, group.projectRoot))}
              </div>
            )}
          </section>
          )
        })}
        {visibleOther.length > 0 && (
          <section>
            <button onClick={() => toggleGroup('__other__')} className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs font-semibold text-text-secondary">
              <span>{collapsedGroups.has('__other__') ? '▸' : '▾'}</span>
              <span>Other</span>
              <span className="ml-auto text-text-muted">{visibleOther.length}</span>
            </button>
            {!collapsedGroups.has('__other__') && <div className="space-y-1">{visibleOther.map(session => renderSession(session, '__other__'))}</div>}
          </section>
        )}
        {sourceUnavailable ? unavailableNotice : empty && (
          <div className="px-3 py-8 text-center text-sm text-text-muted">
            {sourceLoaded ? (search ? 'No matching sessions' : 'No tmux sessions') : 'Loading tmux sessions…'}
          </div>
        )}
        </>}
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-border-subtle p-3 text-xs">
        <button
          onClick={() => setIsNewSessionOpen(true)}
          disabled={browserMux === 'tmux' && mux !== 'tmux'}
          className="rounded-lg bg-accent-purple px-2 py-2 text-white disabled:opacity-50"
          title={browserMux === 'tmux' && mux !== 'tmux' ? 'Choose a tmux session first' : undefined}
        >{browserMux === 'herdr' ? '+ New Workspace' : '+ New Session'}</button>
        <button onClick={() => { void quickShell() }} disabled={!browsingConnectedMux || (mux === 'herdr' ? !paneId : !clientTty) || quickShellLoading} className="rounded-lg bg-bg-tertiary px-2 py-2 disabled:opacity-50">{quickShellLoading ? 'Opening…' : 'Quick Shell'}</button>
        <button onClick={() => { void detach() }} disabled={!browsingConnectedMux} className="col-span-2 rounded-lg bg-bg-tertiary px-2 py-2 text-text-secondary disabled:opacity-50">Detach to Shell</button>
      </div>
      <NewSessionModal
        isOpen={isNewSessionOpen}
        onClose={() => setIsNewSessionOpen(false)}
        cwd={path || undefined}
        onCreated={refreshSource}
        targetMux={browserMux}
      />
      {killTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" onClick={event => event.target === event.currentTarget && setKillTarget(null)}>
          <div className="w-full max-w-sm rounded-xl bg-bg-secondary p-4">
            <h3 className="text-lg font-semibold">Session Actions</h3>
            {killTargetSession?.displayName && <p className="mt-1 truncate text-xs text-text-muted">{killTargetSession.displayName}</p>}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                onClick={() => moveSessionByOffset(killTarget, -1)}
                disabled={getSessionPosition(killTarget).index <= 0}
                className="rounded-lg bg-bg-tertiary px-3 py-2 text-sm disabled:opacity-40"
              >Move Up</button>
              <button
                onClick={() => moveSessionByOffset(killTarget, 1)}
                disabled={getSessionPosition(killTarget).index >= getSessionPosition(killTarget).count - 1}
                className="rounded-lg bg-bg-tertiary px-3 py-2 text-sm disabled:opacity-40"
              >Move Down</button>
            </div>
            <p className="my-4 text-sm text-text-secondary">Kill <span className="font-mono text-accent-red">{killTarget}</span>? This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setKillTarget(null)} className="rounded-lg bg-bg-tertiary px-4 py-2">Cancel</button>
              <button onClick={() => { void killSession() }} className="rounded-lg bg-accent-red px-4 py-2 text-white">Kill Session</button>
            </div>
          </div>
        </div>
      )}
      <HerdrRenameModal target={renameTarget} onClose={() => setRenameTarget(null)} onSettled={refreshSource} />
    </aside>
  )
}
