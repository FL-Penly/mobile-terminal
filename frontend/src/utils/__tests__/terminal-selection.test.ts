import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachCopyOnSelect } from '../terminal-selection'
import { copyTextToClipboard } from '../dump-file'

vi.mock('../dump-file', () => ({ copyTextToClipboard: vi.fn(async () => true) }))

const disposals: (() => void)[] = []
const setup = () => {
  const host = document.createElement('div')
  document.body.append(host)
  const state = { text: '', enabled: true, target: 'p1' }
  let change = () => {}
  const onFailure = vi.fn()
  disposals.push(attachCopyOnSelect(host, {
    getSelection: () => state.text,
    onSelectionChange: listener => {
      change = () => listener()
      return { dispose: () => {} }
    },
  }, { enabled: () => state.enabled, target: () => state.target, onFailure }))
  const down = () => host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  const up = () => window.dispatchEvent(new MouseEvent('mouseup'))
  const select = () => { state.text = 'hello 世界'; change() }
  return { state, down, up, select, onFailure }
}

afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose())
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('copy on local selection', () => {
  it('copies on release outside the terminal, never during drag', () => {
    const { down, up, select } = setup()
    down(); select()
    expect(copyTextToClipboard).not.toHaveBeenCalled()
    up()
    expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith('hello 世界')
    up()
    expect(copyTextToClipboard).toHaveBeenCalledTimes(1)
  })

  it.each(['disabled', 'pane changed', 'blur', 'empty', 'no selection change'])(
    'does not copy when %s', reason => {
      const { state, down, up, select } = setup()
      down()
      if (reason !== 'no selection change') select()
      if (reason === 'disabled') state.enabled = false
      if (reason === 'pane changed') state.target = 'p2'
      if (reason === 'blur') window.dispatchEvent(new Event('blur'))
      if (reason === 'empty') state.text = ''
      up()
      expect(copyTextToClipboard).not.toHaveBeenCalled()
    },
  )

  it('reports denied clipboard writes', async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValueOnce(false)
    const { down, up, select, onFailure } = setup()
    down(); select(); up()
    await Promise.resolve()
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it('stops copying after unmount', () => {
    const { down, up, select } = setup()
    down(); select()
    disposals.splice(0).forEach(dispose => dispose())
    up()
    expect(copyTextToClipboard).not.toHaveBeenCalled()
  })
})
