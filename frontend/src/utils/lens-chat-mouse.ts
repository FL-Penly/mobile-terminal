const WHEEL_LINE_PX = 16
const WHEEL_PAGE_PX = 400
const WHEEL_STEP_PX = 40

export const sgrClick = (col: number, row: number) => `\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`

export class WheelStepper {
  private pending = 0

  steps(deltaY: number, deltaMode: number): Array<'up' | 'down'> {
    const scale = deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? WHEEL_PAGE_PX : 1
    this.pending += deltaY * scale
    const out: Array<'up' | 'down'> = []
    while (Math.abs(this.pending) >= WHEEL_STEP_PX) {
      const direction = this.pending > 0 ? 'down' : 'up'
      this.pending -= direction === 'down' ? WHEEL_STEP_PX : -WHEEL_STEP_PX
      out.push(direction)
    }
    return out
  }
}
