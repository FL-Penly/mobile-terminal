import { useCallback, useRef, useState } from 'react'
import type { KeyModifiers } from '../utils/terminal-keys'

export type ModifierKey = keyof KeyModifiers
interface HeldModifier { key: ModifierKey; used: boolean; startedAt: number }
interface ModifierState {
  latched: Set<ModifierKey>
  held: Map<number, HeldModifier>
}
const initialState = (): ModifierState => ({ latched: new Set(), held: new Map() })
const activeModifiers = (state: ModifierState): KeyModifiers => {
  const active = new Set([...state.latched, ...Array.from(state.held.values(), pointer => pointer.key)])
  return { ctrl: active.has('ctrl'), alt: active.has('alt'), shift: active.has('shift') }
}

// Refs update synchronously so two fingers arriving in the same React batch
// still produce the right chord. State changes only request a visual refresh.
export const useKeyModifiers = () => {
  const state = useRef(initialState())
  const [, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const reset = useCallback(() => { state.current = initialState(); refresh() }, [refresh])
  const toggle = useCallback((key: ModifierKey) => {
    const current = state.current
    if (current.latched.has(key)) current.latched.delete(key)
    else current.latched.add(key)
    refresh()
  }, [refresh])
  const press = useCallback((id: number, key: ModifierKey) => {
    state.current.held.set(id, { key, used: false, startedAt: performance.now() })
    refresh()
  }, [refresh])
  const release = useCallback((id: number, cancelled = false) => {
    const held = state.current.held.get(id)
    if (!held) return
    state.current.held.delete(id)
    if (!cancelled && !held.used && performance.now() - held.startedAt < 400) toggle(held.key)
    else refresh()
  }, [refresh, toggle])
  const snapshot = useCallback(() => {
    const modifiers = activeModifiers(state.current)
    state.current.held.forEach(pointer => { pointer.used = true })
    return modifiers
  }, [])
  return { active: activeModifiers(state.current), reset, toggle, press, release, snapshot }
}
