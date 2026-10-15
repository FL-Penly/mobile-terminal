import React, { useEffect, useRef } from 'react'
import { COPY_FORMATS, type CopyFormat } from '../utils/copy-format'

export interface CopySelection {
  label: string
  getText: (format: CopyFormat) => string
  clear: () => void
}

interface CopySheetProps {
  selection: CopySelection
  format: CopyFormat
  onFormatChange: (format: CopyFormat) => void
  onCopy: (text: string) => void
  onInsert: (text: string) => void
  onAsk: (text: string) => void
  askBlockedReason: string | null
  askBusy: boolean
  onHeightChange: (height: number) => void
}

export const CopySheet: React.FC<CopySheetProps> = ({
  selection,
  format,
  onFormatChange,
  onCopy,
  onInsert,
  onAsk,
  askBlockedReason,
  askBusy,
  onHeightChange,
}) => {
  const sheetRef = useRef<HTMLDivElement>(null)
  const text = selection.getText(format)

  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return
    const report = () => onHeightChange(sheet.offsetHeight)
    report()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(sheet)
    return () => {
      observer.disconnect()
      onHeightChange(0)
    }
  }, [onHeightChange])

  return (
    <div
      ref={sheetRef}
      role="region"
      aria-label="复制选中内容"
      className="absolute inset-x-0 bottom-0 z-30 flex flex-col gap-2.5 rounded-t-2xl border-t border-border-subtle bg-bg-secondary px-3.5 pt-2 pb-[calc(12px+env(safe-area-inset-bottom))] shadow-[0_-12px_30px_rgba(0,0,0,0.45)]"
    >
      <div className="mx-auto h-1 w-9 rounded-full bg-border-subtle" />
      <div className="flex items-center justify-between gap-2">
        <b className="text-sm tabular-nums text-text-primary">{selection.label}</b>
        <button
          onClick={selection.clear}
          className="rounded-md border border-border-subtle px-2.5 py-1 text-xs text-text-secondary active:bg-bg-tertiary"
        >
          清除选择
        </button>
      </div>
      <div role="group" aria-label="复制格式" className="flex max-w-full self-start overflow-x-auto no-scrollbar rounded-lg border border-border-subtle bg-bg-tertiary p-0.5">
        {COPY_FORMATS.map(item => (
          <button
            key={item.id}
            aria-pressed={item.id === format}
            onClick={() => onFormatChange(item.id)}
            className={`shrink-0 rounded-md px-2.5 py-1 text-[12.5px] ${
              item.id === format ? 'bg-bg-primary text-text-primary shadow' : 'text-text-secondary'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <pre
        data-testid="copy-preview"
        className="m-0 max-h-32 overflow-auto rounded-lg border border-border-subtle bg-bg-primary px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] text-text-secondary whitespace-pre"
      >
        {text}
      </pre>
      <div className="grid grid-cols-[1.3fr_1fr_1fr] gap-2">
        <button
          onClick={() => onCopy(text)}
          className="rounded-lg bg-accent-blue py-2.5 text-sm font-semibold text-bg-primary active:scale-[0.97]"
        >
          复制
        </button>
        <button
          onClick={() => onInsert(text)}
          className="rounded-lg border border-border-subtle bg-bg-tertiary py-2.5 text-sm text-text-primary active:scale-[0.97]"
        >
          放进输入框
        </button>
        <button
          onClick={() => onAsk(text)}
          aria-disabled={askBlockedReason !== null || askBusy}
          title={askBlockedReason ?? undefined}
          className={`rounded-lg border border-border-subtle bg-bg-tertiary py-2.5 text-sm active:scale-[0.97] ${
            askBlockedReason !== null || askBusy ? 'text-text-muted' : 'text-text-primary'
          }`}
        >
          {askBusy ? '发送中…' : '问 agent'}
        </button>
      </div>
    </div>
  )
}
