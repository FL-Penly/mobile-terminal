import React, { useState } from 'react'

export interface UserCommand {
  label: string
  cmd: string
  autoEnter: boolean
}

export interface UserConfig {
  commands: UserCommand[]
}

export const DEFAULT_CONFIG: UserConfig = {
  commands: [
    { label: 'claude', cmd: 'claude --dangerously-skip-permissions', autoEnter: true },
  ],
}

export async function loadUserConfig(): Promise<UserConfig> {
  try {
    const res = await fetch('/api/user-config', { signal: AbortSignal.timeout(3000) })
    if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
      const data = await res.json()
      if (data.commands) return data
    }
  } catch {}
  return DEFAULT_CONFIG
}

export async function saveUserConfig(config: UserConfig): Promise<void> {
  try {
    await fetch('/api/user-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(3000),
    })
  } catch {}
}

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const [predictiveEcho, setPredictiveEcho] = useState(() => localStorage.getItem('terminal_predictive_echo') === 'on')

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="bg-bg-secondary w-full max-w-sm mx-4 rounded-xl shadow-2xl border border-border-subtle flex flex-col max-h-[80vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <h2 className="text-lg font-semibold text-text-primary">Settings</h2>
          <button onClick={onClose} className="p-2 text-text-secondary hover:text-text-primary transition-colors">✕</button>
        </div>

        <div className="overflow-y-auto p-4 space-y-6">
          <section>
            <h3 className="text-sm font-medium text-text-muted uppercase tracking-wider mb-3">Performance</h3>
            <div className="flex items-center justify-between bg-bg-tertiary p-3 rounded-lg">
              <div className="flex flex-col">
                <span className="text-sm text-text-primary">Predictive Echo</span>
                <span className="text-xs text-text-muted">Show keystrokes before server confirms</span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={predictiveEcho}
                  onChange={() => {
                    const next = !predictiveEcho
                    setPredictiveEcho(next)
                    localStorage.setItem('terminal_predictive_echo', next ? 'on' : 'off')
                    window.dispatchEvent(new CustomEvent('predictive-echo-changed', { detail: next }))
                  }}
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent-green"></div>
              </label>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
