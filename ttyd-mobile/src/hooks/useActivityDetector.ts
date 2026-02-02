import { useState, useEffect, useCallback, useRef } from 'react'
import { useTerminal } from '../contexts/TerminalContext'
import stripAnsi from 'strip-ansi'

export type ActivityType = 'reading' | 'writing' | 'thinking' | 'executing' | 'complete' | 'error'

export interface Activity {
  id: string
  type: ActivityType
  message: string
  file?: string
  timestamp: Date
}

interface PatternDef {
  pattern: RegExp
  type: ActivityType
  fileGroup?: number
}

const PATTERNS: PatternDef[] = [
  { pattern: /^Reading\s+(.+)$/i, type: 'reading', fileGroup: 1 },
  { pattern: /^Wrote\s+(.+?)(?:\s+\(.*\))?$/i, type: 'writing', fileGroup: 1 },
  { pattern: /^Created\s+(.+)$/i, type: 'writing', fileGroup: 1 },
  { pattern: /^Edited\s+(.+)$/i, type: 'writing', fileGroup: 1 },
  { pattern: /^Running\s+(.+)$/i, type: 'executing', fileGroup: 1 },
  { pattern: /^Executing\s+(.+)$/i, type: 'executing', fileGroup: 1 },
  { pattern: /^Thinking\.{3}$/i, type: 'thinking' },
  { pattern: /^Analyzing\s+(.+)/i, type: 'thinking', fileGroup: 1 },
  { pattern: /^\[read\]\s+(.+)$/i, type: 'reading', fileGroup: 1 },
  { pattern: /^\[write\]\s+(.+)$/i, type: 'writing', fileGroup: 1 },
  { pattern: /^\[exec\]\s+(.+)$/i, type: 'executing', fileGroup: 1 },
  { pattern: /^✓\s+(.+)$/i, type: 'complete', fileGroup: 1 },
  { pattern: /^✗\s+(.+)$/i, type: 'error', fileGroup: 1 },
  { pattern: /^Error:\s+(.+)/i, type: 'error', fileGroup: 1 },
]

const MAX_ACTIVITIES = 10
const BUFFER_LIMIT = 1000

const scheduleIdle = typeof window !== 'undefined' && window.requestIdleCallback 
  ? window.requestIdleCallback 
  : (cb: () => void) => setTimeout(cb, 16)

export function useActivityDetector() {
  const [activities, setActivities] = useState<Activity[]>([])
  const { subscribeOutput } = useTerminal()
  const bufferRef = useRef('')
  const idCounterRef = useRef(0)

  const addActivity = useCallback((type: ActivityType, message: string, file?: string) => {
    const newActivity: Activity = {
      id: `activity-${++idCounterRef.current}`,
      type,
      message,
      file,
      timestamp: new Date(),
    }
    
    setActivities(prev => {
      const updated = [newActivity, ...prev]
      return updated.slice(0, MAX_ACTIVITIES)
    })
  }, [])

  const processLine = useCallback((line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return

    for (const { pattern, type, fileGroup } of PATTERNS) {
      const match = trimmed.match(pattern)
      if (match) {
        const file = fileGroup ? match[fileGroup] : undefined
        const message = file || trimmed
        addActivity(type, message, file)
        return
      }
    }
  }, [addActivity])

  const processBuffer = useCallback(() => {
    if (!bufferRef.current) return

    const lines = bufferRef.current.split(/\r?\n/)
    bufferRef.current = lines.pop() || ''
    
    if (bufferRef.current.length > BUFFER_LIMIT) {
      bufferRef.current = bufferRef.current.slice(-BUFFER_LIMIT)
    }

    const linesToProcess = lines.slice(0, 50)
    linesToProcess.forEach(processLine)
  }, [processLine])

  useEffect(() => {
    const unsubscribe = subscribeOutput((data) => {
      const text = typeof data === 'string' 
        ? data 
        : new TextDecoder().decode(data)
      
      const cleaned = stripAnsi(text)
      bufferRef.current += cleaned

      if (bufferRef.current.length > BUFFER_LIMIT) {
        bufferRef.current = bufferRef.current.slice(-BUFFER_LIMIT)
      }

      scheduleIdle(() => processBuffer())
    })

    return unsubscribe
  }, [subscribeOutput, processBuffer])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as unknown as { __addMockActivity: typeof addActivity }).__addMockActivity = addActivity
    }
    return () => {
      if (typeof window !== 'undefined') {
        delete (window as unknown as { __addMockActivity?: typeof addActivity }).__addMockActivity
      }
    }
  }, [addActivity])

  return { activities, addActivity }
}
