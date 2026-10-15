import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyTextToClipboard } from '../dump-file'

const setClipboard = (writeText: ((text: string) => Promise<void>) | undefined) => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  })
}

describe('copyTextToClipboard', () => {
  let execCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    execCommand = vi.fn()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
  })

  afterEach(() => {
    setClipboard(undefined)
  })

  it('uses the Clipboard API when the browser exposes it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard(writeText)
    await expect(copyTextToClipboard('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to a fully selected textarea over plain HTTP', async () => {
    // Browsers do not expose navigator.clipboard outside secure contexts.
    setClipboard(undefined)
    let selected: { start: number | null; end: number | null; value: string } | null = null
    execCommand.mockImplementation(() => {
      const textarea = document.querySelector('textarea')
      if (textarea) selected = { start: textarea.selectionStart, end: textarea.selectionEnd, value: textarea.value }
      return true
    })
    await expect(copyTextToClipboard('第一行\n第二行')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(selected).toEqual({ start: 0, end: 7, value: '第一行\n第二行' })
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('reports failure when the browser refuses the legacy copy', async () => {
    execCommand.mockReturnValue(false)
    await expect(copyTextToClipboard('x')).resolves.toBe(false)
  })

  it('reports failure when execCommand throws', async () => {
    execCommand.mockImplementation(() => { throw new Error('blocked') })
    await expect(copyTextToClipboard('x')).resolves.toBe(false)
  })

  it('tries the legacy path when the Clipboard API rejects', async () => {
    setClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
    execCommand.mockReturnValue(true)
    await expect(copyTextToClipboard('x')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('restores focus to the element that had it', async () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    execCommand.mockReturnValue(true)
    await copyTextToClipboard('x')
    expect(document.activeElement).toBe(input)
    input.remove()
  })
})
