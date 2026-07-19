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

export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through for browsers that expose Clipboard API but block its use.
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none'
  document.body.appendChild(textarea)
  try {
    textarea.focus()
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
