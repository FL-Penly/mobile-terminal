import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_CONFIG, loadUserConfig, saveUserConfig, type UserConfig } from '../components/SettingsModal'

// Never write defaults before the server config has loaded. Failed writes stay local
// until an explicit retry; serialize writes so older edits cannot overtake newer ones.
export const useUserConfig = () => {
  const [config, setConfig] = useState<UserConfig>(DEFAULT_CONFIG)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('正在加载模板…')
  const readyRef = useRef(false)
  const desired = useRef<UserConfig | null>(null)
  const saving = useRef(false)
  const mounted = useRef(false)
  const reload = useRef<() => void>(() => undefined)

  const save = useCallback(async () => {
    if (saving.current || !readyRef.current) return
    saving.current = true
    try {
      while (desired.current && mounted.current) {
        const next = desired.current
        setStatus('正在保存模板…')
        await saveUserConfig(next)
        if (desired.current === next) desired.current = null
      }
      if (mounted.current) setStatus('')
    } catch (error) {
      console.error('[UserConfig] Save failed:', error)
      if (mounted.current) setStatus('模板保存失败，本页编辑已保留，请重试')
    } finally { saving.current = false }
  }, [])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let pending = false
    let timer: number | undefined
    const load = async () => {
      if (cancelled || pending || readyRef.current) return
      window.clearTimeout(timer)
      pending = true
      try {
        const loaded = await loadUserConfig()
        if (cancelled) return
        readyRef.current = true
        setConfig(loaded)
        setReady(true)
        setStatus('')
      } catch (error) {
        if (cancelled) return
        console.error('[UserConfig] Load failed:', error)
        setStatus('模板加载失败，正在自动重试…')
        timer = window.setTimeout(() => { void load() }, 5000)
      } finally { pending = false }
    }
    const resume = () => { if (document.visibilityState !== 'hidden') void load() }
    reload.current = () => { void load() }
    void load()
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      cancelled = true
      mounted.current = false
      window.clearTimeout(timer)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [])

  const update = useCallback((next: UserConfig) => {
    if (!readyRef.current) return
    setConfig(next)
    desired.current = next
    void save()
  }, [save])
  const retry = useCallback(() => {
    if (readyRef.current) void save()
    else reload.current()
  }, [save])
  return { config, ready, status, update, retry }
}
