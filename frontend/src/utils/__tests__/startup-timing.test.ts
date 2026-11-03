import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStartupTimings, markStartup } from '../startup-timing'

afterEach(() => {
  for (const stage of ['entry', 'react-mounted', 'ws-open', 'first-output']) {
    performance.clearMarks(`vibeterm:${stage}`)
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('startup diagnostics', () => {
  it('keeps the first connection milestone across reconnects', () => {
    markStartup('ws-open')
    const first = getStartupTimings().milestonesMs['ws-open']
    markStartup('ws-open')
    expect(getStartupTimings().milestonesMs['ws-open']).toBe(first)
    expect(performance.getEntriesByName('vibeterm:ws-open')).toHaveLength(1)
    expect(getStartupTimings().milestonesMs['first-output']).toBeNull()
  })

  it('does not interrupt startup when diagnostic storage is unavailable', () => {
    const setItem = vi.fn(() => { throw new Error('storage denied') })
    vi.stubGlobal('sessionStorage', { setItem })
    expect(() => markStartup('react-mounted')).not.toThrow()
    expect(setItem).toHaveBeenCalled()
    expect(getStartupTimings().milestonesMs['react-mounted']).not.toBeNull()
  })

  it('separates connection, request wait and download without retaining the URL', () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{
      entryType: 'navigation', name: 'http://example.test/private?token=secret', type: 'navigate',
      connectStart: 10, connectEnd: 30, requestStart: 40, responseStart: 140,
      responseEnd: 640, transferSize: 500, decodedBodySize: 1000,
    } as PerformanceNavigationTiming])
    const report = getStartupTimings()
    expect(report.navigation).toMatchObject({
      beforeRequestMs: 40, connectionMs: 20, firstByteMs: 140,
      requestToFirstByteMs: 100, downloadMs: 500,
    })
    expect(JSON.stringify(report)).not.toContain('secret')
  })
})
