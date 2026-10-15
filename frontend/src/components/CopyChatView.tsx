import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CopySelection } from './CopySheet'
import { countLines, formatBlocks } from '../utils/copy-format'
import { isErrorLine } from '../utils/copy-lines'
import { fetchTranscript, type TranscriptBlock, type TranscriptPage } from '../utils/transcript-api'

const COLLAPSED_OUTPUT_LINES = 6

interface CopyChatViewProps {
  active: boolean
  paneId: string
  initialPage: TranscriptPage
  agentStatus: string | undefined
  bottomInset: number
  onSelectionChange: (selection: CopySelection | null) => void
  onCopy: (text: string, what: string) => void
  onShowTerminal: () => void
}

const agentName = (agent: TranscriptPage['agent']) => (agent === 'codex' ? 'CODEX' : 'CLAUDE')

const InlineMarkdown: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(`[^`\n]+`)/g)
  return (
    <>
      {parts.map((part, index) => (
        part.length > 2 && part.startsWith('`') && part.endsWith('`')
          ? <code key={index} className="rounded bg-bg-tertiary px-1 py-px font-mono text-[13px]">{part.slice(1, -1)}</code>
          : <React.Fragment key={index}>{part}</React.Fragment>
      ))}
    </>
  )
}

const CopyButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    onClick={onClick}
    className="shrink-0 rounded-md border border-border-subtle bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary active:scale-95"
  >
    {label}
  </button>
)

interface CardProps {
  block: TranscriptBlock
  agent: TranscriptPage['agent']
  picked: boolean
  expanded: boolean
  onToggle: (id: string) => void
  onToggleExpanded: (id: string) => void
  onCopy: (text: string, what: string) => void
}

const Card = memo(({ block, agent, picked, expanded, onToggle, onToggleExpanded, onCopy }: CardProps) => {
  const handleClick = (event: React.MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('button')) return
    // Selecting text inside a card must not toggle it.
    if (!window.getSelection()?.isCollapsed) return
    onToggle(block.id)
  }
  const pickedStyle = picked ? '!border-accent-blue !bg-tint-blue/10' : ''
  const check = picked && (
    <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-blue text-[11px] font-bold text-bg-primary">✓</span>
  )
  const header = (who: string, extra?: React.ReactNode) => (
    <div className="flex min-h-[22px] items-center gap-2">
      <span className="text-[11.5px] font-semibold tracking-wide text-text-muted">{who}</span>
      <span className="flex-1" />
      {extra}
      {check}
    </div>
  )
  const common = {
    'data-block': block.id,
    'data-picked': picked ? 'true' : undefined,
    onClick: handleClick,
  }

  switch (block.kind) {
    case 'user':
      return (
        <div {...common} className={`ml-8 rounded-xl border border-tint-blue/25 bg-tint-blue/[0.08] px-3 py-2.5 ${pickedStyle}`}>
          {header('你')}
          <div className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-text-primary [overflow-wrap:anywhere]">{block.text}</div>
        </div>
      )
    case 'assistant':
      return (
        <div {...common} className={`rounded-xl border border-transparent px-1 py-1 ${pickedStyle}`}>
          {header(agentName(agent), <CopyButton label="复制" onClick={() => onCopy(block.text, '回复')} />)}
          <div className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-text-primary [overflow-wrap:anywhere]">
            <InlineMarkdown text={block.text} />
          </div>
        </div>
      )
    case 'code':
      return (
        <div {...common} className={`rounded-xl border border-border-subtle bg-bg-secondary px-3 py-2.5 ${pickedStyle}`}>
          {header('代码')}
          <div className="mt-1.5 overflow-hidden rounded-lg border border-border-subtle bg-bg-primary">
            <div className="flex items-center justify-between gap-2 border-b border-border-subtle py-1 pl-2.5 pr-1.5 font-mono text-[11.5px] text-text-muted">
              <span className="min-w-0 truncate">{block.lang || 'text'} · {countLines(block.text)} 行</span>
              <CopyButton label="复制" onClick={() => onCopy(block.text, '代码')} />
            </div>
            <pre className="m-0 overflow-x-auto px-2.5 py-2 font-mono text-xs leading-[1.6] text-text-primary whitespace-pre">{block.text}</pre>
          </div>
        </div>
      )
    case 'command': {
      const outputLines = block.output ? block.output.split('\n') : []
      const collapsible = outputLines.length > COLLAPSED_OUTPUT_LINES
      const shown = collapsible && !expanded ? outputLines.slice(0, COLLAPSED_OUTPUT_LINES) : outputLines
      const status = block.isError
        ? <span className="rounded bg-tint-red/15 px-1.5 py-px text-[11px] text-accent-red">{block.exitCode !== undefined ? `退出码 ${block.exitCode}` : '失败'}</span>
        : null
      return (
        <div {...common} className={`rounded-xl border border-border-subtle bg-bg-secondary px-3 py-2.5 ${pickedStyle}`}>
          {header('命令', status)}
          <div className="mt-1.5 overflow-hidden rounded-lg border border-border-subtle bg-bg-primary">
            <div className="flex items-center justify-between gap-2 border-b border-border-subtle py-1 pl-2.5 pr-1.5 font-mono text-[11.5px] text-text-secondary">
              <span className="min-w-0 truncate">$ {block.command}</span>
              <CopyButton label="复制命令" onClick={() => onCopy(block.command, '命令')} />
            </div>
            {outputLines.length > 0 ? (
              <>
                <pre className="m-0 overflow-x-auto px-2.5 py-2 font-mono text-xs leading-[1.6] text-text-primary whitespace-pre">
                  {shown.map((line, index) => (
                    <React.Fragment key={index}>
                      {isErrorLine(line) ? <span className="text-accent-red">{line}</span> : line}
                      {index < shown.length - 1 ? '\n' : ''}
                    </React.Fragment>
                  ))}
                </pre>
                {collapsible && (
                  <button
                    onClick={() => onToggleExpanded(block.id)}
                    className="block w-full border-t border-border-subtle py-1.5 text-xs text-accent-blue"
                  >
                    {expanded ? '收起' : `展开全部 ${outputLines.length} 行`}
                  </button>
                )}
                <div className="flex items-center justify-between gap-2 border-t border-border-subtle py-1 pl-2.5 pr-1.5 text-[11.5px] text-text-muted">
                  <span>输出</span>
                  <CopyButton label="复制输出" onClick={() => onCopy(block.output, '输出')} />
                </div>
              </>
            ) : (
              <div className="px-2.5 py-1.5 text-xs text-text-muted">没有输出</div>
            )}
          </div>
        </div>
      )
    }
    case 'tool':
      return (
        <div {...common} className={`flex min-w-0 items-center gap-2 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[12.5px] text-text-secondary ${pickedStyle}`}>
          <span className="shrink-0 rounded bg-tint-purple/15 px-1.5 py-px font-mono text-[11px] text-accent-purple">{block.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono">{block.summary}</span>
          {check}
        </div>
      )
  }
})
Card.displayName = 'Card'

export const CopyChatView: React.FC<CopyChatViewProps> = ({
  active,
  paneId,
  initialPage,
  agentStatus,
  bottomInset,
  onSelectionChange,
  onCopy,
  onShowTerminal,
}) => {
  const [page, setPage] = useState(initialPage)
  const [blocks, setBlocks] = useState(initialPage.blocks)
  const [cursor, setCursor] = useState(initialPage.cursor)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const prependedHeightRef = useRef<number | null>(null)
  const stickToBottomRef = useRef(true)

  const status = agentStatus ?? page.agentStatus

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    if (prependedHeightRef.current !== null) {
      scroller.scrollTop += scroller.scrollHeight - prependedHeightRef.current
      prependedHeightRef.current = null
    } else if (stickToBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight
      stickToBottomRef.current = false
    }
  }, [blocks])

  // The hidden view has no layout; jump to the newest block once it is shown.
  useLayoutEffect(() => {
    if (active && stickToBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [active])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    const result = await fetchTranscript(paneId)
    setRefreshing(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    const ids = new Set(result.page.blocks.map(block => block.id))
    setPage(result.page)
    setCursor(result.page.cursor)
    stickToBottomRef.current = true
    setBlocks(result.page.blocks)
    setPicked(previous => new Set([...previous].filter(id => ids.has(id))))
  }, [paneId])

  const loadOlder = useCallback(async () => {
    if (cursor === null || loadingOlder) return
    setLoadingOlder(true)
    const result = await fetchTranscript(paneId, { before: cursor, session: page.session })
    setLoadingOlder(false)
    if (!result.ok) {
      if (result.code === 'session_changed') void refresh()
      else setError(result.message)
      return
    }
    prependedHeightRef.current = scrollRef.current?.scrollHeight ?? null
    setCursor(result.page.cursor)
    setBlocks(previous => [...result.page.blocks, ...previous])
  }, [cursor, loadingOlder, paneId, page.session, refresh])

  const handleScroll = () => {
    const scroller = scrollRef.current
    if (scroller && scroller.scrollTop < 300 && cursor !== null && !loadingOlder) void loadOlder()
  }

  const togglePicked = useCallback((id: string) => {
    setPicked(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleExpanded = useCallback((id: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearPicked = useCallback(() => setPicked(new Set()), [])

  const pickedBlocks = useMemo(() => blocks.filter(block => picked.has(block.id)), [blocks, picked])

  useEffect(() => {
    if (pickedBlocks.length === 0) {
      onSelectionChange(null)
      return
    }
    const lines = pickedBlocks.reduce((sum, block) => sum + countLines(formatBlocks([block], 'raw')), 0)
    onSelectionChange({
      label: `已选 ${pickedBlocks.length} 块 · ${lines} 行`,
      getText: format => formatBlocks(pickedBlocks, format),
      clear: clearPicked,
    })
  }, [pickedBlocks, onSelectionChange, clearPicked])

  return (
    <div className={`${active ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}>
      {status === 'blocked' && (
        <button
          onClick={onShowTerminal}
          className="flex shrink-0 items-center gap-2 border-b border-tint-orange/40 bg-tint-orange/15 px-3 py-2 text-left text-[13px] text-accent-orange"
        >
          <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent-orange" />
          <span className="min-w-0 flex-1"><b>agent 正在等待确认</b> · 会话记录里看不到这个提示，点这里切到终端查看</span>
          <span aria-hidden>›</span>
        </button>
      )}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-xs text-text-muted">
        <span className="min-w-0 flex-1 truncate">点卡片选中，可多选 · {agentName(page.agent)} 会话记录</span>
        <button
          onClick={() => { void refresh() }}
          disabled={refreshing}
          aria-label="刷新会话记录"
          className="shrink-0 rounded-md border border-border-subtle px-2 py-0.5 text-text-secondary disabled:opacity-50"
        >
          {refreshing ? '刷新中…' : '↻ 刷新'}
        </button>
      </div>
      {error && (
        <div role="alert" className="shrink-0 border-b border-tint-red/30 bg-tint-red/10 px-3 py-1.5 text-xs text-accent-red">{error}</div>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="chat-copy-scroll"
        className="min-h-0 flex-1 select-text overflow-y-auto overflow-x-hidden overscroll-contain"
        style={{ paddingBottom: bottomInset }}
      >
        {cursor !== null && (
          <button
            onClick={() => { void loadOlder() }}
            disabled={loadingOlder}
            className="w-full py-2 text-xs text-accent-blue disabled:opacity-60"
          >
            {loadingOlder ? '加载中…' : '▲ 加载更早的对话'}
          </button>
        )}
        {blocks.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-text-muted">会话记录里还没有内容</div>
        ) : (
          <div className="flex flex-col gap-2.5 px-3 pb-6 pt-2">
            {blocks.map(block => (
              <Card
                key={block.id}
                block={block}
                agent={page.agent}
                picked={picked.has(block.id)}
                expanded={expanded.has(block.id)}
                onToggle={togglePicked}
                onToggleExpanded={toggleExpanded}
                onCopy={onCopy}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
