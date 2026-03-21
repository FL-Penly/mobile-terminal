type ReadLine = (row: number) => string

const MIN_OVERLAP_LINES = 2

export class AltScreenTranscript {
  private transcript: string[] = []
  private lastFrame: string[] = []
  private viewStart = 0
  private active = false
  private captureTimer: number | null = null

  getLines(): string[] {
    return this.transcript
  }

  isActive(): boolean {
    return this.active
  }

  onEnterAltBuffer(): void {
    this.active = true
    this.transcript = []
    this.lastFrame = []
    this.viewStart = 0
  }

  onLeaveAltBuffer(): void {
    this.active = false
  }

  // Debounced: call after onWriteParsed / onRender when in alt buffer
  scheduleCaptureFrame(rows: number, readLine: ReadLine): void {
    if (!this.active) return
    if (this.captureTimer !== null) cancelAnimationFrame(this.captureTimer)
    this.captureTimer = requestAnimationFrame(() => {
      this.captureTimer = null
      this.captureFrame(rows, readLine)
    })
  }

  private captureFrame(rows: number, readLine: ReadLine): void {
    const frame: string[] = []
    for (let y = 0; y < rows; y++) {
      frame.push(readLine(y))
    }

    if (this.lastFrame.length === 0) {
      this.transcript = [...frame]
      this.lastFrame = frame
      this.viewStart = 0
      return
    }

    if (framesEqual(this.lastFrame, frame)) return

    const offset = findScrollOffset(this.lastFrame, frame)

    if (offset !== 0) {
      this.viewStart += offset

      if (this.viewStart < 0) {
        const newLines = frame.slice(0, -this.viewStart)
        this.transcript.unshift(...newLines)
        this.viewStart = 0
      }

      const viewEnd = this.viewStart + frame.length
      if (viewEnd > this.transcript.length) {
        const newCount = viewEnd - this.transcript.length
        this.transcript.push(...frame.slice(frame.length - newCount))
      }
    } else {
      this.transcript = [...frame]
      this.viewStart = 0
    }

    this.lastFrame = frame
  }

  dispose(): void {
    if (this.captureTimer !== null) cancelAnimationFrame(this.captureTimer)
  }
}

function framesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// Returns positive for scroll-down, negative for scroll-up, 0 for no detected scroll.
// Scroll DOWN: prev content moved UP, new lines at bottom.
//   prev=[A,B,C,D,E] curr=[C,D,E,X,Y] → prev[2]=curr[0] → offset=+2
// Scroll UP: prev content moved DOWN, new lines at top.
//   prev=[C,D,E,F,G] curr=[A,B,C,D,E] → curr[2]=prev[0] → offset=-2
function findScrollOffset(prev: string[], curr: string[]): number {
  const len = prev.length

  // Scroll DOWN: find smallest offset where prev[offset..] matches curr[0..]
  for (let offset = 1; offset < len; offset++) {
    const matchLen = len - offset
    if (matchLen < MIN_OVERLAP_LINES) break
    if (regionMatches(prev, offset, curr, 0, matchLen)) return offset
  }

  // Scroll UP: find smallest offset where curr[offset..] matches prev[0..]
  for (let offset = 1; offset < len; offset++) {
    const matchLen = len - offset
    if (matchLen < MIN_OVERLAP_LINES) break
    if (regionMatches(curr, offset, prev, 0, matchLen)) return -offset
  }

  return 0
}

function regionMatches(a: string[], aStart: number, b: string[], bStart: number, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (a[aStart + i] !== b[bStart + i]) return false
  }
  return true
}
