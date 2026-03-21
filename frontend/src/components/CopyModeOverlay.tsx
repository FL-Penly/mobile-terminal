import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'

interface CopyModeOverlayProps {
  lines: string[]
  initialScrollLine: number
  onClose: () => void
  onFetchMore?: (page: number) => Promise<string[] | null>
}

// Matches $ > % ❯ ➜ # λ → prompt chars, or user@host:path patterns
const PROMPT_RE = /^\s*[\]$>%❯➜#λ→]\s|^\S+@\S+[:%#$]|\$\s*$/

const fallbackCopy = (text: string) => {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  try { document.execCommand('copy') } catch { /* noop */ }
  document.body.removeChild(ta)
}

// leading-5 = 1.25rem = 20px at default font size
const LINE_HEIGHT = 20

function findOverlap(upper: string[], lower: string[]): number {
  const maxCheck = Math.min(upper.length, lower.length)
  for (let overlap = maxCheck; overlap >= 2; overlap--) {
    let match = true
    for (let i = 0; i < overlap; i++) {
      if (upper[upper.length - overlap + i] !== lower[i]) { match = false; break }
    }
    if (match) return overlap
  }
  return 0
}

export const CopyModeOverlay: React.FC<CopyModeOverlayProps> = ({ lines: initialLines, initialScrollLine, onClose, onFetchMore }) => {
  const [allLines, setAllLines] = useState(initialLines)
  const [fetching, setFetching] = useState(false)
  const [noMore, setNoMore] = useState(false)
  const pageRef = useRef(1)
  const [selStart, setSelStart] = useState<number | null>(null)
  const [selEnd, setSelEnd] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [searchNavIdx, setSearchNavIdx] = useState(0)
  const [showCopied, setShowCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const copiedTimer = useRef<number | null>(null)
  const lineEls = useRef<(HTMLDivElement | null)[]>([])
  const searchInputRef = useRef<HTMLInputElement>(null)

  const commandLines = useMemo(() => {
    const set = new Set<number>()
    for (let i = 0; i < allLines.length; i++) {
      if (PROMPT_RE.test(allLines[i])) set.add(i)
    }
    return set
  }, [allLines])

  const findNextCommand = useCallback((from: number): number => {
    for (let i = from + 1; i < allLines.length; i++) {
      if (commandLines.has(i)) return i
    }
    return allLines.length
  }, [allLines.length, commandLines])

  const selRange = useMemo(() => {
    if (selStart === null || selEnd === null) return null
    return {
      from: Math.min(selStart, selEnd),
      to: Math.max(selStart, selEnd),
    }
  }, [selStart, selEnd])

  const selectedCount = selRange ? selRange.to - selRange.from + 1 : 0

  const searchResults = useMemo(() => {
    if (!search.trim()) return { hits: new Set<number>(), indices: [] as number[] }
    const lower = search.toLowerCase()
    const hits = new Set<number>()
    const indices: number[] = []
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i].toLowerCase().includes(lower)) {
        hits.add(i)
        indices.push(i)
      }
    }
    return { hits, indices }
  }, [allLines, search])

  const handleLineTap = useCallback((idx: number) => {
    const isCmd = commandLines.has(idx)

    if (selStart === null || selRange !== null) {
      if (isCmd) {
        const nextCmd = findNextCommand(idx)
        setSelStart(idx)
        setSelEnd(nextCmd - 1)
      } else {
        setSelStart(idx)
        setSelEnd(null)
      }
    } else {
      setSelEnd(idx)
    }
  }, [selStart, selRange, commandLines, findNextCommand])

  const handleFetchMore = useCallback(async () => {
    if (!onFetchMore || fetching || noMore) return
    setFetching(true)
    try {
      const newLines = await onFetchMore(pageRef.current)
      if (!newLines || newLines.length === 0) {
        setNoMore(true)
        return
      }
      pageRef.current++
      setAllLines(prev => {
        const overlap = findOverlap(newLines, prev)
        if (overlap > 0) return [...newLines.slice(0, newLines.length - overlap), ...prev]
        return [...newLines, ...prev]
      })
      requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0) })
    } finally {
      setFetching(false)
    }
  }, [onFetchMore, fetching, noMore])

  const getTextToCopy = useCallback(() => {
    if (selRange) {
      return allLines.slice(selRange.from, selRange.to + 1).join('\n')
    }
    return allLines.join('\n')
  }, [allLines, selRange])

  const handleCopy = useCallback(() => {
    const text = getTextToCopy()
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text)
    } else {
      fallbackCopy(text)
    }
    setShowCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setShowCopied(false), 1500)
  }, [getTextToCopy])

  const handleClearSelection = useCallback(() => {
    setSelStart(null)
    setSelEnd(null)
  }, [])

  const navigateSearch = useCallback((dir: 1 | -1) => {
    const { indices } = searchResults
    if (indices.length === 0) return
    const next = (searchNavIdx + dir + indices.length) % indices.length
    setSearchNavIdx(next)
    const el = lineEls.current[indices[next]]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [searchResults, searchNavIdx])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || initialScrollLine <= 0) return
    requestAnimationFrame(() => {
      el.scrollTop = initialScrollLine * LINE_HEIGHT
    })
  }, [initialScrollLine])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); searchInputRef.current?.focus() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    return () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }
  }, [])

  useEffect(() => {
    setSearchNavIdx(0)
    if (searchResults.indices.length > 0) {
      const el = lineEls.current[searchResults.indices[0]]
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [searchResults.indices])

  const highlightSearch = (text: string): React.ReactNode => {
    if (!search.trim() || !text) return text || '\u00A0'
    const lower = text.toLowerCase()
    const sLower = search.toLowerCase()
    const parts: React.ReactNode[] = []
    let last = 0
    let pos = lower.indexOf(sLower)
    let key = 0
    while (pos !== -1) {
      if (pos > last) parts.push(text.slice(last, pos))
      parts.push(
        <span key={key++} className="bg-accent-orange/50 text-white rounded-sm px-px">{text.slice(pos, pos + search.length)}</span>
      )
      last = pos + search.length
      pos = lower.indexOf(sLower, last)
    }
    if (last < text.length) parts.push(text.slice(last))
    return parts.length > 0 ? <>{parts}</> : (text || '\u00A0')
  }

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col bg-bg-primary animate-in fade-in">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="flex-1 relative">
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); navigateSearch(e.shiftKey ? -1 : 1) }
            }}
            placeholder="Search..."
            className="w-full bg-bg-tertiary text-text-primary text-sm rounded-lg pl-3 pr-20 py-1.5 border border-border-subtle outline-none focus:border-accent-blue placeholder:text-text-muted"
          />
          {search && (
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
              <span className="text-xs text-text-muted mr-0.5">
                {searchResults.indices.length > 0 ? `${searchNavIdx + 1}/${searchResults.indices.length}` : '0'}
              </span>
              <button onClick={() => navigateSearch(-1)} className="text-text-muted active:text-text-primary p-0.5 text-xs">▲</button>
              <button onClick={() => navigateSearch(1)} className="text-text-muted active:text-text-primary p-0.5 text-xs">▼</button>
            </div>
          )}
        </div>
        <button
          onClick={handleCopy}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-accent-blue text-white active:scale-95 transition-transform shrink-0"
        >
          {selRange ? `Copy (${selectedCount})` : 'Copy All'}
        </button>
        <button
          onClick={onClose}
          className="min-w-[32px] py-1.5 rounded-lg text-sm bg-bg-tertiary text-text-secondary border border-border-subtle active:scale-95 transition-transform"
        >
          ✕
        </button>
      </div>

      {selRange && (
        <div className="flex items-center justify-between px-3 py-1 bg-accent-blue/10 border-b border-accent-blue/30 shrink-0">
          <span className="text-xs text-accent-blue">
            {selectedCount} line{selectedCount !== 1 ? 's' : ''} selected
          </span>
          <button onClick={handleClearSelection} className="text-xs text-text-muted active:text-text-primary">
            Clear
          </button>
        </div>
      )}

      {!selRange && !search && (
        <div className="px-3 py-1 border-b border-border-subtle shrink-0">
          <span className="text-xs text-text-muted">
            Tap a line to start selecting · Tap a{' '}
            <span className="text-accent-purple">command</span> to select its block
          </span>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-auto overscroll-contain">
        {onFetchMore && !noMore && (
          <button
            onClick={handleFetchMore}
            disabled={fetching}
            className="w-full py-2 text-xs text-accent-blue bg-accent-blue/10 border-b border-accent-blue/20 active:bg-accent-blue/20 disabled:opacity-50 shrink-0"
          >
            {fetching ? 'Loading...' : '▲ Fetch previous page'}
          </button>
        )}
        {allLines.map((line, i) => {
          const isCmd = commandLines.has(i)
          const inSel = selRange !== null && i >= selRange.from && i <= selRange.to
          const isAnchor = i === selStart || i === selEnd
          const isSearchHit = searchResults.hits.has(i)
          const isCurrentSearchHit = searchResults.indices[searchNavIdx] === i

          return (
            <div
              key={i}
              ref={el => { lineEls.current[i] = el }}
              onClick={() => handleLineTap(i)}
              className={[
                'px-3 font-mono text-xs leading-5 border-l-2 select-none cursor-pointer whitespace-nowrap',
                inSel
                  ? isAnchor
                    ? 'bg-accent-blue/25 border-l-accent-blue text-text-primary'
                    : 'bg-accent-blue/15 border-l-accent-blue/60 text-text-primary'
                  : isCurrentSearchHit
                    ? 'bg-accent-orange/20 border-l-accent-orange text-text-primary'
                    : isSearchHit
                      ? 'bg-accent-orange/10 border-l-accent-orange/40 text-text-primary'
                      : isCmd
                        ? 'border-l-accent-purple/50 text-text-primary'
                        : 'border-l-transparent text-text-secondary',
                'active:bg-accent-blue/20',
              ].join(' ')}
            >
              {highlightSearch(line)}
            </div>
          )
        })}
      </div>

      {showCopied && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-accent-green/80 backdrop-blur-sm border border-accent-green/50 text-white text-sm font-mono pointer-events-none select-none z-10">
          Copied!
        </div>
      )}
    </div>
  )
}
