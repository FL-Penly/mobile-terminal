import type { Terminal } from '@xterm/xterm'
import { copyTextToClipboard } from './dump-file'

interface SelectionOptions {
  enabled: () => boolean
  target: () => string
  onFailure: () => void
  onCopied?: () => void
}

// Observe selection without consuming, replaying, or changing mouse events.
// Window bubble runs after xterm's document mouseup handler, within the user gesture.
export const attachCopyOnSelect = (
  host: HTMLElement,
  term: Pick<Terminal, 'getSelection' | 'onSelectionChange'>,
  options: SelectionOptions,
): (() => void) => {
  let gesture: { target: string; changed: boolean } | null = null
  let disposed = false
  const down = (event: MouseEvent) => {
    if (event.button === 0) gesture = { target: options.target(), changed: false }
  }
  const selection = term.onSelectionChange(() => {
    if (gesture) gesture.changed = true
  })
  const cancel = () => { gesture = null }
  const up = (event: MouseEvent) => {
    if (event.button !== 0) return
    const released = gesture
    gesture = null
    if (!released?.changed || released.target !== options.target() || !options.enabled()) return
    const text = term.getSelection()
    if (!text) return
    void copyTextToClipboard(text).then(ok => {
      if (disposed) return
      if (ok) options.onCopied?.()
      else options.onFailure()
    }).catch(error => {
      console.error('[Terminal] Auto-copy failed:', error)
      if (!disposed) options.onFailure()
    })
  }
  host.addEventListener('mousedown', down, { capture: true })
  window.addEventListener('mouseup', up)
  window.addEventListener('blur', cancel)
  return () => {
    disposed = true
    cancel()
    selection.dispose()
    host.removeEventListener('mousedown', down, { capture: true })
    window.removeEventListener('mouseup', up)
    window.removeEventListener('blur', cancel)
  }
}
