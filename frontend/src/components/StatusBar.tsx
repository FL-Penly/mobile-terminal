import React, { useCallback } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { useServerEvents } from '../contexts/ServerEventsContext'
import { BranchSelector } from './BranchSelector'

// Truncate path to max length
function truncatePath(path: string, maxLen: number = 20): string {
  if (path.length <= maxLen) return path
  const parts = path.split('/')
  if (parts.length <= 2) return '...' + path.slice(-maxLen + 3)
  return '~/' + parts.slice(-2).join('/')
}

interface StatusBarProps {
  onOpenSessions: () => void
}

export const StatusBar: React.FC<StatusBarProps> = ({ onOpenSessions }) => {
  const { connectionState } = useTerminal()
  const { branch, path, isOffline, refresh, currentTmuxSession, tmuxSessions } = useServerEvents()

  const handleBranchChange = useCallback(() => {
    setTimeout(() => refresh(), 500)
  }, [refresh])

  const isConnected = connectionState === 'connected'

  return (
    <div className="h-[40px] shrink-0 border-b border-border-subtle flex items-center px-3 bg-bg-secondary overflow-visible">
      <div className="flex items-center gap-2 text-xs text-text-secondary font-mono w-full">
        <span 
          className={`w-2 h-2 rounded-full shrink-0 ${isConnected ? 'bg-accent-green' : 'bg-accent-red'}`}
          title={isConnected ? 'Connected' : 'Disconnected'}
        />
        
        <button
          onClick={onOpenSessions}
          className="relative flex max-w-[150px] items-center gap-1.5 rounded-md bg-accent-purple px-2.5 py-1 text-xs font-medium text-white"
          aria-label="Open sessions sidebar"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-green" />
          <span className="truncate">{currentTmuxSession ?? 'Sessions'}</span>
          {tmuxSessions.some(session => session.hasNewActivity) && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-accent-orange" />}
        </button>
        
        <span className="text-border-subtle shrink-0">│</span>
        
        {isOffline ? (
          <span className="text-text-muted">(offline)</span>
        ) : (
          <>
            <BranchSelector currentBranch={branch || '-'} onBranchChange={handleBranchChange} />
            <span className="text-border-subtle shrink-0">│</span>
            <span className="truncate" title={path}>{truncatePath(path)}</span>
          </>
        )}

      </div>
    </div>
  )
}
