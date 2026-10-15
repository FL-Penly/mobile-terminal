import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CopySelection } from './CopySheet'
import { isCommandLine, isErrorLine, trimTrailingBlankLines } from '../utils/copy-lines'
import { formatTerminalText } from '../utils/copy-format'
import {
  beginDrag,
  beginHandleDrag,
  dragTo,
  edgeScrollSpeed,
  rangeSize,
  shiftSelection,
  toRange,
  type LineSelection,
  type SelectionHandle,
} from '../utils/line-selection'
import type { HistoryPage } from '../utils/transcript-api'

interface CopyTerminalViewProps {
  active: boolean
  initialLines: string[]
  initialScrollLine: number
  loadHistory: ((before: number) => Promise<HistoryPage | null>) | null
  bottomInset: number
  focusSearchSignal: number
  onSelectionChange: (selection: CopySelection | null) => void
}

interface DragState {
  pointerId: number
  gutterX: number
  lastY: number
  frame: number
}

const highlight = (text: string, query: string): React.ReactNode => {
  if (!query || !text) return text || ' '
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let last = 0
  let pos = lower.indexOf(needle)
  while (pos !== -1) {
    if (pos > last) parts.push(text.slice(last, pos))
    parts.push(<mark key={pos} className="rounded-sm bg-tint-orange/50 px-px text-white">{text.slice(pos, pos + needle.length)}</mark>)
    last = pos + needle.length
    pos = lower.indexOf(needle, last)
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

interface RowProps {
  index: number
  text: string
  selected: boolean
  isStart: boolean
  isEnd: boolean
  hit: 'current' | 'other' | null
  query: string
}

const Row = memo(({ index, text, selected, isStart, isEnd, hit, query }: RowProps) => {
  const tone = isErrorLine(text)
    ? 'text-accent-red'
    : isCommandLine(text) ? 'text-text-primary' : 'text-text-secondary'
  const background = selected
    ? 'bg-tint-blue/15'
    : hit === 'current' ? 'bg-tint-orange/20' : hit === 'other' ? 'bg-tint-orange/10' : ''
  return (
    <div data-row={index} className="grid grid-cols-[44px_minmax(0,1fr)]">
      <div
        data-gutter
        className={`relative cursor-ns-resize touch-none select-none border-r border-border-subtle pr-2 pt-[2px] text-right font-mono text-[10.5px] leading-[1.6] tabular-nums ${
          selected ? 'bg-tint-blue/30 text-text-primary' : 'bg-bg-secondary text-text-muted'
        }`}
      >
        {index + 1}
        {isStart && (
          <span
            data-handle="start"
            aria-label="拖动调整起点"
            className="absolute -top-2 left-1.5 z-[2] h-4 w-4 touch-none rounded-full border-2 border-bg-primary bg-accent-blue after:absolute after:-inset-3 after:content-[''] group-data-[dragging]/copy:pointer-events-none"
          />
        )}
        {isEnd && (
          <span
            data-handle="end"
            aria-label="拖动调整终点"
            className="absolute -bottom-2 left-1.5 z-[2] h-4 w-4 touch-none rounded-full border-2 border-bg-primary bg-accent-blue after:absolute after:-inset-3 after:content-[''] group-data-[dragging]/copy:pointer-events-none"
          />
        )}
      </div>
      <div
        className={`min-h-[1.6em] whitespace-pre-wrap py-px pl-[calc(10px+2ch)] pr-3 font-mono text-[12.5px] leading-[1.6] [overflow-wrap:anywhere] [text-indent:-2ch] ${tone} ${background}`}
      >
        {highlight(text, query)}
      </div>
    </div>
  )
})
Row.displayName = 'Row'

export const CopyTerminalView: React.FC<CopyTerminalViewProps> = ({
  active,
  initialLines,
  initialScrollLine,
  loadHistory,
  bottomInset,
  focusSearchSignal,
  onSelectionChange,
}) => {
  const [lines, setLines] = useState(() => trimTrailingBlankLines(initialLines))
  const [cursor, setCursor] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [selection, setSelection] = useState<LineSelection | null>(null)
  const [dragging, setDragging] = useState<'fresh' | 'handle' | null>(null)
  const [search, setSearch] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const selectionRef = useRef(selection)
  const linesRef = useRef(lines)
  const bottomInsetRef = useRef(bottomInset)
  const prependedHeightRef = useRef<number | null>(null)
  const scrollTargetRef = useRef<number | 'bottom' | null>(initialScrollLine > 0 ? initialScrollLine : 'bottom')

  selectionRef.current = selection
  linesRef.current = lines
  bottomInsetRef.current = bottomInset

  const range = selection ? toRange(selection) : null
  const query = search.trim()

  const searchHits = useMemo(() => {
    if (!query) return []
    const needle = query.toLowerCase()
    const hits: number[] = []
    lines.forEach((line, index) => { if (line.toLowerCase().includes(needle)) hits.push(index) })
    return hits
  }, [lines, query])
  const hitSet = useMemo(() => new Set(searchHits), [searchHits])

  const scrollRowIntoView = useCallback((index: number, block: ScrollLogicalPosition) => {
    const row = scrollRef.current?.querySelector(`[data-row="${index}"]`)
    row?.scrollIntoView({ block })
  }, [])

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    if (prependedHeightRef.current !== null) {
      scroller.scrollTop += scroller.scrollHeight - prependedHeightRef.current
      prependedHeightRef.current = null
      return
    }
    const target = scrollTargetRef.current
    // A hidden view has no layout yet; keep the target until it is shown.
    if (target === null || !active) return
    scrollTargetRef.current = null
    if (target === 'bottom' || target >= lines.length) scroller.scrollTop = scroller.scrollHeight
    else scrollRowIntoView(target, 'start')
  }, [lines, active, scrollRowIntoView])

  useEffect(() => {
    if (!loadHistory) return
    let cancelled = false
    void loadHistory(0).then(page => {
      if (cancelled || !page) return
      setCursor(page.cursor)
      setHasMore(page.hasMore)
      const serverLines = trimTrailingBlankLines(page.lines)
      // Server lines are unwrapped at the source, so prefer them unless the user already started selecting.
      if (serverLines.length === 0 || selectionRef.current) return
      scrollTargetRef.current = 'bottom'
      setLines(serverLines)
    })
    return () => { cancelled = true }
  }, [loadHistory])

  const loadOlder = useCallback(async () => {
    if (!loadHistory || cursor === null || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await loadHistory(cursor)
      if (!page) return
      setCursor(page.cursor)
      setHasMore(page.hasMore && page.cursor > cursor)
      if (page.lines.length === 0) return
      prependedHeightRef.current = scrollRef.current?.scrollHeight ?? null
      setSelection(previous => (previous ? shiftSelection(previous, page.lines.length) : previous))
      setLines(previous => [...page.lines, ...previous])
    } finally {
      setLoadingOlder(false)
    }
  }, [loadHistory, cursor, loadingOlder])

  const clearSelection = useCallback(() => setSelection(null), [])

  useEffect(() => {
    if (!selection || dragging === 'fresh') {
      onSelectionChange(null)
      return
    }
    const { from, to } = toRange(selection)
    const picked = lines.slice(from, to + 1)
    onSelectionChange({
      label: `已选 ${rangeSize({ from, to })} 行`,
      getText: format => formatTerminalText(picked, format),
      clear: clearSelection,
    })
  }, [selection, dragging, lines, onSelectionChange, clearSelection])

  const indexAtY = useCallback((y: number): number | null => {
    const scroller = scrollRef.current
    const drag = dragRef.current
    if (!scroller || !drag) return null
    const rect = scroller.getBoundingClientRect()
    const visibleBottom = rect.bottom - bottomInsetRef.current
    const clampedY = Math.max(rect.top + 2, Math.min(visibleBottom - 2, y))
    const row = document.elementFromPoint(drag.gutterX, clampedY)?.closest('[data-row]')
    return row instanceof HTMLElement ? Number(row.dataset.row) : null
  }, [])

  const updateFocus = useCallback((y: number) => {
    const index = indexAtY(y)
    if (index === null) return
    setSelection(previous => (previous ? dragTo(previous, index, linesRef.current.length) : previous))
  }, [indexAtY])

  const stepAutoScroll = useCallback(() => {
    const drag = dragRef.current
    const scroller = scrollRef.current
    if (!drag || !scroller) return
    const rect = scroller.getBoundingClientRect()
    const speed = edgeScrollSpeed(drag.lastY, rect.top, rect.bottom - bottomInsetRef.current)
    if (speed !== 0) {
      scroller.scrollTop += speed
      updateFocus(drag.lastY)
    }
    drag.frame = requestAnimationFrame(stepAutoScroll)
  }, [updateFocus])

  const endDrag = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    cancelAnimationFrame(drag.frame)
    dragRef.current = null
    setDragging(null)
    try { navigator.vibrate?.(8) } catch { /* unsupported */ }
  }, [])

  useEffect(() => () => {
    if (dragRef.current) cancelAnimationFrame(dragRef.current.frame)
  }, [])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return
    const gutter = event.target.closest('[data-gutter]')
    const row = gutter?.closest('[data-row]')
    if (!(gutter instanceof HTMLElement) || !(row instanceof HTMLElement)) return
    event.preventDefault()
    const handle = event.target.closest('[data-handle]')?.getAttribute('data-handle') as SelectionHandle | null
    const current = selectionRef.current
    const fresh = !(handle && current)
    setSelection(fresh ? beginDrag(Number(row.dataset.row), lines.length) : beginHandleDrag(toRange(current), handle))
    const rect = gutter.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      gutterX: rect.left + rect.width / 2,
      lastY: event.clientY,
      frame: requestAnimationFrame(stepAutoScroll),
    }
    setDragging(fresh ? 'fresh' : 'handle')
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* not supported */ }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    drag.lastY = event.clientY
    updateFocus(event.clientY)
  }

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) endDrag()
  }

  const handleScroll = () => {
    const scroller = scrollRef.current
    if (scroller && scroller.scrollTop < 120 && hasMore && !loadingOlder && !dragRef.current) void loadOlder()
  }

  const goToHit = useCallback((direction: 1 | -1) => {
    if (searchHits.length === 0) return
    const next = (searchIndex + direction + searchHits.length) % searchHits.length
    setSearchIndex(next)
    scrollRowIntoView(searchHits[next], 'center')
  }, [searchHits, searchIndex, scrollRowIntoView])

  // Start from the newest match; it is usually the one being looked for.
  useEffect(() => {
    const newest = searchHits.length - 1
    setSearchIndex(Math.max(0, newest))
    if (newest >= 0) scrollRowIntoView(searchHits[newest], 'center')
  }, [searchHits, scrollRowIntoView])

  useEffect(() => {
    if (focusSearchSignal > 0) searchRef.current?.focus()
  }, [focusSearchSignal])

  const currentHit = searchHits[searchIndex]

  return (
    <div className={`${active ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5">
        <div className="relative min-w-0 flex-1">
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); goToHit(event.shiftKey ? 1 : -1) }
            }}
            placeholder="搜索终端内容…"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            className="w-full rounded-lg border border-border-subtle bg-bg-tertiary py-1.5 pl-3 pr-24 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-blue"
          />
          {query && (
            <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
              <span className="mr-1 text-xs tabular-nums text-text-muted">
                {searchHits.length > 0 ? `${searchIndex + 1}/${searchHits.length}` : '0'}
              </span>
              <button aria-label="上一个" onClick={() => goToHit(-1)} className="px-1.5 py-0.5 text-xs text-text-muted active:text-text-primary">▲</button>
              <button aria-label="下一个" onClick={() => goToHit(1)} className="px-1.5 py-0.5 text-xs text-text-muted active:text-text-primary">▼</button>
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-xs text-text-muted">
        <span className="h-[18px] w-3.5 shrink-0 rounded-sm bg-tint-blue/30" />
        {range ? '拖两端的蓝点可以微调范围' : '按住左侧行号栏上下拖动选择，拖到边缘会自动滚动'}
      </div>
      <div
        ref={scrollRef}
        data-testid="terminal-copy-scroll"
        // Handles reach into neighbouring rows; while dragging, hit-testing must see the rows.
        data-dragging={dragging ? '' : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
        onScroll={handleScroll}
        className="group/copy min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
        style={{ paddingBottom: bottomInset }}
      >
        {hasMore && (
          <button
            onClick={() => { void loadOlder() }}
            disabled={loadingOlder}
            className="w-full border-b border-tint-blue/20 bg-tint-blue/10 py-2 text-xs text-accent-blue disabled:opacity-60"
          >
            {loadingOlder ? '加载中…' : '▲ 往前翻页'}
          </button>
        )}
        {lines.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-text-muted">终端里还没有内容</div>
        ) : (
          <div className="py-1">
            {lines.map((line, index) => (
              <Row
                key={index}
                index={index}
                text={line}
                selected={range !== null && index >= range.from && index <= range.to}
                isStart={range?.from === index}
                isEnd={range?.to === index}
                hit={hitSet.has(index) ? (index === currentHit ? 'current' : 'other') : null}
                query={query}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
