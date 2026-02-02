import React, { useState, useEffect } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { SettingsModal, CommandConfig } from './SettingsModal'
import { TextInputModal } from './TextInputModal'
import { DiffViewer } from './DiffViewer'
import { NewSessionModal, SessionListModal } from './TmuxManager'

export const Toolbar: React.FC = () => {
  const { sendKey, sendInput } = useTerminal()
  const [config, setConfig] = useState<CommandConfig | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isInputOpen, setIsInputOpen] = useState(false)
  const [isDiffOpen, setIsDiffOpen] = useState(false)
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false)
  const [isSessionListOpen, setIsSessionListOpen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)

  const loadConfig = () => {
    const saved = localStorage.getItem('ttyd_commands')
    if (saved) {
      try {
        setConfig(JSON.parse(saved))
      } catch (e) {
        console.error('Failed to parse ttyd_commands', e)
      }
    } else {
      // Default config will be handled by SettingsModal initial state, 
      // but here we might want to know if we should show default buttons.
      // For now, let's just initialize it with defaults if null.
      setConfig({
        defaultCommands: [
          { name: 'claude', cmd: 'claude --dangerously-skip-permissions', visible: true },
          { name: 'opencode', cmd: 'opencode', visible: true }
        ],
        customCommands: []
      })
    }
  }

  useEffect(() => {
    loadConfig()
  }, [])

  const handleCommand = (cmd: string) => {
    sendInput(cmd + '\r')
  }

  return (
    <>
      <div className="h-auto min-h-[44px] bg-bg-secondary border-t border-border-subtle flex flex-col shrink-0 pb-[env(safe-area-inset-bottom)]">
        <div className={`flex items-start px-2 py-2 gap-2 ${isExpanded ? 'flex-wrap' : 'overflow-x-auto no-scrollbar mask-gradient-right'}`}>
          {/* Expand/Collapse Toggle */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={`px-2 py-1.5 rounded shadow-sm border text-sm active:scale-95 transition-all shrink-0 ${
              isExpanded 
                ? 'bg-accent-blue/20 border-accent-blue text-accent-blue' 
                : 'bg-bg-tertiary/50 border-border-subtle text-text-secondary'
            }`}
            title={isExpanded ? 'Collapse toolbar' : 'Expand toolbar'}
          >
            {isExpanded ? '▼' : '▲'}
          </button>

          {/* Virtual Keys Group */}
          <div className={`flex items-center gap-2 pr-2 border-r border-border-subtle ${isExpanded ? 'flex-wrap' : 'shrink-0'}`}>
            <KeyBtn label="ESC" onClick={() => sendKey('ESC')} />
            <KeyBtn label="Tab" onClick={() => sendKey('TAB')} />
            <KeyBtn label="↲" onClick={() => sendKey('ENTER')} />
            <KeyBtn label="^C" onClick={() => sendKey('CTRL_C')} className="text-accent-red" />
            <KeyBtn label="↑" onClick={() => sendKey('ARROW_UP')} />
            <KeyBtn label="↓" onClick={() => sendKey('ARROW_DOWN')} />
            <KeyBtn label="←" onClick={() => sendKey('ARROW_LEFT')} />
            <KeyBtn label="→" onClick={() => sendKey('ARROW_RIGHT')} />
            <KeyBtn label="PgUp" onClick={() => sendKey('PAGE_UP')} />
            <KeyBtn label="PgDn" onClick={() => sendKey('PAGE_DOWN')} />
            <KeyBtn label="^L" onClick={() => sendKey('CTRL_L')} />
          </div>

          {/* Command Buttons Group */}
          {config && (
            <div className={`flex items-center gap-2 pr-2 border-r border-border-subtle ${isExpanded ? 'flex-wrap' : 'shrink-0'}`}>
              {config.defaultCommands.filter(c => c.visible).map(cmd => (
                <CmdBtn key={cmd.name} label={cmd.name} onClick={() => handleCommand(cmd.cmd)} />
              ))}
              {config.customCommands.map(cmd => (
                <CmdBtn key={cmd.name} label={cmd.name} onClick={() => handleCommand(cmd.cmd)} />
              ))}
            </div>
          )}

          {/* System Buttons Group */}
          <div className={`flex items-center gap-2 ${isExpanded ? 'flex-wrap' : 'shrink-0'}`}>
            <SystemBtn label="⌨️" onClick={() => setIsInputOpen(true)} />
            <SystemBtn label="+Tmux" onClick={() => setIsNewSessionOpen(true)} />
            <SystemBtn label="Sessions" onClick={() => setIsSessionListOpen(true)} />
            <SystemBtn label="Diff" onClick={() => setIsDiffOpen(true)} className="text-accent-green" />
            <SystemBtn label="⚙️" onClick={() => setIsSettingsOpen(true)} />
          </div>
        </div>
      </div>

      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
        onConfigChange={loadConfig}
      />

      <TextInputModal
        isOpen={isInputOpen}
        onClose={() => setIsInputOpen(false)}
        onSend={(text) => sendInput(text)}
      />

      <DiffViewer
        isOpen={isDiffOpen}
        onClose={() => setIsDiffOpen(false)}
      />

      <NewSessionModal
        isOpen={isNewSessionOpen}
        onClose={() => setIsNewSessionOpen(false)}
      />

      <SessionListModal
        isOpen={isSessionListOpen}
        onClose={() => setIsSessionListOpen(false)}
      />
    </>
  )
}

// Helper Components
const KeyBtn: React.FC<{ label: string; onClick: () => void; className?: string }> = ({ label, onClick, className = '' }) => (
  <button 
    onClick={onClick}
    className={`px-3 py-1.5 bg-bg-tertiary rounded shadow-sm border border-border-subtle text-text-primary text-sm font-mono active:scale-95 transition-transform whitespace-nowrap ${className}`}
  >
    {label}
  </button>
)

const CmdBtn: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button 
    onClick={onClick}
    className="px-3 py-1.5 bg-bg-tertiary rounded shadow-sm border border-border-subtle text-accent-blue text-sm font-mono active:scale-95 transition-transform whitespace-nowrap"
  >
    {label}
  </button>
)

const SystemBtn: React.FC<{ label: string; onClick: () => void; className?: string }> = ({ label, onClick, className = '' }) => (
  <button 
    onClick={onClick}
    className={`px-3 py-1.5 bg-bg-tertiary/50 hover:bg-bg-tertiary rounded shadow-sm border border-border-subtle text-text-secondary hover:text-text-primary text-sm font-medium active:scale-95 transition-all whitespace-nowrap ${className}`}
  >
    {label}
  </button>
)
