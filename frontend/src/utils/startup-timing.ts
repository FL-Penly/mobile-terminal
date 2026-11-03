type StartupStage = 'entry' | 'react-mounted' | 'ws-start' | 'ws-open' | 'first-output'

const stages = ['html-shell', 'entry', 'react-mounted', 'ws-start', 'ws-open', 'first-output'] as const
const milliseconds = (value: number) => Math.round(value * 10) / 10

// No probes, terminal contents, URLs, or user data are collected.
export const getStartupTimings = () => {
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  return {
    navigation: navigation ? {
      type: navigation.type,
      beforeRequestMs: milliseconds(navigation.requestStart),
      connectionMs: milliseconds(navigation.connectEnd - navigation.connectStart),
      firstByteMs: milliseconds(navigation.responseStart),
      requestToFirstByteMs: milliseconds(navigation.responseStart - navigation.requestStart),
      downloadMs: navigation.responseEnd > 0
        ? milliseconds(navigation.responseEnd - navigation.responseStart) : null,
      transferBytes: navigation.transferSize,
      decodedBytes: navigation.decodedBodySize,
    } : null,
    // Absolute offsets from navigation start, not durations between stages.
    milestonesMs: Object.fromEntries(stages.map(stage => {
      const mark = performance.getEntriesByName(`vibeterm:${stage}`, 'mark')[0]
      return [stage, mark ? milliseconds(mark.startTime) : null]
    })),
  }
}

declare global {
  interface Window {
    vibetermStartup: typeof getStartupTimings
  }
}

export const markStartup = (stage: StartupStage) => {
  const name = `vibeterm:${stage}`
  if (performance.getEntriesByName(name, 'mark').length > 0) return
  performance.mark(name)
  if (stage === 'react-mounted' || stage === 'first-output') {
    const report = getStartupTimings()
    try {
      sessionStorage.setItem('vibeterm:last-startup', JSON.stringify(report))
    } catch { /* Diagnostics must not prevent startup when storage is unavailable. */ }
    if (performance.now() > 5000) console.warn('[Startup] Slow startup:', report)
  }
}

window.vibetermStartup = getStartupTimings
