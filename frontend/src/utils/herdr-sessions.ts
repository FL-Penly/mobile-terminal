import type { AgentStatus, DiscoveredTmuxSession, TmuxProjectGroup } from '../contexts/ServerEventsContext'

export interface HerdrPane {
  pane_id: string
  workspace_id: string
  tab_id?: string
  label?: string | null
  title?: string | null
  terminal_title_stripped?: string | null
  agent?: string | null
  cwd?: string | null
  foreground_cwd?: string | null
  focused?: boolean
  revision?: number
  agent_status?: AgentStatus
  /** Set by the server on a herdr-lens chat view. */
  lens_chat?: boolean
}

export interface HerdrWorkspace {
  workspace_id: string
  label?: string
  active_tab_id?: string
}

export interface HerdrTab {
  tab_id: string
  workspace_id: string
  label?: string
}

export interface HerdrAgent {
  pane_id: string
  agent?: string | null
  agent_status?: AgentStatus
  name?: string | null
  terminal_title_stripped?: string | null
}

export interface HerdrListPayload {
  panes?: HerdrPane[]
  workspaces?: HerdrWorkspace[]
  tabs?: HerdrTab[]
  agents?: HerdrAgent[]
  /** Whether herdr-lens is installed, enabled and built. */
  lens?: { chat?: boolean }
}

export interface HerdrSessions {
  projectGroups: TmuxProjectGroup[]
  otherSessions: DiscoveredTmuxSession[]
}

const nonEmpty = (value?: string | null) => value?.trim() || undefined

// Herdr labels an unnamed tab with its 1-based position in the workspace (tab.list order),
// so only a label that differs from that position is a name the user gave it.
const herdrTabNames = (tabs: HerdrTab[]) => {
  const positions = new Map<string, number>()
  return new Map(tabs.map(tab => {
    const position = (positions.get(tab.workspace_id) ?? 0) + 1
    positions.set(tab.workspace_id, position)
    const label = nonEmpty(tab.label) ?? String(position)
    return [tab.tab_id, { label, custom: label === String(position) ? undefined : label }]
  }))
}

// `name` stays the pane id because switching, closing and ordering all target it;
// `displayName` follows Herdr: custom tab name, then the pane's manual label, agent title or terminal title.
export const mapHerdrSessions = (payload: HerdrListPayload): HerdrSessions => {
  const panes = payload.panes ?? []
  const workspaces = payload.workspaces ?? []
  const agents = new Map((payload.agents ?? []).map(agent => [agent.pane_id, agent]))
  const tabs = herdrTabNames(payload.tabs ?? [])
  const panesPerTab = new Map<string, number>()
  panes.forEach(pane => {
    if (pane.tab_id) panesPerTab.set(pane.tab_id, (panesPerTab.get(pane.tab_id) ?? 0) + 1)
  })
  const toSession = (pane: HerdrPane): DiscoveredTmuxSession => {
    const path = pane.foreground_cwd ?? pane.cwd ?? ''
    const pathParts = path.split('/').filter(Boolean)
    const agent = agents.get(pane.pane_id)
    const tab = pane.tab_id ? tabs.get(pane.tab_id) : undefined
    const paneTitle = nonEmpty(pane.label) ?? nonEmpty(pane.title) ?? nonEmpty(pane.terminal_title_stripped)
    const tabName = tab && (tab.custom ?? `Tab ${tab.label}`)
    const displayName = tab?.custom ?? paneTitle ?? tabName ?? pane.pane_id
    const sharesTab = (panesPerTab.get(pane.tab_id ?? '') ?? 0) > 1
    const detail = [
      tabName === displayName ? undefined : tabName,
      sharesTab ? (paneTitle && paneTitle !== displayName ? paneTitle : pane.pane_id) : undefined,
    ].filter(Boolean).join(' · ')
    return {
      name: pane.pane_id,
      displayName,
      detail: detail || undefined,
      tabId: pane.tab_id,
      tabLabel: tab?.label,
      path,
      relativePath: pathParts[pathParts.length - 1] ?? path,
      command: agent?.agent ?? 'shell',
      attached: pane.focused ?? false,
      windows: 1,
      lastActivity: pane.revision ?? 0,
      hasNewActivity: false,
      agentStatus: agent?.agent_status ?? pane.agent_status ?? 'unknown',
    }
  }
  const workspaceIds = new Set(workspaces.map(workspace => workspace.workspace_id))
  return {
    projectGroups: workspaces.map(workspace => ({
      projectRoot: workspace.workspace_id,
      displayName: nonEmpty(workspace.label) ?? workspace.workspace_id,
      sessions: panes.filter(pane => pane.workspace_id === workspace.workspace_id).map(toSession),
    })),
    otherSessions: panes.filter(pane => !workspaceIds.has(pane.workspace_id)).map(toSession),
  }
}

// ─── Sidebar tree ──────────────────────────────────────────────────────────

export interface HerdrTreePane {
  paneId: string
  tabId?: string
  workspaceId: string
  title: string
  /** The agent kind (`claude`, `codex`…); absent for a plain terminal. */
  agent?: string
  /** The name Herdr dispatches to (`herdr agent prompt <name>`). */
  agentName?: string
  status: AgentStatus
  cwd: string
  folder: string
  focused: boolean
  lensChat: boolean
}

export interface HerdrTreeTab {
  /** Absent when Herdr reported the pane without a known tab. */
  tabId?: string
  /** 1-based place in its workspace, which is also Herdr's automatic name. */
  position: number
  /** The raw Herdr label (the position for an unnamed tab). */
  label: string
  customName?: string
  head: HerdrTreePane
  under: HerdrTreePane[]
}

export interface HerdrTreeWorkspace {
  /** Empty for panes whose workspace Herdr no longer lists. */
  workspaceId: string
  label: string
  activeTabId?: string
  tabs: HerdrTreeTab[]
  hasAgent: boolean
}

const LENS_CHAT_TITLE = '会话视图'

export const isLensChatPane = (payload: HerdrListPayload | null, paneId: string | null) => (
  Boolean(paneId) && payload?.panes?.some(pane => pane.pane_id === paneId && pane.lens_chat === true) === true
)

const shortenHome = (path: string) => path.replace(/^(?:\/data\d+)?\/home\/[^/]+(?=\/|$)/, '~')

// A shell's title is its prompt (`user@host:/path`): the folder is the part worth reading.
const terminalTitle = (title?: string) => {
  const prompt = title?.match(/^[^\s@]+@[^\s:]+:\s*(.+)$/)
  if (!prompt) return title
  const path = shortenHome(prompt[1].trim())
  return path === '~' ? path : path.split('/').filter(Boolean).pop() ?? path
}

/** Herdr's workspaces in Herdr's order, each with its tabs in Herdr's order and a tab's panes under its first. */
export const buildHerdrTree = (payload: HerdrListPayload | null): HerdrTreeWorkspace[] => {
  if (!payload) return []
  const panes = payload.panes ?? []
  const agents = new Map((payload.agents ?? []).map(agent => [agent.pane_id, agent]))
  const tabNames = herdrTabNames(payload.tabs ?? [])
  const toPane = (pane: HerdrPane): HerdrTreePane => {
    const agentInfo = agents.get(pane.pane_id)
    const agent = nonEmpty(pane.agent) ?? nonEmpty(agentInfo?.agent)
    const cwd = pane.foreground_cwd ?? pane.cwd ?? ''
    const folder = cwd.split('/').filter(Boolean).pop() ?? cwd
    const lensChat = pane.lens_chat === true
    const title = (lensChat ? LENS_CHAT_TITLE : undefined)
      ?? nonEmpty(pane.label)
      ?? (agent
        ? nonEmpty(pane.title) ?? nonEmpty(agentInfo?.terminal_title_stripped) ?? nonEmpty(pane.terminal_title_stripped) ?? agent
        : nonEmpty(pane.title) ?? terminalTitle(nonEmpty(pane.terminal_title_stripped)) ?? (folder || undefined))
      ?? pane.pane_id
    return {
      paneId: pane.pane_id,
      tabId: pane.tab_id,
      workspaceId: pane.workspace_id,
      title,
      agent,
      agentName: agent ? nonEmpty(agentInfo?.name) : undefined,
      status: agentInfo?.agent_status ?? pane.agent_status ?? 'unknown',
      cwd,
      folder,
      focused: pane.focused ?? false,
      lensChat,
    }
  }
  const workspaceRows = (workspaceId: string, label: string, activeTabId?: string): HerdrTreeWorkspace => {
    const own = panes.filter(pane => pane.workspace_id === workspaceId).map(toPane)
    const knownTabs = (payload.tabs ?? []).filter(tab => tab.workspace_id === workspaceId)
    const known = new Set(knownTabs.map(tab => tab.tab_id))
    const tabs: HerdrTreeTab[] = []
    knownTabs.forEach((tab, index) => {
      const [head, ...under] = own.filter(pane => pane.tabId === tab.tab_id)
      const name = tabNames.get(tab.tab_id)
      if (head) tabs.push({ tabId: tab.tab_id, position: index + 1, label: name?.label ?? String(index + 1), customName: name?.custom, head, under })
    })
    own.filter(pane => !pane.tabId || !known.has(pane.tabId)).forEach(pane => {
      tabs.push({ position: tabs.length + 1, label: String(tabs.length + 1), head: pane, under: [] })
    })
    return { workspaceId, label, activeTabId, tabs, hasAgent: own.some(pane => pane.agent) }
  }
  const workspaces = payload.workspaces ?? []
  const listed = new Set(workspaces.map(workspace => workspace.workspace_id))
  const tree = workspaces.map(workspace => workspaceRows(
    workspace.workspace_id,
    nonEmpty(workspace.label) ?? workspace.workspace_id,
    workspace.active_tab_id,
  ))
  const orphans = panes.filter(pane => !listed.has(pane.workspace_id)).map(toPane)
  if (orphans.length === 0) return tree
  return [...tree, {
    workspaceId: '',
    label: 'Other',
    tabs: orphans.map((head, index) => ({ position: index + 1, label: String(index + 1), head, under: [] })),
    hasAgent: orphans.some(pane => pane.agent),
  }]
}

/** `500k`, `1m`, `1.2m`: an auto-compact window as the sidebar says it. */
export const compactWindowLabel = (size: number) => {
  if (size >= 1_000_000) return `${Number((size / 1_000_000).toFixed(1))}m`
  if (size >= 1_000) return `${Math.round(size / 1_000)}k`
  return String(size)
}

/**
 * Herdr's moves count insertion boundaries before the moved item is taken out:
 * the boundary that puts `id` just before or after `targetId`, or null when it would not move.
 */
export const herdrMoveBoundary = (ids: string[], id: string, targetId: string, after: boolean): number | null => {
  const from = ids.indexOf(id)
  const target = ids.indexOf(targetId)
  if (from < 0 || target < 0 || id === targetId) return null
  const boundary = target + (after ? 1 : 0)
  return boundary === from || boundary === from + 1 ? null : boundary
}

export const herdrDispatchCommand = (target: string) =>
  `herdr agent prompt ${target} "这里写任务" --wait --timeout 600000`

export const herdrDispatchInstructions = (pane: HerdrTreePane) => {
  const target = pane.agentName ?? pane.paneId
  const who = `${pane.agent ?? 'agent'}「${pane.title}」，目录 ${shortenHome(pane.cwd)}`
  return `把任务派给 herdr 里的 agent ${target}（${who}）：先用 \`herdr agent get ${target}\` 确认它空闲，再用 \`herdr agent prompt ${target} "<任务>" --wait --timeout 600000\` 发过去，完成后用 \`herdr agent read ${target}\` 看结果。详细用法见 \`herdr --skill\`。`
}
