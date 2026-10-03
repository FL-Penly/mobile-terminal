import { Inflate } from 'fflate'

export const OUTPUT_PREFIX = 0x30
export const CONTROL_PREFIX = 0x34
export const DEFLATE_OUTPUT_PREFIX = 0x35
export const FEATURES = ['heartbeat', 'deflate', 'flow'] as const
export const HEARTBEAT_TIMEOUT_MS = 15000
export const LIVENESS_CHECK_INTERVAL_MS = 1000
export const ACK_DELAY_MS = 30
export const STABLE_CONNECTION_MS = 10000
export const CONNECT_TIMEOUTS_MS = [10000, 15000, 20000]
export const RECONNECT_DELAYS = [500, 1000, 2000, 3000, 5000]

const encoder = new TextEncoder()

export type ControlMessage =
  | { type: 'hello'; features: string[] }
  | { type: 'heartbeat' }
  | { type: 'closed'; reason: string; retry: boolean }

export const encodeInitMessage = (cols: number, rows: number): Uint8Array => (
  encoder.encode(JSON.stringify({ AuthToken: '', columns: cols, rows, features: FEATURES }))
)

export const parseControlMessage = (payload: Uint8Array): ControlMessage | null => {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(payload))
    if (!value || typeof value !== 'object' || !('type' in value)) return null
    if (value.type === 'heartbeat') return { type: 'heartbeat' }
    if (value.type === 'hello' && 'features' in value && Array.isArray(value.features)
      && value.features.every(feature => typeof feature === 'string')) {
      return { type: 'hello', features: value.features }
    }
    if (value.type === 'closed' && 'reason' in value && typeof value.reason === 'string'
      && 'retry' in value && typeof value.retry === 'boolean') {
      return { type: 'closed', reason: value.reason, retry: value.retry }
    }
  } catch { /* Ignore unknown or malformed controls from a different protocol version. */ }
  return null
}

export const encodeAckMessage = (bytes: number): Uint8Array => (
  encoder.encode(`4${JSON.stringify({ type: 'ack', bytes })}`)
)

export const reconnectDelay = (attempt: number): number => (
  RECONNECT_DELAYS[Math.min(Math.max(attempt - 1, 0), RECONNECT_DELAYS.length - 1)]
)

export const connectTimeout = (attempt: number): number => (
  CONNECT_TIMEOUTS_MS[Math.min(Math.max(attempt, 0), CONNECT_TIMEOUTS_MS.length - 1)]
)

export const createOutputInflater = (onData: (chunk: Uint8Array) => void) => {
  const inflater = new Inflate(chunk => { if (chunk.length) onData(chunk) })
  return { push: (data: Uint8Array): void => inflater.push(data, false) }
}
