import { useMemo, useRef, useState } from 'react'
import { useServerEvents, type DiscoveredTmuxSession, type TmuxProjectGroup } from '../contexts/ServerEventsContext'
import { useTerminal } from '../contexts/TerminalContext'
import { NewSessionModal } from './TmuxManager'

const COLLAPSED_GROUPS_KEY = 'tmux_sidebar_collapsed_groups'
const GROUP_ORDER_KEY = 'tmux_sidebar_group_order'
const LONG_PRESS_DURATION = 1200

interface TmuxSidebarProps {
  mobile: boolean
  onClose: () => void
  onCollapseDesktop: () => void
}

const shellQuote = (value: string) => `'${value.split("'").join(`'"'"'`)}'`

const sortSessions = (sessions: DiscoveredTmuxSession[], current: string | null) => [...sessions].sort((left, right) => {
  if (left.name === current) return -1
  if (right.name === current) return 1
  if (left.hasNewActivity !== right.hasNewActivity) return left.hasNewActivity ? -1 : 1
  if (left.lastActivity !== right.lastActivity) return right.lastActivity - left.lastActivity
  return left.name.localeCompare(right.name)
})

export const TmuxSidebar: React.FC<TmuxSidebarProps> = ({ mobile, onClose, onCollapseDesktop }) => {
  const { sendInput } = useTerminal()
  const {
    projectGroups,
    otherSessions,
    currentTmuxSession,
    clientTty,
    path,
    sessionsLoaded,
    refresh,
  } = useServerEvents()
  const [search, setSearch] = useState('')
  const [optimisticSession, setOptimisticSession] = useState<string | null>(null)
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false)
  const [quickShellLoading, setQuickShellLoading] = useState(false)
  const [killTarget, setKillTarget] = useState<string | null>(null)
  const [draggedGroup, setDraggedGroup] = useState<string | null>(null)
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
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
  const longPressTimer = useRef<number | null>(null)
  const longPressTriggered = useRef(false)
  const selectedSession = optimisticSession ?? currentTmuxSession

  const sortedGroups = useMemo(() => {
    const order = new Map(groupOrder.map((projectRoot, index) => [projectRoot, index]))
    return [...projectGroups].sort((left, right) => {
      const leftIndex = order.get(left.projectRoot)
      const rightIndex = order.get(right.projectRoot)
      if (leftIndex !== undefined || rightIndex !== undefined) {
        if (leftIndex === undefined) return 1
        if (rightIndex === undefined) return -1
        return leftIndex - rightIndex
      }
      return left.projectRoot.localeCompare(right.projectRoot)
    })
  }, [projectGroups, groupOrder])

  const query = search.trim().toLocaleLowerCase()
  const matches = (session: DiscoveredTmuxSession, group?: TmuxProjectGroup) => !query || [
    group?.displayName,
    group?.projectRoot,
    session.name,
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

  const switchSession = async (sessionName: string) => {
    if (longPressTriggered.current || sessionName === selectedSession) return
    const previous = currentTmuxSession
    setOptimisticSession(sessionName)
    try {
      if (!clientTty) throw new Error('No client tty')
      const url = `/api/tmux/switch?session=${encodeURIComponent(sessionName)}&client_tty=${encodeURIComponent(clientTty)}`
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error(await response.text())
      sessionStorage.setItem('ttyd_last_tmux_session', sessionName)
      if (mobile) onClose()
      window.setTimeout(refresh, 300)
    } catch (error) {
      console.error('[TmuxSidebar] Switch failed, using terminal fallback:', error)
      setOptimisticSession(previous)
      sendInput(` tmux attach -t ${shellQuote(sessionName)}\r`)
      sessionStorage.setItem('ttyd_last_tmux_session', sessionName)
      window.setTimeout(refresh, 500)
    }
  }

  const killSession = async () => {
    if (!killTarget) return
    try {
      const response = await fetch(`/api/tmux/kill?name=${encodeURIComponent(killTarget)}`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(await response.text())
      refresh()
    } catch (error) {
      console.error('[TmuxSidebar] Kill failed:', error)
    } finally {
      setKillTarget(null)
    }
  }

  const detach = async () => {
    try {
      if (!clientTty) throw new Error('No client tty')
      const response = await fetch(`/api/tmux/detach?client_tty=${encodeURIComponent(clientTty)}`, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error(await response.text())
    } catch (error) {
      console.error('[TmuxSidebar] Detach failed, using terminal fallback:', error)
      sendInput(' tmux detach\r')
    }
    if (mobile) onClose()
    window.setTimeout(refresh, 500)
  }

  const quickShell = async () => {
    if (!clientTty) return
    setQuickShellLoading(true)
    try {
      const response = await fetch(`/api/tmux/quick-shell?client_tty=${encodeURIComponent(clientTty)}`, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error(await response.text())
      if (mobile) onClose()
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

  const renderSession = (session: DiscoveredTmuxSession) => {
    const current = session.name === selectedSession
    return (
      <div key={session.name} className={`group flex items-stretch rounded-lg ${current ? 'bg-accent-purple/20' : 'hover:bg-bg-tertiary'}`}>
        <button
          onClick={() => { void switchSession(session.name) }}
          onTouchStart={() => startLongPress(session.name)}
          onTouchEnd={endLongPress}
          onMouseDown={() => startLongPress(session.name)}
          onMouseUp={endLongPress}
          onMouseLeave={endLongPress}
          className="min-w-0 flex-1 px-3 py-2 text-left"
          aria-current={current ? 'page' : undefined}
        >
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${session.hasNewActivity ? 'bg-accent-orange animate-pulse' : session.attached ? 'bg-accent-green' : 'bg-text-muted'}`} />
            <span className={`truncate text-sm font-medium ${current ? 'text-accent-purple' : 'text-text-primary'}`}>{session.name}</span>
            <span className="ml-auto shrink-0 text-[10px] text-text-muted">{session.windows}w</span>
          </div>
          <div className="mt-1 flex gap-2 pl-4 text-[11px] text-text-muted">
            <span className="truncate" title={session.path}>{session.relativePath}</span>
            <span className="ml-auto shrink-0 font-mono">{session.command}</span>
          </div>
        </button>
        <button
          onClick={() => setKillTarget(session.name)}
          className="px-2 text-text-muted hover:text-accent-red"
          aria-label={`Kill ${session.name}`}
        >
          ⋯
        </button>
      </div>
    )
  }

  const visibleGroups = sortedGroups
    .map(group => ({ ...group, sessions: sortSessions(group.sessions.filter(session => matches(session, group)), currentTmuxSession) }))
    .filter(group => group.sessions.length > 0)
  const visibleOther = sortSessions(otherSessions.filter(session => matches(session)), currentTmuxSession)
  const empty = visibleGroups.length === 0 && visibleOther.length === 0

  return (
    <aside className="flex h-full w-[280px] flex-col border-r border-border-subtle bg-bg-secondary text-text-primary">
      <div className="flex h-12 items-center gap-2 border-b border-border-subtle px-3">
        <span className="font-semibold">Tmux Sessions</span>
        <button onClick={mobile ? onClose : onCollapseDesktop} className="ml-auto rounded px-2 py-1 text-text-muted hover:bg-bg-tertiary" aria-label="Close sessions sidebar">×</button>
      </div>
      <div className="p-3">
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Search projects or sessions"
          className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm outline-none focus:border-accent-purple"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
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
            {!collapsedGroups.has(group.projectRoot) && <div className="space-y-1">{group.sessions.map(renderSession)}</div>}
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
            {!collapsedGroups.has('__other__') && <div className="space-y-1">{visibleOther.map(renderSession)}</div>}
          </section>
        )}
        {empty && <div className="px-3 py-8 text-center text-sm text-text-muted">{sessionsLoaded ? (search ? 'No matching sessions' : 'No tmux sessions') : 'Loading sessions…'}</div>}
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-border-subtle p-3 text-xs">
        <button onClick={() => setIsNewSessionOpen(true)} className="rounded-lg bg-accent-purple px-2 py-2 text-white">+ New Session</button>
        <button onClick={() => { void quickShell() }} disabled={!clientTty || quickShellLoading} className="rounded-lg bg-bg-tertiary px-2 py-2 disabled:opacity-50">{quickShellLoading ? 'Opening…' : 'Quick Shell'}</button>
        <button onClick={() => { void detach() }} className="col-span-2 rounded-lg bg-bg-tertiary px-2 py-2 text-text-secondary">Detach to Shell</button>
      </div>
      <NewSessionModal isOpen={isNewSessionOpen} onClose={() => setIsNewSessionOpen(false)} cwd={path || undefined} onCreated={refresh} />
      {killTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" onClick={event => event.target === event.currentTarget && setKillTarget(null)}>
          <div className="w-full max-w-sm rounded-xl bg-bg-secondary p-4">
            <h3 className="text-lg font-semibold">Kill Session?</h3>
            <p className="my-4 text-sm text-text-secondary">Kill <span className="font-mono text-accent-red">{killTarget}</span>? This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setKillTarget(null)} className="rounded-lg bg-bg-tertiary px-4 py-2">Cancel</button>
              <button onClick={() => { void killSession() }} className="rounded-lg bg-accent-red px-4 py-2 text-white">Kill Session</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
