import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { useTerminal } from '../contexts/TerminalContext'
import { PredictiveEcho } from '../utils/predictive-echo'

const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 24
const DEFAULT_FONT_SIZE = 12

export const Terminal = () => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const { subscribeOutput, sendInput, sendControl, resize } = useTerminal()
  
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('terminal_font_size')
    return saved ? parseInt(saved, 10) : DEFAULT_FONT_SIZE
  })
  const pinchRef = useRef({ initialDistance: 0, initialFontSize: DEFAULT_FONT_SIZE })
  const resizeTimerRef = useRef<number | null>(null)
  const predictiveEchoRef = useRef<PredictiveEcho | null>(null)

  const handleResize = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      fitAddonRef.current.fit()
      const { cols, rows } = termRef.current
      resize(cols, rows)
    }
  }, [resize])

  const debouncedResize = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    resizeTimerRef.current = window.setTimeout(handleResize, 150)
  }, [handleResize])

  const updateFontSize = useCallback((newSize: number) => {
    const clampedSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(newSize)))
    if (termRef.current && clampedSize !== termRef.current.options.fontSize) {
      termRef.current.options.fontSize = clampedSize
      setFontSize(clampedSize)
      localStorage.setItem('terminal_font_size', String(clampedSize))
      handleResize()
    }
  }, [handleResize])

  const getTouchDistance = (touches: TouchList) => {
    if (touches.length < 2) return 0
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length === 2) {
      pinchRef.current = {
        initialDistance: getTouchDistance(e.touches),
        initialFontSize: fontSize
      }
    }
  }, [fontSize])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (e.touches.length === 2) {
      const currentDistance = getTouchDistance(e.touches)
      const { initialDistance, initialFontSize } = pinchRef.current
      
      if (initialDistance > 0) {
        const scale = currentDistance / initialDistance
        const newSize = initialFontSize * scale
        updateFontSize(newSize)
      }
    }
  }, [updateFontSize])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      fontSize: fontSize,
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

    const predictiveEcho = new PredictiveEcho(term)
    predictiveEcho.enabled = localStorage.getItem('terminal_predictive_echo') === 'on'
    predictiveEchoRef.current = predictiveEcho

    // Load FitAddon
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)

    let renderer: 'webgl' | 'canvas' | 'dom' = 'dom'
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        console.warn('[Terminal] WebGL context lost, falling back to canvas')
        webglAddon.dispose()
        try {
          term.loadAddon(new CanvasAddon())
        } catch {}
      })
      term.loadAddon(webglAddon)
      renderer = 'webgl'
    } catch (e) {
      try {
        term.loadAddon(new CanvasAddon())
        renderer = 'canvas'
      } catch (e2) {
        renderer = 'dom'
      }
    }
    console.log(`[Terminal] Using ${renderer} renderer`)

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
      predictiveEcho.handleInput(data)
      sendInput(data)
    })

    const HIGH_WATER = 5
    let pendingWrites = 0
    let paused = false

    const unsubscribe = subscribeOutput((data) => {
      if (data instanceof Uint8Array) {
        predictiveEcho.handleOutput(data)
      }
      pendingWrites++
      if (pendingWrites >= HIGH_WATER && !paused) {
        paused = true
        sendControl(0x32)
      }
      term.write(data instanceof Uint8Array ? data : data, () => {
        pendingWrites--
        if (pendingWrites === 0 && paused) {
          paused = false
          sendControl(0x33)
        }
      })
    })

    const handlePredictiveEchoChanged = (e: Event) => {
      predictiveEcho.enabled = (e as CustomEvent).detail as boolean
    }
    window.addEventListener('predictive-echo-changed', handlePredictiveEchoChanged)

    window.addEventListener('resize', debouncedResize)

    const vv = window.visualViewport
    vv?.addEventListener('resize', debouncedResize)
    
    const container = containerRef.current
    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: true })

    return () => {
      unsubscribe()
      dataDisposable.dispose()
      window.removeEventListener('predictive-echo-changed', handlePredictiveEchoChanged)
      window.removeEventListener('resize', debouncedResize)
      vv?.removeEventListener('resize', debouncedResize)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      term.dispose()
    }
  }, [subscribeOutput, sendInput, sendControl, resize, handleResize, debouncedResize, handleTouchStart, handleTouchMove])

  return (
    <div 
      ref={containerRef} 
      className="w-full h-full bg-bg-primary overflow-hidden"
      style={{ padding: '4px' }}
    />
  )
}
