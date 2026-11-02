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

const WorkspaceIcon: React.FC = () => (
  <svg className="h-3.5 w-3.5 shrink-0 text-accent-blue" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
    <path d="M2 3.25h4l1.5 1.5H14v7.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" strokeLinejoin="round" />
  </svg>
)

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
        className="fixed max-h-[calc(100dvh-16px)] w-80 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-border-subtle bg-bg-secondary p-1 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="border-b border-border-subtle px-3 py-2 text-xs font-medium leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{title}</div>
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
      pane.agentName && pane.agentName !== pane.agent ? `@${pane.agentName}` : undefined,
      !pane.agent && pane.folder !== title && pane.folder !== workspace.label ? pane.folder : undefined,
    ].filter(Boolean).join(' · ')
    return (
      <div
        key={pane.paneId}
        data-pane-id={pane.paneId}
        onContextMenu={event => openMenuAt(event, target)}
        className={`group/pane flex items-stretch rounded-lg transition-colors ${selected ? 'bg-tint-purple/15 shadow-[inset_2px_0_0_var(--accent-purple)]' : 'hover:bg-bg-tertiary'}`}
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
          title={[title, title !== pane.title ? pane.title : undefined, pane.cwd, pane.agent ? status.label : undefined].filter(Boolean).join('\n')}
          className="flex min-h-8 min-w-0 flex-1 select-none items-center gap-2 rounded-lg px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-purple [@media(pointer:coarse)]:min-h-11 [-webkit-touch-callout:none]"
        >
          <span className="flex w-4 shrink-0 justify-center">
            {pane.agent
              ? <span className={`h-2 w-2 rounded-full ${status.dot}`} role="img" aria-label={status.label} title={status.label} />
              : <span className="font-mono text-[10px] text-text-muted" aria-hidden="true">&gt;_</span>}
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-sm ${selected ? 'font-medium text-accent-purple' : 'text-text-primary'}`}>{title}</span>
            {(subtitle || longRun !== undefined) && (
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-[14px] text-text-secondary">
                {subtitle && <span className="truncate">{subtitle}</span>}
                {subtitle && longRun !== undefined && <span aria-hidden="true" className="text-text-muted">·</span>}
                {longRun !== undefined && (
                  <span
                    className="shrink-0 font-mono text-[10px] text-text-muted"
                    title={`上下文到 ${compactWindowLabel(longRun)} tokens 才自动压缩（long run）`}
                  >{compactWindowLabel(longRun)}</span>
                )}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={event => openMenuBelow(event, target)}
          aria-label={`Actions for ${pane.paneId}`}
          aria-haspopup="menu"
          className="w-8 shrink-0 rounded-lg text-text-muted outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-purple [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/pane:opacity-100 group-focus-within/pane:opacity-100 [@media(pointer:coarse)]:w-10"
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
      {tab.under.length > 0 && (
        <div className="ml-4 space-y-0.5 border-l border-border-subtle pl-2">
          {tab.under.map(pane => renderPane(pane, tab, workspace, true))}
        </div>
      )}
    </div>
  ))

  const headActions = (workspace: HerdrTreeWorkspace, siblings: HerdrTreeWorkspace[]) => workspace.workspaceId && (
    <>
      <button
        type="button"
        onClick={() => { void newTab(workspace) }}
        disabled={creating !== null}
        className="h-8 w-7 shrink-0 rounded text-sm text-text-muted opacity-0 group-hover/heading:opacity-100 group-focus-within/heading:opacity-100 hover:bg-bg-tertiary hover:text-text-primary focus-visible:opacity-100 disabled:opacity-40 [@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden"
        aria-label={`New tab in ${workspace.label}`}
        title="新建标签页"
      >{creating === workspace.workspaceId ? '…' : '+'}</button>
      <button
        type="button"
        onClick={event => openMenuBelow(event, { kind: 'workspace', workspace, siblings })}
        className="h-8 w-8 shrink-0 rounded text-sm text-text-muted hover:bg-bg-tertiary hover:text-text-primary [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/heading:opacity-100 group-focus-within/heading:opacity-100 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-10"
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
        className={`mb-3 rounded-lg ${dropMark(workspace.workspaceId)}`}
      >
        <div className="group/heading flex items-center rounded-lg bg-tint-blue/10" onContextMenu={event => { if (workspace.workspaceId) openMenuAt(event, menuTarget) }}>
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
            title={`Workspace: ${workspace.label}${workspace.workspaceId ? ` (${workspace.workspaceId})` : ''}`}
            className="flex min-h-8 min-w-0 flex-1 select-none items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-text-secondary hover:text-text-primary focus-visible:outline-accent-purple [@media(pointer:coarse)]:min-h-11 [-webkit-touch-callout:none]"
          >
            <span className="w-3 shrink-0 text-text-muted">{open ? '▾' : '▸'}</span>
            <WorkspaceIcon />
            <span className="truncate text-accent-blue">{workspace.label}</span>
            <span className="shrink-0 text-[10px] font-normal text-text-secondary">{workspace.tabs.length} {workspace.tabs.length === 1 ? 'tab' : 'tabs'}</span>
            {hot && <span className={`ml-1 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_STYLE[hot].dot}`} role="img" aria-label={STATUS_STYLE[hot].label} title={STATUS_STYLE[hot].label} />}
          </button>
          {headActions(workspace, withAgents)}
        </div>
        {open && <div className="mb-1 ml-4 mt-1 space-y-0.5 border-l border-border-subtle pl-2">{renderTabs(workspace)}</div>}
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
            className={`rounded-lg ${holds ? 'bg-tint-purple/5' : ''} ${dropMark(workspace.workspaceId)}`}
          >
            <div className="group/heading flex items-center rounded-lg bg-tint-blue/10" onContextMenu={event => { if (workspace.workspaceId) openMenuAt(event, menuTarget) }}>
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
                className="flex min-h-8 min-w-0 flex-1 select-none items-center gap-2 rounded-lg px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-purple [@media(pointer:coarse)]:min-h-11 [-webkit-touch-callout:none]"
              >
                <WorkspaceIcon />
                <span className={`truncate text-sm ${holds ? 'font-medium text-accent-purple' : 'text-text-primary'}`}>{workspace.label}</span>
                {panes.length > 1 && <span className="ml-auto pr-1 text-[11px] text-text-muted">{panes.length}</span>}
              </button>
              {headActions(workspace, terminalsOnly)}
            </div>
            {((holds && panes.length > 1) || query) && <div className="mb-1 ml-4 mt-1 space-y-0.5 border-l border-border-subtle pl-2">{renderTabs(workspace)}</div>}
          </div>
        )
      })}
    </section>
  )

  const menuTitle = menu ? (menu.target.kind === 'workspace' ? menu.target.workspace.label : (menu.target.head ? menu.target.tab.customName : undefined) ?? menu.target.pane.title) : ''

  return (
    <div>
      {withAgents.length > 0 && (
        <div className="mb-1 flex items-center px-2 text-[11px] text-text-muted">
          <span>工作区</span>
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
