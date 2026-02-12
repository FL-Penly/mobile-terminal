import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'

const DIFF_SERVER_PORT = 7683

export interface TerminalContextValue {
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'reconnecting'
  
  sendInput: (text: string) => void
  
  sendKey: (key: 'ESC' | 'TAB' | 'ENTER' | 'CTRL_C' | 'ARROW_UP' | 'ARROW_DOWN' | 'ARROW_LEFT' | 'ARROW_RIGHT' | 'PAGE_UP' | 'PAGE_DOWN' | 'CTRL_L') => void
  
  subscribeOutput: (callback: (data: string | Uint8Array) => void) => () => void
  
  sendControl: (byte: number) => void
  
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
const RECONNECT_DELAYS = [500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000, 30000]

const TMUX_SESSION_KEY = 'ttyd_last_tmux_session'

export const TerminalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const terminalRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const listenersRef = useRef<Set<(data: string | Uint8Array) => void>>(new Set())
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected' | 'reconnecting'>('connecting')
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const manualDisconnectRef = useRef(false)
  const isReconnectRef = useRef(false)
  const lastConnectedTimeRef = useRef<number>(0)
  
  const dimensionsRef = useRef({ cols: 80, rows: 24 })

  // RAF write coalescing buffers
  const writeBufferRef = useRef<Uint8Array[]>([])
  const writeTotalRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)

  const flushBuffer = useCallback(() => {
    const chunks = writeBufferRef.current
    if (chunks.length === 0) return
    
    rafIdRef.current = null
    
    let combined: Uint8Array
    if (chunks.length === 1) {
      combined = chunks[0]
    } else {
      combined = new Uint8Array(writeTotalRef.current)
      let offset = 0
      for (const chunk of chunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }
    }
    
    writeBufferRef.current = []
    writeTotalRef.current = 0
    
    listenersRef.current.forEach(listener => listener(combined))
  }, [])

  const restoreTmuxSession = useCallback(async (ws: WebSocket) => {
    const savedSession = localStorage.getItem(TMUX_SESSION_KEY)
    if (!savedSession) return

    console.log(`[Terminal] Attempting to restore tmux session: ${savedSession}`)
    
    // ttyd spawns a new shell on reconnect; wait for it to be ready before sending commands
    await new Promise(r => setTimeout(r, 500))

    try {
      const listUrl = `http://${location.hostname}:${DIFF_SERVER_PORT}/api/tmux/list`
      const listRes = await fetch(listUrl, { signal: AbortSignal.timeout(3000) })
      if (listRes.ok) {
        const data = await listRes.json()
        const sessions: { name: string }[] = data.sessions || []
        const sessionExists = sessions.some(s => s.name === savedSession)
        
        if (sessionExists) {
          if (ws.readyState === WebSocket.OPEN) {
            const cmd = `tmux attach -t ${savedSession}\r`
            const payload = new TextEncoder().encode(cmd)
            const buf = new Uint8Array(payload.length + 1)
            buf[0] = 0x30
            buf.set(payload, 1)
            ws.send(buf)
            console.log(`[Terminal] Restored tmux session: ${savedSession}`)
            return
          }
        } else {
          console.log(`[Terminal] Saved session "${savedSession}" no longer exists`)
          localStorage.removeItem(TMUX_SESSION_KEY)
        }
      }
    } catch {
      if (ws.readyState === WebSocket.OPEN) {
        const cmd = `tmux attach -t ${savedSession} 2>/dev/null || true\r`
        const payload = new TextEncoder().encode(cmd)
        const buf = new Uint8Array(payload.length + 1)
        buf[0] = 0x30
        buf.set(payload, 1)
        ws.send(buf)
        console.log(`[Terminal] Sent tmux attach command (fallback)`)
      }
    }
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    
    const wasReconnect = isReconnectRef.current
    setConnectionState(wasReconnect ? 'reconnecting' : 'connecting')
    
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
      lastConnectedTimeRef.current = Date.now()
      
      const { cols, rows } = dimensionsRef.current
      const auth = JSON.stringify({ AuthToken: '', columns: cols, rows: rows })
      ws.send(new TextEncoder().encode(auth))

      if (wasReconnect) {
        isReconnectRef.current = false
        restoreTmuxSession(ws)
      }
    }

    ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer)
      if (data.length === 0) return

      const cmd = String.fromCharCode(data[0])
      
      if (cmd === '0') {
        const payload = data.subarray(1)
        writeBufferRef.current.push(payload)
        writeTotalRef.current += payload.length
        
        const SAFETY_VALVE = 512 * 1024
        if (writeTotalRef.current > SAFETY_VALVE) {
          flushBuffer()
        } else if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flushBuffer)
        }
      } else if (cmd === '1') {
        const title = new TextDecoder().decode(data.subarray(1))
        document.title = title
      }
    }

    ws.onclose = () => {
      console.log('[Terminal] WebSocket closed')
      wsRef.current = null
      
      flushBuffer()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      
      if (manualDisconnectRef.current) {
        manualDisconnectRef.current = false
        setConnectionState('disconnected')
        return
      }
      
      setConnectionState('disconnected')
      isReconnectRef.current = true
      
      setReconnectAttempt(prev => {
        const attempt = prev + 1
        if (attempt <= MAX_RECONNECT_ATTEMPTS) {
          const delay = RECONNECT_DELAYS[prev] || 30000
          console.log(`[Terminal] Reconnecting in ${delay}ms (attempt ${attempt})`)
          reconnectTimerRef.current = window.setTimeout(() => {
            connect()
          }, delay)
        }
        return attempt
      })
    }

    ws.onerror = (error) => {
      console.error('[Terminal] WebSocket error', error)
    }
  }, [restoreTmuxSession, flushBuffer])

  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    isReconnectRef.current = true
    setReconnectAttempt(0)
    connect()
  }, [connect])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const ws = wsRef.current
        const isDisconnected = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING

        if (isDisconnected) {
          console.log('[Terminal] Page became visible, connection lost — reconnecting immediately')
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current)
            reconnectTimerRef.current = null
          }
          isReconnectRef.current = true
          setReconnectAttempt(0)
          connect()
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          // Mobile browsers may freeze WebSocket without firing onclose; probe with a resize msg
          const timeSinceConnect = Date.now() - lastConnectedTimeRef.current
          if (timeSinceConnect > 30000) {
            const { cols, rows } = dimensionsRef.current
            const resizeMsg = JSON.stringify({ AuthToken: '', columns: cols, rows: rows })
            const payload = new TextEncoder().encode(resizeMsg)
            const buf = new Uint8Array(payload.length + 1)
            buf[0] = 0x31
            buf.set(payload, 1)
            try {
              ws.send(buf)
            } catch {
              console.log('[Terminal] Connection stale on visibility change — forcing reconnect')
              ws.close()
            }
          }
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [connect])

  useEffect(() => {
    connect()
    return () => {
      manualDisconnectRef.current = true
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
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
      buf[0] = 0x30
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

  const sendControl = useCallback((byte: number) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(new Uint8Array([byte]))
    }
  }, [])

  const resize = useCallback((cols: number, rows: number) => {
    dimensionsRef.current = { cols, rows }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const resizeMsg = JSON.stringify({ AuthToken: '', columns: cols, rows: rows })
      const payload = new TextEncoder().encode(resizeMsg)
      const buf = new Uint8Array(payload.length + 1)
      buf[0] = 0x31
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
      sendControl,
      terminalRef,
      resize,
      reconnect,
      reconnectAttempt
    }}>
      {children}
    </TerminalContext.Provider>
  )
}
