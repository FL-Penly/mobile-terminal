import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'

export interface TerminalContextValue {
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'reconnecting'
  
  sendInput: (text: string) => void
  
  sendKey: (key: 'ESC' | 'TAB' | 'ENTER' | 'CTRL_C' | 'ARROW_UP' | 'ARROW_DOWN' | 'ARROW_LEFT' | 'ARROW_RIGHT' | 'PAGE_UP' | 'PAGE_DOWN' | 'CTRL_L') => void
  
  subscribeOutput: (callback: (data: string | Uint8Array) => void) => () => void
  
  terminalRef: React.RefObject<HTMLDivElement>

  resize: (cols: number, rows: number) => void

  reconnect: () => void
  
  reconnectAttempt: number
}

const TerminalContext = createContext<TerminalContextValue | null>(null)

export const useTerminal = () => {
  const context = useContext(TerminalContext)
  if (!context) {
    throw new Error('useTerminal must be used within a TerminalProvider')
  }
  return context
}

const KEY_SEQUENCES: Record<string, string> = {
  'ESC': '\x1b',
  'TAB': '\t',
  'ENTER': '\r',
  'CTRL_C': '\x03',
  'ARROW_UP': '\x1b[A',
  'ARROW_DOWN': '\x1b[B',
  'ARROW_RIGHT': '\x1b[C',
  'ARROW_LEFT': '\x1b[D',
  'PAGE_UP': '\x1b[5~',
  'PAGE_DOWN': '\x1b[6~',
  'CTRL_L': '\x0c',
}

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_DELAYS = [1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000, 15000, 30000]

export const TerminalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const terminalRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const listenersRef = useRef<Set<(data: string | Uint8Array) => void>>(new Set())
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected' | 'reconnecting'>('connecting')
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const manualDisconnectRef = useRef(false)
  
  const dimensionsRef = useRef({ cols: 80, rows: 24 })

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    
    setConnectionState(reconnectAttempt > 0 ? 'reconnecting' : 'connecting')
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const path = window.location.pathname.replace(/\/$/, '')
    const wsUrl = `${protocol}//${host}${path}/ws`

    const ws = new WebSocket(wsUrl, ['tty'])
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[Terminal] WebSocket connected')
      setConnectionState('connected')
      setReconnectAttempt(0)
      
      const { cols, rows } = dimensionsRef.current
      const auth = JSON.stringify({ AuthToken: '', columns: cols, rows: rows })
      ws.send(new TextEncoder().encode(auth))
    }

    ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer)
      if (data.length === 0) return

      const cmd = String.fromCharCode(data[0])
      
      if (cmd === '0') {
        const payload = data.slice(1)
        listenersRef.current.forEach(listener => listener(payload))
      } else if (cmd === '1') {
        const title = new TextDecoder().decode(data.slice(1))
        document.title = title
      }
    }

    ws.onclose = () => {
      console.log('[Terminal] WebSocket closed')
      wsRef.current = null
      
      if (manualDisconnectRef.current) {
        manualDisconnectRef.current = false
        setConnectionState('disconnected')
        return
      }
      
      setConnectionState('disconnected')
      
      if (reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
        const delay = RECONNECT_DELAYS[reconnectAttempt] || 30000
        console.log(`[Terminal] Reconnecting in ${delay}ms (attempt ${reconnectAttempt + 1})`)
        setReconnectAttempt(prev => prev + 1)
        reconnectTimerRef.current = window.setTimeout(() => {
          connect()
        }, delay)
      }
    }

    ws.onerror = (error) => {
      console.error('[Terminal] WebSocket error', error)
    }
  }, [reconnectAttempt])

  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    setReconnectAttempt(0)
    connect()
  }, [connect])

  useEffect(() => {
    connect()
    return () => {
      manualDisconnectRef.current = true
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  const sendInput = useCallback((text: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const payload = new TextEncoder().encode(text)
      const buf = new Uint8Array(payload.length + 1)
      buf[0] = 0x30 // '0'
      buf.set(payload, 1)
      wsRef.current.send(buf)
    }
  }, [])

  const sendKey = useCallback((key: keyof typeof KEY_SEQUENCES) => {
    const sequence = KEY_SEQUENCES[key]
    if (sequence) {
      sendInput(sequence)
    }
  }, [sendInput])

  const subscribeOutput = useCallback((callback: (data: string | Uint8Array) => void) => {
    listenersRef.current.add(callback)
    return () => {
      listenersRef.current.delete(callback)
    }
  }, [])

  const resize = useCallback((cols: number, rows: number) => {
    dimensionsRef.current = { cols, rows }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // ttyd expects the same Auth/Init structure for resize
      const resizeMsg = JSON.stringify({ AuthToken: '', columns: cols, rows: rows })
      const payload = new TextEncoder().encode(resizeMsg)
      const buf = new Uint8Array(payload.length + 1)
      buf[0] = 0x31 // '1' - Wait, checking protocol. 
      // Standard ttyd: 
      // Input: '0' + data
      // Resize: '1' + JSON (columns, rows)
      // Let me verify this. 
      // The prompt says: "Send input (prefix '0')". It doesn't explicitly say how to resize.
      // But standard ttyd (tsl0922/ttyd) src/server.c:
      // case '1': // resize
      // So yes, prefix '1' for resize/json.
      
      buf[0] = 0x31 // '1'
      buf.set(payload, 1)
      wsRef.current.send(buf)
    }
  }, [])

  return (
    <TerminalContext.Provider value={{
      connectionState,
      sendInput,
      sendKey,
      subscribeOutput,
      terminalRef,
      resize,
      reconnect,
      reconnectAttempt
    }}>
      {children}
    </TerminalContext.Provider>
  )
}
