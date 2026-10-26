import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentStatus } from '../contexts/ServerEventsContext'
import type { HerdrRenameTarget } from './HerdrRenameModal'
import { copyTextToClipboard } from '../utils/dump-file'
import {
  buildHerdrTree,
  compactWindowLabel,
  herdrDispatchCommand,
  herdrDispatchInstructions,
  herdrMoveBoundary,
  type HerdrListPayload,
  type HerdrTreePane,
  type HerdrTreeTab,
  type HerdrTreeWorkspace,
} from '../utils/herdr-sessions'

const FOLDED_KEY = 'herdr_sidebar_folded'
const TERMINALS_OPEN_KEY = 'herdr_sidebar_terminals_open'
const LONG_RUN_POLL_INTERVAL = 15000
const LONG_PRESS_DURATION = 500
const LONG_PRESS_SLOP = 10
const NOTICE_DURATION = 2500

const STATUS_STYLE: Record<AgentStatus, { label: string; dot: string }> = {
  idle: { label: '空闲', dot: 'bg-accent-green' },
  working: { label: '工作中', dot: 'bg-accent-blue animate-pulse' },
  blocked: { label: '等你回答', dot: 'bg-accent-orange animate-pulse' },
  done: { label: '已完成，还没看', dot: 'bg-accent-purple' },
  unknown: { label: '未知', dot: 'bg-text-muted' },
}

const HOT_STATUSES: AgentStatus[] = ['working', 'blocked', 'done']

interface HerdrTreeProps {
  payload: HerdrListPayload | null
  loaded: boolean
  query: string
  selectedPaneId: string | null
  switchingPaneId: string | null
  onSelect: (paneId: string) => void
  onOpen: (paneId: string) => void
  onRename: (target: HerdrRenameTarget) => void
  onChanged: () => void
}

type MenuTarget =
  | { kind: 'pane'; pane: HerdrTreePane; tab: HerdrTreeTab; head: boolean; workspace: HerdrTreeWorkspace }
  | { kind: 'workspace'; workspace: HerdrTreeWorkspace; siblings: HerdrTreeWorkspace[] }

interface MenuItem {
  id: string
  label: string
  hint?: string
  danger?: boolean
  divider?: boolean
  run: () => void
}

const readFolded = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[])
  } catch {
    return new Set<string>()
  }
}

const tabPanes = (tab: HerdrTreeTab) => [tab.head, ...tab.under]
const workspacePanes = (workspace: HerdrTreeWorkspace) => workspace.tabs.flatMap(tabPanes)

const responseError = async (response: Response) => {
  const data = await response.json().catch(() => null) as { message?: string } | null
  return data?.message ?? `HTTP ${response.status}`
}

const RowMenu: React.FC<{ x: number; y: number; title: string; items: MenuItem[]; onClose: () => void }> = ({ x, y, title, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const box = menuRef.current?.getBoundingClientRect()
    if (!box) return
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)),
    })
  }, [x, y])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[80]" onClick={onClose} onContextMenu={event => { event.preventDefault(); onClose() }}>
      <div
        ref={menuRef}
        role="menu"
        aria-label={title}
        style={{ left: position.left, top: position.top }}
        className="fixed w-80 max-w-[calc(100vw-16px)] rounded-xl border border-border-subtle bg-bg-secondary p-1 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        {items.map(item => (
          <div key={item.id}>
            {item.divider && <div className="my-1 border-t border-border-subtle" />}
            <button
              type="button"
              role="menuitem"
              onClick={() => { onClose(); item.run() }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-bg-tertiary ${item.danger ? 'text-accent-red' : 'text-text-primary'}`}
            >
              <span className="min-w-0 flex-1">{item.label}</span>
              {item.hint && <span className="max-w-[45%] shrink-0 truncate font-mono text-xs text-text-muted">{item.hint}</span>}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export const HerdrTree: React.FC<HerdrTreeProps> = ({
  payload,
  loaded,
  query,
  selectedPaneId,
  switchingPaneId,
  onSelect,
  onOpen,
  onRename,
  onChanged,
}) => {
  const [folded, setFolded] = useState<Set<string>>(readFolded)
  const [terminalsOpen, setTerminalsOpen] = useState(() => localStorage.getItem(TERMINALS_OPEN_KEY) === '1')
  const [longRuns, setLongRuns] = useState<Record<string, number>>({})
  const [menu, setMenu] = useState<{ target: MenuTarget; x: number; y: number } | null>(null)
  const [closing, setClosing] = useState<HerdrTreePane | null>(null)
  const [creating, setCreating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ kind: 'workspace' | 'tab'; id: string; workspaceId: string } | null>(null)
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const longPress = useRef<{ timer: number | null; x: number; y: number; fired: boolean }>({ timer: null, x: 0, y: 0, fired: false })

  const tree = useMemo(() => buildHerdrTree(payload), [payload])

  const claudePanes = useMemo(() => tree
    .flatMap(workspacePanes)
    .filter(pane => pane.agent === 'claude')
    .map(pane => pane.paneId)
    .sort()
    .join(' '), [tree])

  // The auto-compact window each Claude pane was started with, read by the server from the process environment.
  useEffect(() => {
    if (!claudePanes) {
      setLongRuns({})
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/herdr/long-run', { signal: AbortSignal.timeout(3000) })
        if (!response.ok) throw new Error(await responseError(response))
        const data = await response.json() as { panes?: Record<string, number> }
        if (!cancelled && data.panes && !Array.isArray(data.panes)) setLongRuns(data.panes)
      } catch (lookupError) {
        console.error('[HerdrTree] Long-run lookup failed:', lookupError)
      }
    }
    void load()
    const poll = window.setInterval(() => { void load() }, LONG_RUN_POLL_INTERVAL)
    return () => {
      cancelled = true
      window.clearInterval(poll)
    }
  }, [claudePanes])

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    if (longPress.current.timer) window.clearTimeout(longPress.current.timer)
  }, [])

  const flash = (message: string) => {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_DURATION)
  }

  const saveFolded = (next: Set<string>) => {
    setFolded(next)
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]))
  }

  const toggleTerminals = (open: boolean) => {
    setTerminalsOpen(open)
    localStorage.setItem(TERMINALS_OPEN_KEY, open ? '1' : '0')
  }

  const request = async (url: string, failure: string): Promise<Record<string, unknown> | null> => {
    setError(null)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(await responseError(response))
      const data = await response.json().catch(() => ({})) as Record<string, unknown>
      onChanged()
      return data
    } catch (requestError) {
      console.error(`[HerdrTree] ${failure}:`, requestError)
      setError(`${failure}: ${requestError instanceof Error ? requestError.message : String(requestError)}`)
      return null
    }
  }

  // Herdr names an unnamed tab by its place, so a new tab needs no name from us.
  const newTab = async (workspace: HerdrTreeWorkspace) => {
    if (creating) return
    setCreating(workspace.workspaceId)
    try {
      const data = await request(`/api/herdr/create?workspace=${encodeURIComponent(workspace.workspaceId)}`, '新建标签页失败')
      if (typeof data?.paneId === 'string') onOpen(data.paneId)
    } finally {
      setCreating(null)
    }
  }

  // Moves go to Herdr itself, so the sidebar and the Herdr TUI always share one order.
  const move = (kind: 'workspace' | 'tab', id: string, targetId: string, after: boolean) => {
    const ids = kind === 'workspace'
      ? (payload?.workspaces ?? []).map(workspace => workspace.workspace_id)
      : (payload?.tabs ?? []).filter(tab => tab.workspace_id === tabWorkspace(id)).map(tab => tab.tab_id)
    const boundary = herdrMoveBoundary(ids, id, targetId, after)
    if (boundary === null) return
    void request(`/api/herdr/move?${kind}=${encodeURIComponent(id)}&index=${boundary}`, '移动失败')
  }

  const tabWorkspace = (tabId: string) => payload?.tabs?.find(tab => tab.tab_id === tabId)?.workspace_id

  const copy = async (text: string, said: string) => {
    const ok = await copyTextToClipboard(text)
    flash(ok ? said : '复制失败：浏览器不允许访问剪贴板')
  }

  const menuItems = (target: MenuTarget): MenuItem[] => {
    if (target.kind === 'workspace') {
      const { workspace, siblings } = target
      const index = siblings.findIndex(candidate => candidate.workspaceId === workspace.workspaceId)
      const above = siblings[index - 1]
      const below = siblings[index + 1]
      return [
        { id: 'new-tab', label: `在 ${workspace.label} 新建标签页`, run: () => { void newTab(workspace) } },
        { id: 'rename', label: '重命名工作区', run: () => onRename({ kind: 'workspace', id: workspace.workspaceId, label: workspace.label, context: `Workspace ${workspace.workspaceId}` }) },
        ...(above ? [{ id: 'move-up', label: '工作区上移', divider: true, run: () => move('workspace', workspace.workspaceId, above.workspaceId, false) }] : []),
        ...(below ? [{ id: 'move-down', label: '工作区下移', divider: !above, run: () => move('workspace', workspace.workspaceId, below.workspaceId, true) }] : []),
      ]
    }
    const { pane, tab, head, workspace } = target
    const dispatchTarget = pane.agentName ?? pane.paneId
    const tabs = workspace.tabs.filter(candidate => candidate.tabId)
    const index = tabs.findIndex(candidate => candidate.tabId === tab.tabId)
    const above = head && tab.tabId ? tabs[index - 1]?.tabId : undefined
    const below = head && tab.tabId ? tabs[index + 1]?.tabId : undefined
    const tabId = tab.tabId
    return [
      { id: 'copy-id', label: '复制窗格 ID', hint: pane.paneId, run: () => { void copy(pane.paneId, '已复制窗格 ID') } },
      ...(pane.agentName ? [{ id: 'copy-name', label: '复制名字', hint: pane.agentName, run: () => { void copy(pane.agentName ?? '', '已复制名字') } }] : []),
      ...(pane.agent ? [
        { id: 'copy-dispatch', label: '复制派活命令', run: () => { void copy(herdrDispatchCommand(dispatchTarget), '已复制派活命令') } },
        { id: 'copy-instructions', label: '复制派活说明（贴给其他 agent）', run: () => { void copy(herdrDispatchInstructions(pane), '已复制派活说明，贴给另一个会话就行') } },
      ] : []),
      ...(above && tabId ? [{ id: 'move-up', label: '标签页上移', divider: true, run: () => move('tab', tabId, above, false) }] : []),
      ...(below && tabId ? [{ id: 'move-down', label: '标签页下移', divider: !above, run: () => move('tab', tabId, below, true) }] : []),
      ...(tabId ? [{ id: 'rename', label: '重命名标签页', divider: true, run: () => onRename({ kind: 'tab', id: tabId, label: tab.label, context: `Tab ${tabId} · applies to every pane in this tab` }) }] : []),
      { id: 'close', label: '关闭窗格', danger: true, divider: true, run: () => setClosing(pane) },
    ]
  }

  const openMenuAt = (event: React.MouseEvent, target: MenuTarget) => {
    event.preventDefault()
    setMenu({ target, x: event.clientX, y: event.clientY })
  }

  const openMenuBelow = (event: React.MouseEvent<HTMLElement>, target: MenuTarget) => {
    const box = event.currentTarget.getBoundingClientRect()
    setMenu({ target, x: box.right - 320, y: box.bottom + 4 })
  }

  const cancelLongPress = () => {
    if (longPress.current.timer) window.clearTimeout(longPress.current.timer)
    longPress.current.timer = null
  }

  const longPressHandlers = (target: MenuTarget) => ({
    onPointerDown: (event: React.PointerEvent) => {
      longPress.current.fired = false
      if (event.pointerType === 'mouse') return
      cancelLongPress()
      const { clientX: x, clientY: y } = event
      longPress.current = {
        fired: false,
        x,
        y,
        timer: window.setTimeout(() => {
          longPress.current.fired = true
          longPress.current.timer = null
          navigator.vibrate?.(10)
          setMenu({ target, x, y })
        }, LONG_PRESS_DURATION),
      }
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (!longPress.current.timer) return
      if (Math.hypot(event.clientX - longPress.current.x, event.clientY - longPress.current.y) > LONG_PRESS_SLOP) cancelLongPress()
    },
    onPointerUp: cancelLongPress,
    onPointerCancel: cancelLongPress,
    onPointerLeave: cancelLongPress,
  })

  // A press that opened the menu must not also switch panes.
  const press = (paneId: string) => {
    if (longPress.current.fired) {
      longPress.current.fired = false
      return
    }
    onSelect(paneId)
  }

  const endDrag = () => {
    setDrag(null)
    setDrop(null)
  }

  const startDrag = (event: React.DragEvent, kind: 'workspace' | 'tab', id: string, workspaceId: string) => {
    event.dataTransfer?.setData('text/plain', id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
    setDrag({ kind, id, workspaceId })
  }

  const dropZone = (kind: 'workspace' | 'tab', id: string, workspaceId: string) => ({
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!drag || drag.kind !== kind || drag.id === id || (kind === 'tab' && drag.workspaceId !== workspaceId)) return
      event.preventDefault()
      event.stopPropagation()
      const box = event.currentTarget.getBoundingClientRect()
      const after = event.clientY > box.top + box.height / 2
      if (drop?.id !== id || drop.after !== after) setDrop({ id, after })
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      if (!drag || drag.kind !== kind || drop?.id !== id) return
      event.preventDefault()
      event.stopPropagation()
      const moved = drag.id
      const after = drop.after
      endDrag()
      move(kind, moved, id, after)
    },
  })

  const dropMark = (id?: string) => !id || drop?.id !== id ? '' : drop.after ? 'shadow-[inset_0_-2px_0_var(--accent-purple)]' : 'shadow-[inset_0_2px_0_var(--accent-purple)]'

  const matchesPane = (pane: HerdrTreePane, tab: HerdrTreeTab) => [
    pane.title, pane.agent, pane.agentName, pane.paneId, pane.cwd, tab.customName,
  ].some(value => value?.toLocaleLowerCase().includes(query))

  const visible = tree.flatMap(workspace => {
    if (!query || workspace.label.toLocaleLowerCase().includes(query)) return [workspace]
    const tabs = workspace.tabs.filter(tab => tabPanes(tab).some(pane => matchesPane(pane, tab)))
    return tabs.length > 0 ? [{ ...workspace, tabs }] : []
  })
  const withAgents = visible.filter(workspace => workspace.hasAgent)
  const terminalsOnly = visible.filter(workspace => !workspace.hasAgent)
  const holdsSelection = (workspace: HerdrTreeWorkspace) => workspacePanes(workspace).some(pane => pane.paneId === selectedPaneId)

  const foldKeys = withAgents.map(workspace => workspace.workspaceId)
  const anyOpen = foldKeys.some(key => !folded.has(key))
  const foldAll = () => {
    const next = new Set(folded)
    foldKeys.forEach(key => { if (anyOpen) next.add(key); else next.delete(key) })
    saveFolded(next)
  }

  const renderPane = (pane: HerdrTreePane, tab: HerdrTreeTab, workspace: HerdrTreeWorkspace, under: boolean) => {
    const selected = pane.paneId === selectedPaneId
    const status = STATUS_STYLE[pane.status]
    const longRun = longRuns[pane.paneId]
    const title = !under && tab.customName ? tab.customName : pane.title
    const target: MenuTarget = { kind: 'pane', pane, tab, head: !under, workspace }
    const draggable = !query && !under && Boolean(tab.tabId)
    const subtitle = [
      pane.agent,
      pane.agentName ? `@${pane.agentName}` : undefined,
      title !== pane.title ? pane.title : undefined,
      pane.folder !== title ? pane.folder : undefined,
    ].filter(Boolean).join(' · ')
    return (
      <div
        key={pane.paneId}
        data-pane-id={pane.paneId}
        onContextMenu={event => openMenuAt(event, target)}
        className={`group flex items-stretch rounded-lg transition-colors ${under ? 'ml-5' : ''} ${selected ? 'bg-accent-purple/20' : 'hover:bg-bg-tertiary'}`}
      >
        <button
          type="button"
          onClick={() => press(pane.paneId)}
          {...longPressHandlers(target)}
          draggable={draggable}
          onDragStart={event => { if (draggable && tab.tabId) startDrag(event, 'tab', tab.tabId, workspace.workspaceId) }}
          onDragEnd={endDrag}
          aria-current={selected ? 'page' : undefined}
          aria-busy={switchingPaneId === pane.paneId ? true : undefined}
          data-agent-status={pane.agent ? pane.status : undefined}
          title={[pane.title, pane.cwd].filter(Boolean).join('\n')}
          className="flex min-w-0 flex-1 select-none items-center gap-2 px-2 py-1.5 text-left [-webkit-touch-callout:none]"
        >
          <span className="flex w-4 shrink-0 justify-center">
            {pane.agent
              ? <span className={`h-2 w-2 rounded-full ${status.dot}`} role="img" aria-label={status.label} title={status.label} />
              : <span className="font-mono text-[10px] text-text-muted" aria-hidden="true">&gt;_</span>}
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-sm ${selected ? 'font-medium text-accent-purple' : 'text-text-primary'}`}>{title}</span>
            {subtitle && <span className="block truncate text-[11px] text-text-muted">{subtitle}</span>}
          </span>
          {longRun !== undefined && (
            <span
              className="shrink-0 rounded-md bg-accent-blue/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent-blue"
              title={`上下文到 ${compactWindowLabel(longRun)} tokens 才自动压缩（long run）`}
            >{compactWindowLabel(longRun)}</span>
          )}
        </button>
        <button
          type="button"
          onClick={event => openMenuBelow(event, target)}
          aria-label={`Actions for ${pane.paneId}`}
          aria-haspopup="menu"
          className="px-2 text-text-muted hover:text-text-primary"
        >⋯</button>
      </div>
    )
  }

  const renderTabs = (workspace: HerdrTreeWorkspace) => workspace.tabs.map(tab => (
    <div
      key={tab.tabId ?? tab.head.paneId}
      data-tab-id={tab.tabId}
      {...(tab.tabId ? dropZone('tab', tab.tabId, workspace.workspaceId) : {})}
      className={`space-y-0.5 rounded-lg ${dropMark(tab.tabId)}`}
    >
      {renderPane(tab.head, tab, workspace, false)}
      {tab.under.map(pane => renderPane(pane, tab, workspace, true))}
    </div>
  ))

  const headActions = (workspace: HerdrTreeWorkspace, siblings: HerdrTreeWorkspace[]) => workspace.workspaceId && (
    <>
      <button
        type="button"
        onClick={() => { void newTab(workspace) }}
        disabled={creating !== null}
        className="rounded px-2 py-1 text-sm text-text-muted hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40"
        aria-label={`New tab in ${workspace.label}`}
        title="新建标签页"
      >{creating === workspace.workspaceId ? '…' : '+'}</button>
      <button
        type="button"
        onClick={event => openMenuBelow(event, { kind: 'workspace', workspace, siblings })}
        className="mr-1 rounded px-2 py-1 text-sm text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
        aria-label={`Actions for workspace ${workspace.label}`}
        aria-haspopup="menu"
      >⋯</button>
    </>
  )

  const agentGroups = withAgents.map(workspace => {
    const active = holdsSelection(workspace)
    const open = !folded.has(workspace.workspaceId) || active || Boolean(query)
    const statuses = workspacePanes(workspace).filter(pane => pane.agent).map(pane => pane.status)
    const hot = open ? undefined : HOT_STATUSES.find(status => statuses.includes(status))
    const menuTarget: MenuTarget = { kind: 'workspace', workspace, siblings: withAgents }
    const movable = Boolean(workspace.workspaceId) && !query
    return (
      <section
        key={workspace.workspaceId || '__other__'}
        data-workspace-id={workspace.workspaceId}
        data-active-workspace={active ? 'true' : undefined}
        {...(workspace.workspaceId ? dropZone('workspace', workspace.workspaceId, workspace.workspaceId) : {})}
        className={`mb-1 rounded-xl border transition-colors ${active ? 'border-accent-purple/40 bg-accent-purple/5' : 'border-transparent'} ${dropMark(workspace.workspaceId)}`}
      >
        <div className="flex items-center" onContextMenu={event => { if (workspace.workspaceId) openMenuAt(event, menuTarget) }}>
          <button
            type="button"
            onClick={() => {
              const next = new Set(folded)
              if (open) next.add(workspace.workspaceId)
              else next.delete(workspace.workspaceId)
              saveFolded(next)
            }}
            {...(workspace.workspaceId ? longPressHandlers(menuTarget) : {})}
            draggable={movable}
            onDragStart={event => { if (movable) startDrag(event, 'workspace', workspace.workspaceId, workspace.workspaceId) }}
            onDragEnd={endDrag}
            aria-expanded={open}
            title={workspace.workspaceId || undefined}
            className="flex min-w-0 flex-1 select-none items-center gap-2 px-2 py-2 text-left text-xs font-semibold text-text-secondary [-webkit-touch-callout:none]"
          >
            <span className="w-3 shrink-0 text-text-muted">{open ? '▾' : '▸'}</span>
            <span className="flex w-2 shrink-0 justify-center">
              {hot && <span className={`h-2 w-2 rounded-full ${STATUS_STYLE[hot].dot}`} role="img" aria-label={STATUS_STYLE[hot].label} />}
            </span>
            <span className={`truncate ${active ? 'text-accent-purple' : ''}`}>{workspace.label}</span>
            <span className="ml-auto pr-1 font-normal text-text-muted">{workspace.tabs.length}</span>
          </button>
          {headActions(workspace, withAgents)}
        </div>
        {open && <div className="space-y-0.5 pb-1">{renderTabs(workspace)}</div>}
      </section>
    )
  })

  // A terminals-only workspace is one line; its panes show only while it holds the open pane.
  const restHolds = terminalsOnly.some(holdsSelection)
  const restOpen = terminalsOpen || restHolds || Boolean(query)
  const terminalGroup = terminalsOnly.length > 0 && (
    <section data-terminals-only="true" className="mt-2 border-t border-border-subtle pt-2">
      <button
        type="button"
        onClick={() => toggleTerminals(!restOpen)}
        aria-expanded={restOpen}
        className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs font-semibold text-text-secondary"
      >
        <span className="w-3 shrink-0 text-text-muted">{restOpen ? '▾' : '▸'}</span>
        <span>只有终端</span>
        <span className="ml-auto pr-1 font-normal text-text-muted">{terminalsOnly.length}</span>
      </button>
      {restOpen && terminalsOnly.map(workspace => {
        const panes = workspacePanes(workspace)
        const holds = holdsSelection(workspace)
        const target = panes.find(pane => pane.tabId === workspace.activeTabId && pane.focused)
          ?? panes.find(pane => pane.tabId === workspace.activeTabId)
          ?? panes[0]
        const menuTarget: MenuTarget = { kind: 'workspace', workspace, siblings: terminalsOnly }
        const movable = Boolean(workspace.workspaceId) && !query
        return (
          <div
            key={workspace.workspaceId || '__other__'}
            data-workspace-id={workspace.workspaceId}
            {...(workspace.workspaceId ? dropZone('workspace', workspace.workspaceId, workspace.workspaceId) : {})}
            className={`rounded-lg ${holds ? 'bg-accent-purple/10' : ''} ${dropMark(workspace.workspaceId)}`}
          >
            <div className="flex items-center" onContextMenu={event => { if (workspace.workspaceId) openMenuAt(event, menuTarget) }}>
              <button
                type="button"
                onClick={() => { if (target) press(target.paneId) }}
                {...(workspace.workspaceId ? longPressHandlers(menuTarget) : {})}
                disabled={!target}
                draggable={movable}
                onDragStart={event => { if (movable) startDrag(event, 'workspace', workspace.workspaceId, workspace.workspaceId) }}
                onDragEnd={endDrag}
                aria-current={holds ? 'page' : undefined}
                aria-busy={target && switchingPaneId === target.paneId ? true : undefined}
                title={target?.cwd || workspace.workspaceId}
                className="flex min-w-0 flex-1 select-none items-center gap-2 px-2 py-1.5 text-left [-webkit-touch-callout:none]"
              >
                <span className="flex w-4 shrink-0 justify-center font-mono text-[10px] text-text-muted" aria-hidden="true">&gt;_</span>
                <span className={`truncate text-sm ${holds ? 'font-medium text-accent-purple' : 'text-text-primary'}`}>{workspace.label}</span>
                {panes.length > 1 && <span className="ml-auto pr-1 text-[11px] text-text-muted">{panes.length}</span>}
              </button>
              {headActions(workspace, terminalsOnly)}
            </div>
            {((holds && panes.length > 1) || query) && <div className="space-y-0.5 pb-1 pl-3">{renderTabs(workspace)}</div>}
          </div>
        )
      })}
    </section>
  )

  const menuTitle = menu ? (menu.target.kind === 'workspace' ? menu.target.workspace.label : menu.target.pane.title) : ''

  return (
    <div>
      {withAgents.length > 0 && (
        <div className="mb-1 flex items-center px-2 text-[11px] text-text-muted">
          <span>会话</span>
          <button
            type="button"
            onClick={foldAll}
            disabled={Boolean(query)}
            className="ml-auto rounded px-2 py-1 hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40"
          >{anyOpen ? '全部收起' : '全部展开'}</button>
        </div>
      )}
      {agentGroups}
      {terminalGroup}
      {visible.length === 0 && (
        <div className="px-3 py-8 text-center text-sm text-text-muted">
          {!loaded ? '正在加载 Herdr 工作区…' : query ? '没有匹配的窗格' : '没有 Herdr 工作区或窗格'}
        </div>
      )}
      {error && <p role="alert" className="mx-1 mt-2 rounded-lg bg-accent-red/10 px-3 py-2 text-xs text-accent-red">{error}</p>}
      {notice && <p role="status" className="fixed bottom-4 left-1/2 z-[90] -translate-x-1/2 rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-primary shadow-lg">{notice}</p>}
      {menu && <RowMenu x={menu.x} y={menu.y} title={menuTitle} items={menuItems(menu.target)} onClose={() => setMenu(null)} />}
      {closing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" onClick={event => event.target === event.currentTarget && setClosing(null)}>
          <div role="dialog" aria-label="关闭窗格" className="w-full max-w-sm rounded-xl bg-bg-secondary p-4">
            <h3 className="text-lg font-semibold">关闭窗格</h3>
            <p className="my-4 text-sm text-text-secondary">
              关闭 <span className="font-medium text-text-primary">{closing.title}</span>（<span className="font-mono">{closing.paneId}</span>）并结束其中运行的程序？此操作无法撤销。
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setClosing(null)} className="rounded-lg bg-bg-tertiary px-4 py-2">取消</button>
              <button
                type="button"
                onClick={() => {
                  const paneId = closing.paneId
                  setClosing(null)
                  void request(`/api/herdr/close?pane=${encodeURIComponent(paneId)}`, '关闭失败')
                }}
                className="rounded-lg bg-accent-red px-4 py-2 text-white"
              >确认关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
