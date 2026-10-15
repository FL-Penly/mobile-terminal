const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

export const dumpTextToFile = async (text: string): Promise<string> => {
  const response = await fetch('/api/dump-file', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: text,
    signal: AbortSignal.timeout(3000),
  })

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error(response.ok ? '落盘接口返回了无效响应' : '落盘失败')
  }

  if (!response.ok) {
    const message = isRecord(data) && typeof data.message === 'string' ? data.message : '落盘失败'
    throw new Error(message)
  }
  if (!isRecord(data) || typeof data.path !== 'string' || !data.path) {
    throw new Error('落盘接口未返回文件路径')
  }
  return data.path
}

// The legacy path runs synchronously so it still counts as part of the user's tap
// when the Clipboard API is missing, as it is on plain-HTTP pages.
const copyWithTextarea = (text: string): boolean => {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;font-size:16px'
  document.body.appendChild(textarea)
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    // iOS Safari ignores select() on a textarea; an explicit range is required.
    textarea.setSelectionRange(0, text.length)
    return document.execCommand('copy') === true
  } catch {
    return false
  } finally {
    textarea.remove()
    activeElement?.focus({ preventScroll: true })
  }
}

export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or document not focused: try the legacy path below.
    }
  }
  return copyWithTextarea(text)
}
