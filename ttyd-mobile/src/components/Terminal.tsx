import { useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { useTerminal } from '../contexts/TerminalContext'

export const Terminal = () => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const { subscribeOutput, sendInput, resize } = useTerminal()

  // Handle resize with debounce
  const handleResize = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      fitAddonRef.current.fit()
      const { cols, rows } = termRef.current
      resize(cols, rows)
    }
  }, [resize])

  useEffect(() => {
    if (!containerRef.current) return

    // Create terminal instance
    const term = new XTerm({
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(163, 113, 247, 0.3)',
        black: '#484f58',
        red: '#f85149',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#a371f7',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      scrollback: 1000,
      cursorBlink: true,
      allowProposedApi: true,
    })
    termRef.current = term

    // Load FitAddon
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)

    // Try WebGL addon, fallback to canvas renderer
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon.dispose()
      })
      term.loadAddon(webglAddon)
      console.log('[Terminal] Using WebGL renderer')
    } catch (e) {
      console.warn('[Terminal] WebGL addon failed, using canvas renderer:', e)
    }

    // Open terminal in container
    term.open(containerRef.current)
    
    // Initial fit
    setTimeout(() => {
      fitAddon.fit()
      const { cols, rows } = term
      resize(cols, rows)
    }, 0)

    // Handle user input -> send to WebSocket
    const dataDisposable = term.onData((data) => {
      sendInput(data)
    })

    // Subscribe to output from WebSocket -> write to terminal
    const unsubscribe = subscribeOutput((data) => {
      if (data instanceof Uint8Array) {
        term.write(data)
      } else {
        term.write(data)
      }
    })

    // Handle window resize
    window.addEventListener('resize', handleResize)

    // Cleanup
    return () => {
      unsubscribe()
      dataDisposable.dispose()
      window.removeEventListener('resize', handleResize)
      term.dispose()
    }
  }, [subscribeOutput, sendInput, resize, handleResize])

  return (
    <div 
      ref={containerRef} 
      className="w-full h-full bg-bg-primary overflow-hidden"
      style={{ padding: '4px' }}
    />
  )
}
