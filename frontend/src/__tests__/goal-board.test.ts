import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import goalBoardHtml from '../../public/goal-board.html?raw'

describe('Goal 工作台编辑入口', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('只在点击打开编辑按钮时打开大编辑器', async () => {
    const script = goalBoardHtml.match(/<script>([\s\S]*)<\/script>/)?.[1]
    if (!script) throw new Error('Goal 工作台脚本缺失')

    document.open()
    document.write(goalBoardHtml.replace(/<script>[\s\S]*<\/script>/, ''))
    document.close()

    const workspace = {
      version: 1,
      templates: [],
      workingCopies: [{
        id: 'copy-test',
        sourceTemplateId: 'template-test',
        sourceTemplateTitle: '测试母版',
        title: '测试副本',
        variables: [
          { name: 'TEST_ENV', value: 'BOECN' },
          { name: 'TEST_HINTS', value: '大段测试内容' },
        ],
        body: '完整 Goal 正文',
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      }],
      activeItem: { kind: 'copy', id: 'copy-test' },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(workspace), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    window.eval(script)

    await waitFor(() => {
      expect(document.querySelectorAll('.expand-editor')).toHaveLength(3)
    })
    const modal = document.getElementById('editor-modal')
    const hintsTextarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="TEST_HINTS 的值"]')
    expect(modal).toHaveAttribute('aria-hidden', 'true')
    expect(hintsTextarea).not.toBeNull()
    expect([...document.querySelectorAll<HTMLButtonElement>('.expand-editor')]
      .every(button => button.textContent === '打开编辑')).toBe(true)

    fireEvent.click(hintsTextarea!)
    expect(modal).toHaveAttribute('aria-hidden', 'true')

    const hintsOpenButton = hintsTextarea!
      .closest('[data-copy-variable-index]')
      ?.querySelector<HTMLButtonElement>('[data-expand-variable]')
    expect(hintsOpenButton).not.toBeNull()
    fireEvent.click(hintsOpenButton!)
    expect(modal).toHaveAttribute('aria-hidden', 'false')
  })
})
