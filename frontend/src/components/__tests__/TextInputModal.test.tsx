import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { InputSendResult } from '../../contexts/TerminalContext'
import { TextInputModal } from '../TextInputModal'

const renderModal = (onSend: (text: string) => InputSendResult, onClose = vi.fn()) => {
  render(
    <TextInputModal
      isOpen
      onClose={onClose}
      onSend={onSend}
      presetGroups={[]}
      activePresetGroupId=""
      onActivePresetGroupChange={vi.fn()}
      onPresetGroupsChange={vi.fn()}
    />,
  )
  return { onClose }
}

describe('TextInputModal reliable send', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('keeps the complete draft open and out of history when sending fails', () => {
    const text = 'START 中文 😀\n\n```md\n完整代码块\n```\nEND'
    const onSend = vi.fn<(text: string) => InputSendResult>(() => ({
      ok: false,
      reason: 'disconnected',
    }))
    const { onClose } = renderModal(onSend)
    const textarea = screen.getByPlaceholderText('Type or paste text...')

    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledWith(text)
    expect(textarea).toHaveValue(text)
    expect(sessionStorage.getItem('ttyd_text_input_draft')).toBe(text)
    expect(localStorage.getItem('ttyd_input_history')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('连接已断开')
  })

  it('clears, closes, and writes history only after a successful send', () => {
    const text = '第一行\n第二行\n最后一行'
    const onSend = vi.fn<(text: string) => InputSendResult>(() => ({
      ok: true,
      byteLength: new TextEncoder().encode(text).byteLength,
    }))
    const { onClose } = renderModal(onSend)
    const textarea = screen.getByPlaceholderText('Type or paste text...')

    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledWith(text)
    expect(textarea).toHaveValue('')
    expect(sessionStorage.getItem('ttyd_text_input_draft')).toBeNull()
    expect(JSON.parse(localStorage.getItem('ttyd_input_history') ?? '[]')).toEqual([text])
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('places the caret after appended preset text', async () => {
    const presetText = 'P3 测试补充信息\nTEST_HINTS = '
    render(
      <TextInputModal
        isOpen
        onClose={vi.fn()}
        onSend={() => ({ ok: true, byteLength: 0 })}
        presetGroups={[{
          id: 'mobile',
          label: '移动完整',
          presets: [{ label: 'TEST_HINTS（末尾填写）', text: presetText }],
        }]}
        activePresetGroupId="mobile"
        onActivePresetGroupChange={vi.fn()}
        onPresetGroupsChange={vi.fn()}
      />,
    )
    const textarea = screen.getByPlaceholderText('Type or paste text...') as HTMLTextAreaElement

    fireEvent.click(screen.getByRole('button', { name: 'TEST_HINTS（末尾填写）' }))

    await waitFor(() => {
      expect(textarea).toHaveFocus()
      expect(textarea.selectionStart).toBe(presetText.length)
      expect(textarea.selectionEnd).toBe(presetText.length)
    })
  })
})
