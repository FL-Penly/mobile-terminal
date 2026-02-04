import React, { useState, useRef, useEffect } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { useTmuxSessions } from '../hooks/useTmuxSessions'
import { NewSessionModal } from './TmuxManager'

const DIFF_SERVER_PORT = 7683
const LONG_PRESS_DURATION = 1500

interface KillConfirmModalProps {
  sessionName: string
  onConfirm: () => void
  onCancel: () => void
}

const KillConfirmModal: React.FC<KillConfirmModalProps> = ({ sessionName, onConfirm, onCancel }) => {
  return (
    <div 
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="w-full max-w-sm bg-bg-secondary rounded-xl p-4">
        <h3 className="text-lg font-semibold mb-2">Kill Session?</h3>
        <p className="text-text-secondary text-sm mb-4">
          Are you sure you want to kill session <span className="text-accent-red font-mono">"{sessionName}"</span>? This action cannot be undone.
        </p>
        
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg bg-accent-red text-white"
          >
            Kill Session
          </button>
        </div>
      </div>
    </div>
  )
}

export const SessionTabBar: React.FC = () => {
  const { sendInput } = useTerminal()
  const { sessions, currentSession, refresh } = useTmuxSessions()
  const [isOpen, setIsOpen] = useState(false)
  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false)
  const [killTargetSession, setKillTargetSession] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const longPressTimer = useRef<number | null>(null)
  const longPressTriggered = useRef(false)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      // Use both mousedown and touchstart for cross-platform support
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('touchstart', handleClickOutside, { passive: true })
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
        document.removeEventListener('touchstart', handleClickOutside)
      }
    }
  }, [isOpen])

  const handleSwitchSession = async (sessionName: string) => {
    setIsOpen(false)
    try {
      const url = `http://${location.hostname}:${DIFF_SERVER_PORT}/api/tmux/switch?session=${encodeURIComponent(sessionName)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error('API failed')
      refresh()
    } catch {
      sendInput(`[ -n "$TMUX" ] && tmux switch-client -t ${sessionName} || tmux attach -t ${sessionName}\r`)
    }
  }

  const handleKillSession = async (sessionName: string) => {
    try {
      const url = `http://${location.hostname}:${DIFF_SERVER_PORT}/api/tmux/kill?name=${encodeURIComponent(sessionName)}`
      await fetch(url, { signal: AbortSignal.timeout(5000) })
      refresh()
    } catch {}
    setKillTargetSession(null)
  }

  const handleLongPressStart = (sessionName: string) => {
    longPressTriggered.current = false
    longPressTimer.current = window.setTimeout(() => {
      longPressTriggered.current = true
      setKillTargetSession(sessionName)
      setIsOpen(false)
    }, LONG_PRESS_DURATION)
  }

  const handleLongPressEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  const handleItemClick = (sessionName: string) => {
    if (!longPressTriggered.current) {
      handleSwitchSession(sessionName)
    }
  }

  const handleNewSession = () => {
    setIsOpen(false)
    setIsNewSessionOpen(true)
  }

  if (sessions.length === 0) {
    return (
      <>
        <button
          onTouchEnd={(e) => { e.preventDefault(); handleNewSession() }}
          onClick={handleNewSession}
          className="flex items-center gap-1.5 px-2.5 py-1 text-accent-purple text-xs font-medium active:opacity-70"
        >
          + New Session
        </button>
        <NewSessionModal
          isOpen={isNewSessionOpen}
          onClose={() => setIsNewSessionOpen(false)}
        />
      </>
    )
  }

  const currentSessionData = sessions.find(s => s.name === currentSession)
  const displayName = currentSessionData?.name || sessions[0]?.name || 'Select'

  return (
    <>
      <div ref={dropdownRef} className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 px-2.5 py-1 bg-accent-purple rounded-md text-white text-xs font-medium whitespace-nowrap"
        >
          <span className="w-1.5 h-1.5 bg-accent-green rounded-full" />
          {displayName}
          <span className="ml-1 text-[10px] opacity-70">{isOpen ? '▲' : '▼'}</span>
        </button>

        {isOpen && (
          <div className="absolute top-full left-0 mt-1 min-w-[160px] bg-bg-secondary border border-border-subtle rounded-lg shadow-lg z-50 overflow-hidden">
            <div className="max-h-[200px] overflow-y-auto">
              {sessions.map(session => (
                <button
                  key={session.name}
                  onClick={() => handleItemClick(session.name)}
                  onTouchStart={() => handleLongPressStart(session.name)}
                  onTouchEnd={handleLongPressEnd}
                  onMouseDown={() => handleLongPressStart(session.name)}
                  onMouseUp={handleLongPressEnd}
                  onMouseLeave={handleLongPressEnd}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors ${
                    session.name === currentSession
                      ? 'bg-accent-purple/20 text-accent-purple'
                      : 'text-text-primary hover:bg-bg-tertiary'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${
                    session.attached ? 'bg-accent-green' : 'bg-text-muted opacity-50'
                  }`} />
                  <span className="flex-1 truncate">{session.name}</span>
                  <span className="text-xs text-text-muted">{session.windows}w</span>
                </button>
              ))}
            </div>
            
            <div className="border-t border-border-subtle">
              <button
                onTouchEnd={(e) => { e.preventDefault(); handleNewSession() }}
                onClick={handleNewSession}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm text-accent-purple hover:bg-bg-tertiary active:bg-bg-tertiary"
              >
                <span className="w-2 h-2 flex items-center justify-center text-xs">+</span>
                <span>New Session</span>
              </button>
            </div>
          </div>
        )}
      </div>

      <NewSessionModal
        isOpen={isNewSessionOpen}
        onClose={() => setIsNewSessionOpen(false)}
      />

      {killTargetSession && (
        <KillConfirmModal
          sessionName={killTargetSession}
          onConfirm={() => handleKillSession(killTargetSession)}
          onCancel={() => setKillTargetSession(null)}
        />
      )}
    </>
  )
}
