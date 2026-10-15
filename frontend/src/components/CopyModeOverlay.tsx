import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { useServerEvents } from '../contexts/ServerEventsContext'
import { ClipboardFallback } from './ClipboardFallback'
import { CopyChatView } from './CopyChatView'
import { CopySheet, type CopySelection } from './CopySheet'
import { CopyTerminalView } from './CopyTerminalView'
import { askAgentPrompt, countLines, quoteForInput, type CopyFormat } from '../utils/copy-format'
import { copyTextToClipboard } from '../utils/dump-file'
import { fetchHistory, fetchTranscript, type TranscriptPage } from '../utils/transcript-api'

interface CopyModeOverlayProps {
  lines: string[]
  initialScrollLine: number
  onClose: () => void
}

type CopyView = 'chat' | 'terminal'

type ChatState =
  | { status: 'loading' }
  | { status: 'ready'; page: TranscriptPage }
  | { status: 'unavailable'; reason: string }

interface Toast {
  id: number
  message: string
  tone: 'ok' | 'warn'
}

export const INSERT_TEXT_EVENT = 'terminal-insert-text'

const TMUX_CHAT_REASON = '对话视图需要 herdr pane：只有 herdr 能告诉我们 pane 里跑的是哪个 agent'

export const CopyModeOverlay: React.FC<CopyModeOverlayProps> = ({ lines, initialScrollLine, onClose }) => {
  const { mux, paneId, clientTty, submitText } = useTerminal()
  const { tmuxSessions, projectGroups, otherSessions, tuiActive } = useServerEvents()
  const herdrPane = mux === 'herdr' && paneId ? paneId : null

  const paneCommand = useMemo(() => {
    if (!herdrPane) return null
    const sessions = [...projectGroups.flatMap(group => group.sessions), ...otherSessions]
    return sessions.find(session => session.name === herdrPane)?.command ?? null
  }, [herdrPane, projectGroups, otherSessions])
  const agentStatus = herdrPane ? tmuxSessions.find(session => session.name === herdrPane)?.agentStatus : undefined
  const paneRunsAgent = herdrPane ? Boolean(paneCommand && paneCommand !== 'shell') : tuiActive

  const [view, setView] = useState<CopyView>(() => (herdrPane && paneRunsAgent ? 'chat' : 'terminal'))
  const [chat, setChat] = useState<ChatState>(() => (
    herdrPane ? { status: 'loading' } : { status: 'unavailable', reason: TMUX_CHAT_REASON }
  ))
  const [selections, setSelections] = useState<Record<CopyView, CopySelection | null>>({ chat: null, terminal: null })
  const [format, setFormat] = useState<CopyFormat>('raw')
  const [sheetHeight, setSheetHeight] = useState(0)
  const [toast, setToast] = useState<Toast | null>(null)
  const [fallbackText, setFallbackText] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [focusSearchSignal, setFocusSearchSignal] = useState(0)
  const toastTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const showToast = useCallback((message: string, tone: Toast['tone'] = 'ok') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    setToast({ id: Date.now(), message, tone })
    toastTimerRef.current = window.setTimeout(() => setToast(null), tone === 'ok' ? 1600 : 2600)
  }, [])

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
  }, [])

  useEffect(() => {
    if (!herdrPane) return
    let cancelled = false
    void fetchTranscript(herdrPane).then(result => {
      if (cancelled) return
      if (result.ok) {
        setChat({ status: 'ready', page: result.page })
        return
      }
      setChat({ status: 'unavailable', reason: result.message })
      setView('terminal')
    })
    return () => { cancelled = true }
  }, [herdrPane])

  const loadHistory = useCallback(
    (before: number) => fetchHistory(mux, paneId, clientTty, before),
    [mux, paneId, clientTty],
  )

  const setTerminalSelection = useCallback((selection: CopySelection | null) => {
    setSelections(previous => ({ ...previous, terminal: selection }))
  }, [])
  const setChatSelection = useCallback((selection: CopySelection | null) => {
    setSelections(previous => ({ ...previous, chat: selection }))
  }, [])

  const copy = useCallback(async (text: string, what = '') => {
    const copied = await copyTextToClipboard(text)
    if (!copied) {
      setFallbackText(text)
      return
    }
    try { navigator.vibrate?.(12) } catch { /* unsupported */ }
    showToast(`已复制${what} · ${countLines(text)} 行`)
  }, [showToast])

  const insertIntoInput = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent(INSERT_TEXT_EVENT, { detail: { text: quoteForInput(text) } }))
    onClose()
  }, [onClose])

  const askBlockedReason = agentStatus === 'blocked'
    ? 'agent 正在等待确认，先在终端里处理'
    : !paneRunsAgent ? '当前 pane 没有运行 agent，不会把内容当命令发出去' : null

  const askAgent = useCallback(async (text: string) => {
    if (askBlockedReason) {
      showToast(askBlockedReason, 'warn')
      return
    }
    if (asking) return
    setAsking(true)
    const result = await submitText(askAgentPrompt(text), { submit: true })
    setAsking(false)
    if (!result.ok) {
      showToast(result.message ?? '发送失败，请重试', 'warn')
      return
    }
    showToast('已发给 agent')
    closeTimerRef.current = window.setTimeout(onClose, 700)
  }, [askBlockedReason, asking, submitText, showToast, onClose])

  const switchView = (next: CopyView) => {
    if (next === 'chat' && chat.status === 'unavailable') {
      showToast(chat.reason, 'warn')
      return
    }
    setView(next)
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (fallbackText !== null) setFallbackText(null)
        else onClose()
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        event.preventDefault()
        setView('terminal')
        setFocusSearchSignal(signal => signal + 1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, fallbackText])

  const activeSelection = selections[view]
  const chatDisabled = chat.status === 'unavailable'

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col bg-bg-primary pt-[env(safe-area-inset-top)] animate-in fade-in">
      <div className="flex min-h-12 shrink-0 items-center gap-2.5 border-b border-border-subtle px-3 py-2">
        <span className="text-base font-semibold text-text-primary">复制</span>
        <span className="min-w-0 flex-1" />
        <div role="group" aria-label="视图" className="flex rounded-lg border border-border-subtle bg-bg-tertiary p-0.5">
          <button
            aria-pressed={view === 'chat'}
            aria-disabled={chatDisabled}
            title={chatDisabled ? chat.reason : undefined}
            onClick={() => switchView('chat')}
            className={`rounded-md px-3 py-1 text-[13px] ${
              view === 'chat' ? 'bg-bg-primary text-text-primary shadow' : chatDisabled ? 'text-text-muted line-through' : 'text-text-secondary'
            }`}
          >
            对话
          </button>
          <button
            aria-pressed={view === 'terminal'}
            onClick={() => switchView('terminal')}
            className={`rounded-md px-3 py-1 text-[13px] ${view === 'terminal' ? 'bg-bg-primary text-text-primary shadow' : 'text-text-secondary'}`}
          >
            终端
          </button>
        </div>
        <button
          onClick={onClose}
          aria-label="关闭复制界面"
          className="h-8 min-w-[32px] rounded-lg border border-border-subtle bg-bg-tertiary text-sm text-text-secondary active:scale-95"
        >
          ✕
        </button>
      </div>

      {view === 'terminal' && chatDisabled && herdrPane && (
        <div className="shrink-0 truncate border-b border-border-subtle px-3 py-1 text-[11.5px] text-text-muted">
          对话视图不可用：{chat.reason}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        {view === 'chat' && chat.status === 'loading' && (
          <div className="flex flex-1 items-center justify-center text-sm text-text-muted">正在读取会话记录…</div>
        )}
        {chat.status === 'ready' && herdrPane && (
          <CopyChatView
            active={view === 'chat'}
            paneId={herdrPane}
            initialPage={chat.page}
            agentStatus={agentStatus}
            bottomInset={view === 'chat' ? sheetHeight : 0}
            onSelectionChange={setChatSelection}
            onCopy={(text, what) => { void copy(text, what) }}
            onShowTerminal={() => setView('terminal')}
          />
        )}
        <CopyTerminalView
          active={view === 'terminal'}
          initialLines={lines}
          initialScrollLine={initialScrollLine}
          loadHistory={loadHistory}
          bottomInset={view === 'terminal' ? sheetHeight : 0}
          focusSearchSignal={focusSearchSignal}
          onSelectionChange={setTerminalSelection}
        />

        {activeSelection && (
          <CopySheet
            selection={activeSelection}
            format={format}
            onFormatChange={setFormat}
            onCopy={text => { void copy(text) }}
            onInsert={insertIntoInput}
            onAsk={text => { void askAgent(text) }}
            askBlockedReason={askBlockedReason}
            askBusy={asking}
            onHeightChange={setSheetHeight}
          />
        )}

        {toast && (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-none absolute left-1/2 top-3 z-40 max-w-[calc(100%-32px)] -translate-x-1/2 rounded-full border bg-tint-surface/95 px-3.5 py-1.5 text-center text-[13px] shadow-lg ${
              toast.tone === 'ok' ? 'border-tint-green/50 text-text-primary' : 'border-tint-orange/60 text-accent-orange'
            }`}
          >
            {toast.tone === 'ok' && <span className="mr-1 font-bold text-accent-green">✓</span>}
            {toast.message}
          </div>
        )}

        {fallbackText !== null && (
          <ClipboardFallback text={fallbackText} onClose={() => setFallbackText(null)} />
        )}
      </div>
    </div>
  )
}
