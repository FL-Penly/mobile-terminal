export interface CellLike {
  getChars(): string
}

export interface BufferLineLike {
  readonly isWrapped: boolean
  readonly length: number
  translateToString(trimRight?: boolean): string
  getCell?(x: number): CellLike | undefined
}

export interface BufferLike {
  readonly length: number
  getLine(y: number): BufferLineLike | undefined
}

// Matches $ > % ❯ ➜ # λ → prompt chars, or user@host:path patterns
export const PROMPT_RE = /^\s*[\]$>%❯➜#λ→]\s|^\S+@\S+[:%#$]|\$\s*$/
const ERROR_RE = /FAILED|panicked|Traceback|\bError:|\berror(\[\w+\])?:|ERROR\b/

export const isCommandLine = (line: string): boolean => PROMPT_RE.test(line)
export const isErrorLine = (line: string): boolean => ERROR_RE.test(line)

// A row that wraps keeps its trailing cells, except the blank cell xterm leaves
// when a wide character did not fit at the end of the row.
const wrappedRowText = (line: BufferLineLike): string => {
  const text = line.translateToString(false)
  const last = line.getCell?.(line.length - 1)
  return last && last.getChars() === '' ? text.replace(/ $/, '') : text
}

export const readLogicalLines = (buffer: BufferLike, from = 0, to = buffer.length - 1): string[] => {
  const lines: string[] = []
  let current: string | null = null
  for (let y = Math.max(0, from); y <= Math.min(to, buffer.length - 1); y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    const next = buffer.getLine(y + 1)
    const continues = y < to && next?.isWrapped === true
    const text = continues ? wrappedRowText(line) : line.translateToString(true)
    if (line.isWrapped && current !== null) current += text
    else {
      if (current !== null) lines.push(current)
      current = text
    }
  }
  if (current !== null) lines.push(current)
  return lines
}

export const trimTrailingBlankLines = (lines: string[]): string[] => {
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end--
  return end === lines.length ? lines : lines.slice(0, end)
}
