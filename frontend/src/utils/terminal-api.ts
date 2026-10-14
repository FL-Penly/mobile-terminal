import type { TerminalMux } from '../contexts/TerminalContext'

export const withTerminalTarget = (
  url: string,
  mux: TerminalMux,
  paneId: string | null,
  clientTty: string | null,
): string => {
  const [path, query = ''] = url.split('?', 2)
  const params = new URLSearchParams(query)

  if (mux === 'herdr') {
    params.set('mux', 'herdr')
    if (paneId) params.set('pane', paneId)
    else params.delete('pane')
    params.delete('client_tty')
  } else if (clientTty) {
    params.set('client_tty', clientTty)
  }

  const encoded = params.toString()
  return encoded ? `${path}?${encoded}` : path
}

interface HerdrPaneSummary {
  pane_id: string
  workspace_id: string
  focused?: boolean
}

export const isMissingHerdrPaneReason = (reason: string): boolean => (
  /terminal target \S+ not found/i.test(reason)
)

// Prefer the pane herdr considers active in the same workspace, then anywhere else.
export const pickHerdrFallbackPane = (panes: HerdrPaneSummary[], missingPaneId: string): string | null => {
  const workspaceId = missingPaneId.split(':', 1)[0]
  const candidates = panes.filter(pane => pane.pane_id !== missingPaneId)
  const sameWorkspace = candidates.filter(pane => pane.workspace_id === workspaceId)
  const fallback = sameWorkspace.find(pane => pane.focused)
    ?? sameWorkspace[0]
    ?? candidates.find(pane => pane.focused)
    ?? candidates[0]
  return fallback?.pane_id ?? null
}

export const findHerdrFallbackPane = async (missingPaneId: string): Promise<string | null> => {
  try {
    const response = await fetch('/api/herdr/list', { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return null
    const data = await response.json() as { panes?: HerdrPaneSummary[] }
    return pickHerdrFallbackPane(data.panes ?? [], missingPaneId)
  } catch (error) {
    console.error('[Terminal] Herdr fallback pane lookup failed:', error)
    return null
  }
}
