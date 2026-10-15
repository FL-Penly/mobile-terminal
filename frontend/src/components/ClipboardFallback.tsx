import React, { useEffect, useRef } from 'react'

interface ClipboardFallbackProps {
  text: string
  onClose: () => void
}

export const ClipboardFallback: React.FC<ClipboardFallbackProps> = ({ text, onClose }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(0, textarea.value.length)
  }, [text])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="手动复制"
      className="absolute inset-0 z-50 flex flex-col justify-end bg-black/60"
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="flex flex-col gap-2.5 rounded-t-2xl border-t border-border-subtle bg-bg-secondary px-3.5 pt-3 pb-[calc(14px+env(safe-area-inset-bottom))]">
        <div className="text-sm font-semibold text-accent-orange">自动复制失败</div>
        <div className="text-xs leading-relaxed text-text-secondary">
          浏览器没有允许写入剪贴板（通过 http 访问时常见）。下面的内容已经全选，长按选区选择「拷贝」即可。
        </div>
        <textarea
          ref={textareaRef}
          readOnly
          value={text}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={event => event.currentTarget.setSelectionRange(0, event.currentTarget.value.length)}
          className="h-44 w-full resize-none rounded-lg border border-border-subtle bg-bg-primary p-2.5 font-mono text-[13px] leading-normal text-text-primary"
        />
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg border border-border-subtle bg-bg-tertiary px-4 py-2 text-sm text-text-primary"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
