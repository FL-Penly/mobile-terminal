import React from 'react'
import { Toolbar } from './Toolbar'
import { StatusBar } from './StatusBar'
import { ActivityStream } from './ActivityStream'
import { ConnectionOverlay } from './ConnectionOverlay'
import { useTerminal } from '../contexts/TerminalContext'

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { terminalRef } = useTerminal()

  return (
    <div className="flex flex-col h-[100dvh] bg-bg-primary overflow-hidden text-text-primary font-sans selection:bg-accent-blue/30">
      <StatusBar />

      <ActivityStream />

      <div 
        ref={terminalRef} 
        className="flex-1 min-h-0 relative bg-bg-primary overflow-hidden"
      >
        {children}
      </div>

      <Toolbar />

      <ConnectionOverlay />
    </div>
  )
}
