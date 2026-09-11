import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import goalBoardHtml from '../../public/goal-board.html?raw'

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

const loadGoalBoard = async (fetchMock: ReturnType<typeof vi.fn>) => {
  const script = goalBoardHtml.match(/<script>([\s\S]*)<\/script>/)?.[1]
  if (!script) throw new Error('Goal 工作台脚本缺失')

  document.open()
  document.write(goalBoardHtml.replace(/<script>[\s\S]*<\/script>/, ''))
  document.close()
  vi.stubGlobal('fetch', fetchMock)
  window.eval(script)

  await waitFor(() => {
    expect(document.querySelectorAll('.expand-editor')).toHaveLength(3)
  })
}

describe('Goal 工作台编辑入口', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('只在点击打开编辑按钮时打开大编辑器', async () => {
    await loadGoalBoard(vi.fn(async () => new Response(JSON.stringify(workspace), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
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

  it('落盘完整 Goal 并复制返回的绝对路径', async () => {
    const path = '/Users/test/promptgoal/attachments/copy-test/20260831-120000-000.md'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/goal-dump') {
        return new Response(JSON.stringify({ path }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(workspace), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    await loadGoalBoard(fetchMock)

    fireEvent.click(document.getElementById('dump-goal')!)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(path))
    const dumpCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/goal-dump')
    expect(dumpCall).toBeDefined()
    expect(dumpCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(dumpCall?.[1]?.body))).toEqual({
      workingCopyId: 'copy-test',
      text: '【变量区】\nTEST_ENV = BOECN\nTEST_HINTS = 大段测试内容\n\n【执行区】\n完整 Goal 正文',
    })
    expect(document.getElementById('dump-feedback')).toHaveTextContent('完整 Goal 已落盘，路径已复制。')
    expect(document.getElementById('dump-feedback')).toHaveTextContent(path)
    expect(document.getElementById('dump-goal')).toBeEnabled()
  })

  it('落盘失败时保留当前 Goal 并允许重试', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/goal-dump') {
        return new Response(JSON.stringify({ message: '磁盘写入失败' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(workspace), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await loadGoalBoard(fetchMock)

    fireEvent.click(document.getElementById('dump-goal')!)

    await waitFor(() => {
      expect(document.getElementById('dump-feedback')).toHaveTextContent('磁盘写入失败，完整 Goal 未落盘，可重试。')
    })
    expect(document.getElementById('copy-body')).toHaveValue('完整 Goal 正文')
    expect(document.getElementById('dump-goal')).toBeEnabled()
  })
})

const installClipboard = (writeText = vi.fn(async (_text: string) => undefined)) => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}

const createWorkspaceServer = () => {
  let saved = JSON.parse(JSON.stringify(workspace))
  const writes: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/goal-dump') {
      writes.push(JSON.parse(String(init?.body)).text)
      return new Response(JSON.stringify({ path: `/tmp/goals/file-${writes.length}.md` }))
    }
    if (init?.method === 'POST') saved = JSON.parse(String(init.body))
    return new Response(JSON.stringify(saved))
  })
  return { fetchMock, writes, saved: () => saved }
}

describe('Goal 移动工作流', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('在全屏编辑器中提取全文并撤销，附件仍随副本持久化', async () => {
    const server = createWorkspaceServer()
    await loadGoalBoard(server.fetchMock)
    fireEvent.click(document.querySelector('[data-expand-variable="1"]')!)
    fireEvent.click(document.getElementById('editor-dump-all')!)
    await waitFor(() => expect(document.getElementById('expanded-editor')).toHaveValue('/tmp/goals/file-1.md'))
    expect(server.writes).toEqual(['大段测试内容'])
    await waitFor(() => expect(document.getElementById('editor-undo')).toBeEnabled())
    fireEvent.click(document.getElementById('editor-undo')!)
    expect(document.getElementById('expanded-editor')).toHaveValue('大段测试内容')
    expect(document.getElementById('copy-body')).toHaveValue('完整 Goal 正文')
    await waitFor(() => expect(server.saved().workingCopies[0].variables[1].value).toBe('大段测试内容'))
    expect(server.saved().workingCopies[0].files).toEqual([expect.objectContaining({ kind: 'attachment', path: '/tmp/goals/file-1.md', label: 'TEST_HINTS' })])
    fireEvent.click(document.getElementById('close-expanded-editor')!)
    expect(document.querySelector('.layout')).not.toHaveAttribute('inert')
  })

  it('保留提取请求期间的新输入，不用旧选区覆盖内容', async () => {
    const server = createWorkspaceServer()
    let finishDump: ((response: Response) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/goal-dump') return new Promise<Response>(resolve => { finishDump = resolve })
      return server.fetchMock(input, init)
    })
    await loadGoalBoard(fetchMock)
    fireEvent.click(document.querySelector('[data-expand-variable="1"]')!)
    fireEvent.click(document.getElementById('editor-dump-all')!)
    await waitFor(() => expect(finishDump).toBeDefined())
    fireEvent.input(document.getElementById('expanded-editor')!, { target: { value: '请求期间继续输入的内容' } })
    finishDump?.(new Response(JSON.stringify({ path: '/tmp/goals/earlier-selection.md' })))
    await waitFor(() => expect(document.getElementById('editor-feedback')).toHaveTextContent('保留最新内容'))
    expect(document.getElementById('expanded-editor')).toHaveValue('请求期间继续输入的内容')
    expect(document.getElementById('editor-undo')).toBeDisabled()
    await waitFor(() => expect(server.saved().workingCopies[0].files).toHaveLength(1))
  })

  it('修改参数后文件标记过期，重新生成和刷新保留各版本', async () => {
    const server = createWorkspaceServer()
    installClipboard()
    await loadGoalBoard(server.fetchMock)
    fireEvent.click(document.getElementById('dump-goal')!)
    await waitFor(() => expect(document.getElementById('dump-feedback')).toHaveTextContent('路径已复制'))
    expect(document.getElementById('file-list')).toHaveTextContent('与当前内容一致')
    fireEvent.input(document.querySelector('textarea[aria-label="TEST_ENV 的值"]')!, { target: { value: 'PPE' } })
    expect(document.getElementById('file-list')).toHaveTextContent('内容已修改，请重新落盘')
    fireEvent.click(document.getElementById('regenerate-goal')!)
    await waitFor(() => expect(server.saved().workingCopies[0].files).toHaveLength(2))
    await waitFor(() => expect(document.getElementById('regenerate-goal')).toBeEnabled())
    fireEvent.click(document.getElementById('reload')!)
    await waitFor(() => expect(document.getElementById('status')).toHaveTextContent('已加载'))
    expect(document.getElementById('file-list')).toHaveTextContent('版本 2')
    expect(document.getElementById('file-list')).toHaveTextContent('版本 1')
    expect(document.getElementById('file-list')).toHaveTextContent('与当前内容一致')
    expect(server.writes[1]).toContain('TEST_ENV = PPE')
  })

  it('复制被浏览器拒绝时给出完整的手动复制原文', async () => {
    const server = createWorkspaceServer()
    installClipboard(vi.fn(async () => { throw new Error('Clipboard blocked') }))
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await loadGoalBoard(server.fetchMock)
    fireEvent.click(document.getElementById('copy-goal')!)
    await waitFor(() => expect(document.getElementById('result-modal')).toHaveAttribute('aria-hidden', 'false'))
    expect(document.getElementById('result-text')).toHaveValue('【变量区】\nTEST_ENV = BOECN\nTEST_HINTS = 大段测试内容\n\n【执行区】\n完整 Goal 正文')
    fireEvent.click(document.getElementById('select-result')!)
    const text = document.getElementById('result-text') as HTMLTextAreaElement
    expect(text.selectionEnd - text.selectionStart).toBe(text.value.length)
  })
})
