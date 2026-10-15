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
}

export interface HerdrWorkspace {
  workspace_id: string
  label?: string
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
}

export interface HerdrListPayload {
  panes?: HerdrPane[]
  workspaces?: HerdrWorkspace[]
  tabs?: HerdrTab[]
  agents?: HerdrAgent[]
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
