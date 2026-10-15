import { describe, expect, it } from 'vitest'

import { isCommandLine, isErrorLine, readLogicalLines, trimTrailingBlankLines, type BufferLike, type BufferLineLike } from '../copy-lines'

const COLS = 10

// Builds rows the way xterm stores them: fixed-width cells, `isWrapped` on continuation rows.
const row = (text: string, isWrapped = false, emptyLastCell = false): BufferLineLike => {
  // `text` is what translateToString(false) yields; a null last cell renders as one space.
  const full = emptyLastCell ? `${text} ` : text.padEnd(COLS, ' ')
  return {
    isWrapped,
    length: COLS,
    translateToString: (trimRight?: boolean) => (trimRight ? full.replace(/\s+$/, '') : full),
    getCell: (x: number) => ({ getChars: () => (emptyLastCell && x === COLS - 1 ? '' : 'x') }),
  }
}

const buffer = (rows: BufferLineLike[]): BufferLike => ({ length: rows.length, getLine: y => rows[y] })

describe('readLogicalLines', () => {
  it('joins soft-wrapped rows back into one line', () => {
    const lines = readLogicalLines(buffer([
      row('$ echo'),
      row('https://ex'),
      row('ample.com/', true),
      row('a?b=1', true),
      row('done'),
    ]))
    expect(lines).toEqual(['$ echo', 'https://example.com/a?b=1', 'done'])
  })

  it('keeps spaces that fall exactly on the wrap boundary', () => {
    const lines = readLogicalLines(buffer([row('hello wor '), row('ld', true)]))
    expect(lines).toEqual(['hello wor ld'])
  })

  it('drops the blank cell left when a wide character did not fit', () => {
    const lines = readLogicalLines(buffer([row('中文中文a', false, true), row('句子', true)]))
    expect(lines).toEqual(['中文中文a句子'])
  })

  it('treats a wrapped first row as the start of a line and honours the range', () => {
    const rows = [row('tail', true), row('one'), row('two'), row('three')]
    expect(readLogicalLines(buffer(rows))).toEqual(['tail', 'one', 'two', 'three'])
    expect(readLogicalLines(buffer(rows), 1, 2)).toEqual(['one', 'two'])
  })

  it('does not join across the end of the requested range', () => {
    const rows = [row('abcdefghij'), row('klm', true)]
    expect(readLogicalLines(buffer(rows), 0, 0)).toEqual(['abcdefghij'])
  })
})

describe('line helpers', () => {
  it('trims only trailing blank lines', () => {
    expect(trimTrailingBlankLines(['', 'a', '', ' ', ''])).toEqual(['', 'a'])
    const untouched = ['a']
    expect(trimTrailingBlankLines(untouched)).toBe(untouched)
  })

  it('recognises prompts and error lines', () => {
    expect(isCommandLine('➜  rust-terminal git:(main) ls')).toBe(true)
    expect(isCommandLine('plain output')).toBe(false)
    expect(isErrorLine('test copy_mode::flag ... FAILED')).toBe(true)
    expect(isErrorLine("error[E0425]: cannot find value `x`")).toBe(true)
    expect(isErrorLine('test result: ok. 3 passed; 0 failed')).toBe(false)
  })
})
