import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adaptiveConnectTimeout, adaptiveLivenessTimeout, createPollThrottle, getNetworkQuality, isNetworkDegraded,
  recordRttLowerBound, recordRttSample, requestTimeout, resetNetworkQualityForTests, subscribeNetworkQuality,
} from '../network-quality'

describe('network quality', () => {
  beforeEach(() => {
    localStorage.clear()
    resetNetworkQualityForTests()
  })
  afterEach(() => resetNetworkQualityForTests())

  it('keeps every original timeout until a round trip has been measured', () => {
    expect(requestTimeout(3000)).toBe(3000)
    expect(requestTimeout(30000)).toBe(30000)
    expect(adaptiveConnectTimeout(10000)).toBe(10000)
    expect(adaptiveLivenessTimeout(15000)).toBe(15000)
    expect(getNetworkQuality()).toEqual({ rtt: null, degraded: false })
  })

  it('barely changes timeouts on a fast link', () => {
    for (let i = 0; i < 20; i++) recordRttSample(60)
    expect(requestTimeout(3000)).toBeLessThan(4000)
    expect(adaptiveConnectTimeout(10000)).toBe(10000)
    expect(adaptiveLivenessTimeout(15000)).toBeLessThan(16000)
    expect(isNetworkDegraded()).toBe(false)
  })

  it('stretches timeouts on a multi-second VPN link, within caps', () => {
    for (let i = 0; i < 20; i++) recordRttSample(i % 2 ? 3000 : 8000)
    expect(isNetworkDegraded()).toBe(true)
    expect(requestTimeout(3000)).toBeGreaterThan(20000)
    expect(requestTimeout(3000)).toBeLessThanOrEqual(60000)
    expect(requestTimeout(90000)).toBe(90000)
    expect(adaptiveConnectTimeout(10000)).toBeGreaterThan(20000)
    expect(adaptiveConnectTimeout(10000)).toBeLessThanOrEqual(60000)
    expect(adaptiveLivenessTimeout(15000)).toBeLessThanOrEqual(45000)
  })

  it('raises the estimate as soon as a probe is overdue and ignores early lower bounds', () => {
    recordRttSample(100)
    recordRttLowerBound(50)
    expect(getNetworkQuality().rtt).toBe(100)
    recordRttLowerBound(4000)
    expect(getNetworkQuality()).toEqual({ rtt: 4000, degraded: true })
  })

  it('notifies subscribers only when the visible snapshot changes', () => {
    let calls = 0
    const unsubscribe = subscribeNetworkQuality(() => { calls += 1 })
    recordRttSample(100)
    recordRttSample(100)
    expect(calls).toBe(1)
    unsubscribe()
    recordRttSample(5000)
    expect(calls).toBe(1)
  })

  it('ignores invalid samples', () => {
    recordRttSample(Number.NaN)
    recordRttSample(-1)
    expect(getNetworkQuality().rtt).toBeNull()
  })

  it('persists the estimate so a reload starts with the right timeouts', async () => {
    recordRttSample(5000)
    expect(JSON.parse(localStorage.getItem('net_rtt_estimate') ?? 'null')).toMatchObject({ srtt: 5000 })
    vi.resetModules()
    const reloaded = await import('../network-quality')
    expect(reloaded.getNetworkQuality()).toEqual({ rtt: 5000, degraded: true })
  })

  it('ignores a stale stored estimate', async () => {
    localStorage.setItem('net_rtt_estimate', JSON.stringify({ srtt: 5000, rttvar: 100, at: Date.now() - 11 * 60 * 1000 }))
    vi.resetModules()
    const reloaded = await import('../network-quality')
    expect(reloaded.getNetworkQuality().rtt).toBeNull()
    expect(reloaded.requestTimeout(3000)).toBe(3000)
  })

  it('polls every tick when healthy and every fourth tick when degraded', () => {
    const shouldPoll = createPollThrottle()
    expect([shouldPoll(), shouldPoll()]).toEqual([true, true])
    for (let i = 0; i < 5; i++) recordRttSample(5000)
    expect(Array.from({ length: 8 }, () => shouldPoll())).toEqual([false, false, false, true, false, false, false, true])
  })
})
