import React from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { useStatusData } from '../hooks/useStatusData'

// Truncate path to max length
function truncatePath(path: string, maxLen: number = 20): string {
  if (path.length <= maxLen) return path
  const parts = path.split('/')
  if (parts.length <= 2) return '...' + path.slice(-maxLen + 3)
  return '~/' + parts.slice(-2).join('/')
}

export const StatusBar: React.FC = () => {
  const { connectionState } = useTerminal()
  const { branch, path, changedFiles, isOffline, isLoading } = useStatusData()

  const isConnected = connectionState === 'connected'

  return (
    <div className="h-[40px] shrink-0 border-b border-border-subtle flex items-center px-3 bg-bg-secondary">
      <div className="flex items-center gap-2 text-xs text-text-secondary font-mono w-full overflow-hidden">
        {/* Connection indicator */}
        <span 
          className={`w-2 h-2 rounded-full shrink-0 ${isConnected ? 'bg-accent-green' : 'bg-accent-red'}`}
          title={isConnected ? 'Connected' : 'Disconnected'}
        />
        
        {/* Tool name */}
        <span className="text-text-primary font-semibold shrink-0">terminal</span>
        
        {/* Separator */}
        <span className="text-border-subtle shrink-0">│</span>
        
        {/* Git branch */}
        {isLoading ? (
          <span className="text-text-muted">Loading...</span>
        ) : isOffline ? (
          <span className="text-text-muted">(offline)</span>
        ) : (
          <>
            <span className="text-accent-purple shrink-0">{branch || 'no branch'}</span>
            <span className="text-border-subtle shrink-0">│</span>
            <span className="truncate" title={path}>{truncatePath(path)}</span>
            {changedFiles > 0 && (
              <>
                <span className="text-border-subtle shrink-0">│</span>
                <span className="text-accent-orange shrink-0">{changedFiles} changed</span>
              </>
            )}
          </>
        )}
        
        {/* Token stats (mock) - right aligned */}
        <span className="ml-auto text-text-muted shrink-0">⚡ 0  $0.00</span>
      </div>
    </div>
  )
}
