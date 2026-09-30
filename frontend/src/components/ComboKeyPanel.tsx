import { useCallback, useEffect, useRef, useState } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { useKeyModifiers } from '../hooks/useKeyModifiers'

interface Props { onClose: () => void }
interface PanelKey { key: string; label: string; repeat?: boolean }
const navigationKeys: PanelKey[] = [
  { key: 'Escape', label: 'Esc' }, { key: 'Tab', label: 'Tab' },
  { key: 'Enter', label: 'Enter' }, { key: 'Backspace', label: '⌫', repeat: true },
  { key: 'ArrowLeft', label: '←', repeat: true }, { key: 'ArrowDown', label: '↓', repeat: true },
  { key: 'ArrowUp', label: '↑', repeat: true }, { key: 'ArrowRight', label: '→', repeat: true },
]
const extendedKeys: PanelKey[] = [
  ...['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].map(key => ({ key, label: key.replace('Page', 'Pg') })),
  ...Array.from({ length: 12 }, (_, i) => ({ key: `F${i + 1}`, label: `F${i + 1}` })),
]
const modifierKeys = [
  { key: 'ctrl', label: 'Ctrl' }, { key: 'alt', label: 'Alt' }, { key: 'shift', label: 'Shift' },
] as const
const keyClass = 'min-h-[40px] min-w-0 rounded-lg border px-1 text-sm font-mono select-none active:bg-accent-blue/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-blue disabled:opacity-40'
const idleKeyClass = 'border-border-subtle bg-bg-tertiary text-text-primary'
const selectedKeyClass = 'border-accent-blue bg-accent-blue/20 text-accent-blue'

// Capture the chord at pointerdown so release order cannot change it. Navigation
// repeats immediately; other keys send on release so their grid can scroll.
const PanelKeyButton: React.FC<{
  item: PanelKey
  disabled: boolean
  createAction: (key: string) => () => boolean
}> = ({ item, disabled, createAction }) => {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointer = useRef<number | null>(null)
  const pendingAction = useRef<(() => boolean) | null>(null)
  const stop = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    pointer.current = null
    pendingAction.current = null
  }, [])
  useEffect(() => {
    if (disabled) stop()
  }, [disabled, stop])
  useEffect(() => {
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', stop)
    return () => {
      stop()
      window.removeEventListener('blur', stop)
      document.removeEventListener('visibilitychange', stop)
    }
  }, [stop])
  return (
    <button
      type="button"
      aria-label={item.key}
      disabled={disabled}
      className={`${keyClass} ${idleKeyClass} ${item.repeat ? 'touch-none' : 'touch-pan-y'}`}
      onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (event.button !== 0 || pointer.current !== null) return
        if (item.repeat) event.preventDefault()
        pointer.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
        const action = createAction(item.key)
        if (!item.repeat) {
          pendingAction.current = action
          return
        }
        if (!action()) return
        const repeat = () => {
          if (pointer.current !== null && action()) timer.current = setTimeout(repeat, 85)
          else stop()
        }
        timer.current = setTimeout(repeat, 400)
      }}
      onPointerUp={event => {
        if (pointer.current !== event.pointerId) return
        pendingAction.current?.()
        stop()
      }}
      onPointerCancel={event => { if (pointer.current === event.pointerId) stop() }}
      onLostPointerCapture={event => { if (pointer.current === event.pointerId) stop() }}
      onClick={event => { if (event.detail === 0) createAction(item.key)() }}
    >{item.label}</button>
  )
}

export const ComboKeyPanel: React.FC<Props> = ({ onClose }) => {
  const { sendKeystroke, connectionState } = useTerminal()
  const modifiers = useKeyModifiers()
  const [page, setPage] = useState<'letters' | 'symbols' | 'functions' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined)
  const connected = connectionState === 'connected'
  const { reset } = modifiers
  useEffect(() => {
    const updateHeight = () => {
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight
      setMaxHeight(viewportHeight * 0.5)
    }
    updateHeight()
    window.visualViewport?.addEventListener('resize', updateHeight)
    window.addEventListener('resize', updateHeight)
    return () => {
      window.visualViewport?.removeEventListener('resize', updateHeight)
      window.removeEventListener('resize', updateHeight)
    }
  }, [])
  useEffect(() => {
    const clear = () => { reset(); setError(null) }
    window.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', clear)
    return () => {
      window.removeEventListener('blur', clear)
      document.removeEventListener('visibilitychange', clear)
    }
  }, [reset])
  const createAction = (key: string) => {
    const stroke = { key, modifiers: modifiers.snapshot() }
    return () => {
      const result = sendKeystroke(stroke)
      if (!result.ok) {
        setError('message' in result && result.message ? result.message : '按键未发送，请检查连接后重试。')
        return false
      }
      setError(null)
      return true
    }
  }
  const extraKeys: PanelKey[] = page === 'functions' ? extendedKeys : page === 'letters'
    ? [...Array.from('1234567890qwertyuiopasdfghjklzxcvbnm', key => ({ key, label: key })), { key: 'Space', label: '空格' }]
    : page === 'symbols' ? Array.from('`~!@#$%^&*()-_=+[]{}\\|;:\'",.<>/?', key => ({ key, label: key })) : []
  const activeLabel = modifierKeys.filter(item => modifiers.active[item.key]).map(item => item.label).join(' + ')
  return (
    <section id="combo-key-panel" aria-label="组合键面板" style={{ maxHeight }} className="max-h-[50dvh] overflow-y-auto overscroll-contain bg-bg-secondary px-2 py-2">
      <div className="flex items-center gap-1.5">
        {modifierKeys.map(item => (
          <button
            key={item.key}
            type="button"
            disabled={!connected}
            aria-pressed={modifiers.active[item.key]}
            className={`${keyClass} touch-none flex-1 ${modifiers.active[item.key] ? selectedKeyClass : idleKeyClass}`}
            onContextMenu={event => event.preventDefault()}
            onPointerDown={event => {
              if (event.button !== 0) return
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              modifiers.press(event.pointerId, item.key)
            }}
            onPointerUp={event => modifiers.release(event.pointerId)}
            onPointerCancel={event => modifiers.release(event.pointerId, true)}
            onLostPointerCapture={event => modifiers.release(event.pointerId, true)}
            onClick={event => { if (event.detail === 0) modifiers.toggle(item.key) }}
          >{item.label}</button>
        ))}
        <button type="button" onClick={onClose} className={`${keyClass} ${idleKeyClass} px-2`} aria-label="返回普通键盘">返回</button>
      </div>
      <div className="my-1.5 min-h-[18px] text-xs text-text-secondary" aria-live="polite">
        {activeLabel ? `${activeLabel} · 持续生效，再点对应修饰键取消` : '点击修饰键保持按住，再点一次取消'}
      </div>
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
        {navigationKeys.map(item => <PanelKeyButton key={item.key} item={item} disabled={!connected} createAction={createAction} />)}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {([{ id: 'letters', label: '字母 / 数字' }, { id: 'symbols', label: '符号' }, { id: 'functions', label: '功能键' }] as const).map(item => (
          <button key={item.id} type="button" aria-expanded={page === item.id} onClick={() => setPage(value => value === item.id ? null : item.id)} className={`${keyClass} flex-1 text-xs ${page === item.id ? selectedKeyClass : idleKeyClass}`}>{item.label}</button>
        ))}
      </div>
      {page && <div className={`mt-1.5 grid gap-1.5 ${page === 'functions' ? 'grid-cols-6' : 'grid-cols-8 sm:grid-cols-10'}`}>
        {extraKeys.map(item => <PanelKeyButton key={item.key} item={item} disabled={!connected} createAction={createAction} />)}
      </div>}
      {error && <p role="alert" className="mt-1.5 text-xs text-accent-red">{error}</p>}
    </section>
  )
}
