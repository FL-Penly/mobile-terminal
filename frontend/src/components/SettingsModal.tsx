import React, { useState } from 'react'

export interface UserCommand {
  label: string
  cmd: string
  autoEnter: boolean
}

export interface UserPreset {
  label: string
  text: string
}

export interface UserPresetGroup {
  id: string
  label: string
  presets: UserPreset[]
}

export interface UserConfig {
  commands: UserCommand[]
  presets: UserPreset[]
  presetGroups: UserPresetGroup[]
  activePresetGroupId: string
}

const DEFAULT_GROUP_ID = 'default'

const defaultPresetGroup = (presets: UserPreset[] = []): UserPresetGroup => ({
  id: DEFAULT_GROUP_ID,
  label: '默认',
  presets,
})

export const DEFAULT_CONFIG: UserConfig = {
  commands: [
    { label: 'claude', cmd: 'claude --dangerously-skip-permissions', autoEnter: true },
  ],
  presets: [],
  presetGroups: [defaultPresetGroup()],
  activePresetGroupId: DEFAULT_GROUP_ID,
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readString = (record: Record<string, unknown>, key: string, fallback = ''): string => {
  const value = record[key]
  return typeof value === 'string' ? value : fallback
}

const readBoolean = (record: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const value = record[key]
  return typeof value === 'boolean' ? value : fallback
}

const readPresets = (value: unknown): UserPreset[] => (
  Array.isArray(value)
    ? value
      .filter(isRecord)
      .map(item => ({
        label: readString(item, 'label'),
        text: readString(item, 'text'),
      }))
      .filter(item => item.label || item.text)
    : []
)

const readCommands = (value: unknown): UserCommand[] => (
  Array.isArray(value)
    ? value
      .filter(isRecord)
      .map(item => ({
        label: readString(item, 'label'),
        cmd: readString(item, 'cmd'),
        autoEnter: readBoolean(item, 'autoEnter', true),
      }))
      .filter(item => item.label || item.cmd)
    : []
)

const readPresetGroups = (value: unknown): UserPresetGroup[] => (
  Array.isArray(value)
    ? value
      .filter(isRecord)
      .map((item, idx) => {
        const id = readString(item, 'id', `group-${idx + 1}`).trim() || `group-${idx + 1}`
        const label = readString(item, 'label', id).trim() || id
        return {
          id,
          label,
          presets: readPresets(item.presets),
        }
      })
    : []
)

export const getActivePresetGroup = (config: UserConfig): UserPresetGroup => (
  config.presetGroups.find(group => group.id === config.activePresetGroupId)
    ?? config.presetGroups[0]
    ?? defaultPresetGroup()
)

export const normalizeUserConfig = (value: unknown): UserConfig => {
  if (!isRecord(value)) return DEFAULT_CONFIG

  const hasCommands = Array.isArray(value.commands)
  const commands = readCommands(value.commands)
  const legacyPresets = readPresets(value.presets)
  const loadedGroups = readPresetGroups(value.presetGroups)
  const presetGroups = loadedGroups.length > 0 ? loadedGroups : [defaultPresetGroup(legacyPresets)]
  const activeFromConfig = readString(value, 'activePresetGroupId', presetGroups[0]?.id ?? DEFAULT_GROUP_ID)
  const activePresetGroupId = presetGroups.some(group => group.id === activeFromConfig)
    ? activeFromConfig
    : presetGroups[0]?.id ?? DEFAULT_GROUP_ID
  const activePresets = presetGroups.find(group => group.id === activePresetGroupId)?.presets ?? []

  return {
    commands: hasCommands ? commands : DEFAULT_CONFIG.commands,
    presets: activePresets,
    presetGroups,
    activePresetGroupId,
  }
}

const serializeUserConfig = (config: UserConfig): UserConfig => {
  const normalized = normalizeUserConfig(config)
  return {
    ...normalized,
    presets: getActivePresetGroup(normalized).presets,
  }
}

export async function loadUserConfig(): Promise<UserConfig> {
  try {
    const res = await fetch('/api/user-config', { signal: AbortSignal.timeout(3000) })
    if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
      const data: unknown = await res.json()
      return normalizeUserConfig(data)
    }
  } catch {}
  return DEFAULT_CONFIG
}

export async function saveUserConfig(config: UserConfig): Promise<void> {
  try {
    await fetch('/api/user-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeUserConfig(config)),
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
