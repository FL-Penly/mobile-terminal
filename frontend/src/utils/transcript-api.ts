import type { TerminalMux } from '../contexts/TerminalContext'
import { withTerminalTarget } from './terminal-api'

export type TranscriptBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'code'; id: string; lang: string; text: string }
  | { kind: 'command'; id: string; command: string; output: string; isError: boolean; exitCode?: number }
  | { kind: 'tool'; id: string; name: string; summary: string }

export type TranscriptAgent = 'claude' | 'codex'

export interface TranscriptPage {
  agent: TranscriptAgent
  agentStatus: string
  session: string
  blocks: TranscriptBlock[]
  cursor: number | null
  hasMore: boolean
}

export type TranscriptResult =
  | { ok: true; page: TranscriptPage }
  | { ok: false; code: string; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isPage = (value: unknown): value is TranscriptPage => (
  isRecord(value) && Array.isArray(value.blocks) && typeof value.session === 'string'
)

const errorResult = (payload: unknown, fallback: string): TranscriptResult => ({
  ok: false,
  code: isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'request_failed',
  message: isRecord(payload) && typeof payload.message === 'string' ? payload.message : fallback,
})

export const fetchTranscript = async (
  paneId: string,
  options: { before?: number; session?: string; limit?: number } = {},
): Promise<TranscriptResult> => {
  const params = new URLSearchParams({ pane: paneId })
  if (options.before !== undefined) params.set('before', String(options.before))
  if (options.session) params.set('session', options.session)
  if (options.limit) params.set('limit', String(options.limit))
  try {
    const response = await fetch(`/api/herdr/transcript?${params}`, { signal: AbortSignal.timeout(5000) })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok || !isPage(payload)) return errorResult(payload, `读取会话记录失败（${response.status}）`)
    return { ok: true, page: payload }
  } catch (error) {
    console.error('[CopyMode] Transcript request failed:', error)
    return { ok: false, code: 'network', message: '网络错误，读取会话记录失败' }
  }
}

export interface HistoryPage {
  lines: string[]
  cursor: number
  hasMore: boolean
}

// `before` counts rows already loaded from the bottom; 0 asks for the newest rows.
export const fetchHistory = async (
  mux: TerminalMux,
  paneId: string | null,
  clientTty: string | null,
  before: number,
): Promise<HistoryPage | null> => {
  if (mux === 'herdr' && !paneId) return null
  const base = mux === 'herdr' ? '/api/herdr/page-up' : '/api/tmux/page-up'
  const url = withTerminalTarget(`${base}?before=${before}`, mux, paneId, clientTty)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(before === 0 ? 3000 : 8000) })
    if (!response.ok) return null
    const data: unknown = await response.json()
    if (!isRecord(data) || !Array.isArray(data.lines) || typeof data.cursor !== 'number') return null
    return {
      lines: data.lines.filter((line): line is string => typeof line === 'string'),
      cursor: data.cursor,
      hasMore: data.hasMore === true,
    }
  } catch (error) {
    console.error('[CopyMode] History request failed:', error)
    return null
  }
}
