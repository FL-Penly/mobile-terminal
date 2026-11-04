// Round-trip estimate of the terminal link, fed by WebSocket ping/pong.
//
// Timeouts across the app were tuned for a LAN. Over a congested VPN the round
// trip can reach seconds, so fixed 3s fetch timeouts fail every request, the
// app retries, and the retries compete with keystrokes. Every helper here
// returns the original base value until a slow link has actually been
// measured, so a fast network behaves exactly as before.

const STORAGE_KEY = 'net_rtt_estimate'
const STORAGE_MAX_AGE_MS = 10 * 60 * 1000
const STORAGE_WRITE_INTERVAL_MS = 5000

export const DEGRADED_RTT_MS = 1000
export const VISIBLE_RTT_MS = 300

const MAX_REQUEST_TIMEOUT_MS = 60000
const MAX_CONNECT_TIMEOUT_MS = 60000
const MAX_LIVENESS_TIMEOUT_MS = 45000

export interface NetworkQuality {
  rtt: number | null
  degraded: boolean
}

interface Estimate {
  srtt: number
  rttvar: number
}

let estimate: Estimate | null = null
let snapshot: NetworkQuality = { rtt: null, degraded: false }
let lastStoredAt = 0
const listeners = new Set<() => void>()

const publish = () => {
  const rtt = estimate ? Math.round(estimate.srtt) : null
  const degraded = rtt !== null && rtt >= DEGRADED_RTT_MS
  if (snapshot.rtt === rtt && snapshot.degraded === degraded) return
  snapshot = { rtt, degraded }
  listeners.forEach(listener => listener())
}

const store = (now: number) => {
  if (!estimate || now - lastStoredAt < STORAGE_WRITE_INTERVAL_MS) return
  lastStoredAt = now
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...estimate, at: now }))
  } catch { /* in-memory only */ }
}

const restore = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return
    const { srtt, rttvar, at } = value as Record<string, unknown>
    if (typeof srtt !== 'number' || typeof rttvar !== 'number' || typeof at !== 'number') return
    if (!(srtt >= 0) || !(rttvar >= 0) || Date.now() - at > STORAGE_MAX_AGE_MS) return
    estimate = { srtt, rttvar }
    publish()
  } catch { /* ignore */ }
}

restore()

// Background tabs freeze timers and sockets; a probe spanning that gap measures the freeze.
let lastVisibleSince = 0
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') lastVisibleSince = Date.now()
  })
}

export const isProbeTrustworthy = (sentAt: number): boolean => (
  typeof document === 'undefined'
  || (document.visibilityState === 'visible' && (sentAt >= lastVisibleSince || lastVisibleSince > Date.now()))
)

/** Feeds one measured round trip (RFC 6298 smoothing). */
export const recordRttSample = (ms: number, now = Date.now()): void => {
  if (!Number.isFinite(ms) || ms < 0) return
  if (!estimate) {
    estimate = { srtt: ms, rttvar: ms / 2 }
  } else {
    estimate = {
      rttvar: 0.75 * estimate.rttvar + 0.25 * Math.abs(estimate.srtt - ms),
      srtt: 0.875 * estimate.srtt + 0.125 * ms,
    }
  }
  publish()
  store(now)
}

/**
 * A probe still unanswered after `elapsedMs` proves the round trip is at least
 * that long. Raise the estimate right away so a stalling link is noticed
 * before the late answer arrives.
 */
export const recordRttLowerBound = (elapsedMs: number, now = Date.now()): void => {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return
  if (!estimate) {
    estimate = { srtt: elapsedMs, rttvar: elapsedMs / 2 }
  } else if (elapsedMs > estimate.srtt) {
    estimate = { srtt: elapsedMs, rttvar: Math.max(estimate.rttvar, elapsedMs - estimate.srtt) }
  } else {
    return
  }
  publish()
  store(now)
}

const retransmitTimeout = (): number => (estimate ? estimate.srtt + 4 * estimate.rttvar : 0)

export const requestTimeout = (baseMs: number): number => {
  if (!estimate) return baseMs
  return Math.round(Math.max(baseMs, Math.min(Math.max(baseMs, MAX_REQUEST_TIMEOUT_MS), baseMs + 3 * retransmitTimeout())))
}

export const requestSignal = (baseMs: number): AbortSignal => AbortSignal.timeout(requestTimeout(baseMs))

/** WebSocket open needs a TCP handshake plus the HTTP upgrade: about two round trips. */
export const adaptiveConnectTimeout = (baseMs: number): number => {
  if (!estimate) return baseMs
  const needed = 3 * estimate.srtt + 4 * estimate.rttvar
  return Math.round(Math.max(baseMs, Math.min(MAX_CONNECT_TIMEOUT_MS, needed)))
}

export const adaptiveLivenessTimeout = (baseMs: number): number => {
  if (!estimate) return baseMs
  return Math.round(Math.max(baseMs, Math.min(MAX_LIVENESS_TIMEOUT_MS, baseMs + 2 * retransmitTimeout())))
}

export const isNetworkDegraded = (): boolean => snapshot.degraded

export const getNetworkQuality = (): NetworkQuality => snapshot

export const subscribeNetworkQuality = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const createPollThrottle = (degradedEvery = 4) => {
  let skipped = 0
  return (): boolean => {
    if (!isNetworkDegraded()) {
      skipped = 0
      return true
    }
    skipped += 1
    if (skipped < degradedEvery) return false
    skipped = 0
    return true
  }
}

export const resetNetworkQualityForTests = (): void => {
  estimate = null
  lastStoredAt = 0
  lastVisibleSince = 0
  snapshot = { rtt: null, degraded: false }
  listeners.forEach(listener => listener())
}
