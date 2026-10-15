import { useEffect, useRef, useState } from 'react'

export interface HerdrRenameTarget {
  kind: 'workspace' | 'tab'
  id: string
  label: string
  context: string
}

interface HerdrRenameModalProps {
  target: HerdrRenameTarget | null
  onClose: () => void
  onSettled: () => void
}

const renameErrorMessage = async (response: Response) => {
  const data = await response.json().catch(() => null) as { message?: string } | null
  return data?.message ?? `Rename failed (HTTP ${response.status})`
}

export const HerdrRenameModal: React.FC<HerdrRenameModalProps> = ({ target, onClose, onSettled }) => {
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!target) return
    setLabel(target.label)
    setError(null)
    const timer = window.setTimeout(() => inputRef.current?.select(), 50)
    return () => window.clearTimeout(timer)
  }, [target])

  if (!target) return null

  const trimmed = label.trim()
  const unchanged = trimmed === target.label.trim()
  const noun = target.kind === 'workspace' ? 'Workspace' : 'Tab'

  const save = async () => {
    if (!trimmed || unchanged || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const response = await fetch('/api/herdr/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: target.kind, id: target.id, label: trimmed }),
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(await renameErrorMessage(response))
      onSettled()
      onClose()
    } catch (err) {
      console.error('[HerdrRenameModal] Rename failed:', err)
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      setError(timedOut
        ? 'Herdr did not answer in time. The list was reloaded; check the name before retrying.'
        : err instanceof Error ? err.message : 'Rename failed')
      onSettled()
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4" onClick={event => event.target === event.currentTarget && !saving && onClose()}>
      <div className="w-full max-w-sm rounded-xl bg-bg-secondary p-4" role="dialog" aria-modal="true" aria-labelledby="herdr-rename-title">
        <h3 id="herdr-rename-title" className="text-lg font-semibold">Rename {noun}</h3>
        <p className="mt-1 truncate text-xs text-text-muted" title={target.id}>{target.context}</p>
        <input
          ref={inputRef}
          value={label}
          onChange={event => setLabel(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void save()
            } else if (event.key === 'Escape' && !saving) {
              onClose()
            }
          }}
          aria-label={`${noun} name`}
          placeholder={`${noun} name`}
          className="mt-4 w-full rounded-lg border border-border-subtle bg-bg-tertiary px-3 py-2 text-text-primary placeholder:text-text-muted focus:border-accent-purple focus:outline-none"
        />
        {error && <p role="alert" className="mt-2 text-xs text-accent-red">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="rounded-lg bg-bg-tertiary px-4 py-2 text-text-secondary disabled:opacity-50">Cancel</button>
          <button
            onClick={() => { void save() }}
            disabled={!trimmed || unchanged || saving}
            className="rounded-lg bg-accent-purple px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
          >{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
