import React, { useState, useEffect, useCallback } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { Toolbar } from './Toolbar'
import { StatusBar } from './StatusBar'
import { ConnectionOverlay } from './ConnectionOverlay'
import { TmuxSidebar } from './TmuxSidebar'

const SIDEBAR_COLLAPSED_KEY = 'tmux_sidebar_collapsed'

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { terminalRef } = useTerminal()
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)
  const [desktopCollapsed, setDesktopCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true')
  const [mobileOpen, setMobileOpen] = useState(false)

  const updateHeight = useCallback(() => {
    const vv = window.visualViewport
    if (vv) {
      setViewportHeight(vv.height)
    }
  }, [])

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    vv.addEventListener('resize', updateHeight)
    vv.addEventListener('scroll', updateHeight)
    updateHeight()

    return () => {
      vv.removeEventListener('resize', updateHeight)
      vv.removeEventListener('scroll', updateHeight)
    }
  }, [updateHeight])

  const heightStyle = viewportHeight ? { height: `${viewportHeight}px` } : { height: '100dvh' }

  const openSessions = () => {
    if (isDesktop) {
      setDesktopCollapsed(false)
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'false')
    } else {
      setMobileOpen(true)
    }
  }

  const collapseDesktop = () => {
    setDesktopCollapsed(true)
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true')
  }

  return (
    <div
      className="flex flex-col bg-bg-primary overflow-hidden text-text-primary font-sans selection:bg-accent-blue/30"
      style={heightStyle}
    >
      <StatusBar onOpenSessions={openSessions} />

      <div className="relative flex min-h-0 flex-1">
        {isDesktop && !desktopCollapsed && (
          <div className="hidden h-full shrink-0 md:block">
            <TmuxSidebar mobile={false} onClose={() => undefined} onCollapseDesktop={collapseDesktop} />
          </div>
        )}
        <div
          ref={terminalRef}
          className="relative min-w-0 flex-1 bg-bg-primary overflow-hidden"
        >
          {children}
        </div>
        {!isDesktop && mobileOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <button className="absolute inset-0 bg-black/70" onClick={() => setMobileOpen(false)} aria-label="Close sessions drawer overlay" />
            <div className="absolute inset-y-0 left-0 shadow-2xl">
              <TmuxSidebar mobile onClose={() => setMobileOpen(false)} onCollapseDesktop={() => undefined} />
            </div>
          </div>
        )}
      </div>

      <Toolbar />

      <ConnectionOverlay />
    </div>
  )
}
