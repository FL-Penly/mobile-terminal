import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import promptBoardHtml from '../../public/prompt-board.html?raw'

const TEMPLATE = '模板正文：全方面严谨测试，确保功能没问题'

const createConfig = () => ({
  commands: [],
  presets: [],
  presetGroups: [{
    id: 'goal',
    label: 'goal',
    presets: [
      { label: '出GOAL', text: TEMPLATE },
      { label: '另一个', text: '另一个正文' },
    ],
  }],
  activePresetGroupId: 'goal',
})

type Config = ReturnType<typeof createConfig>

const createServer = () => {
  let saved: Config = createConfig()
  const posts: Config[] = []
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      saved = JSON.parse(String(init.body))
      posts.push(saved)
      return new Response('{}', { status: 200 })
    }
    return new Response(JSON.stringify(saved), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return { fetchMock, posts, savedText: (i = 0) => saved.presetGroups[0].presets[i]?.text }
}

const loadPromptBoard = async (fetchMock: ReturnType<typeof vi.fn>) => {
  const script = promptBoardHtml.match(/<script>([\s\S]*)<\/script>/)?.[1]
  if (!script) throw new Error('Prompt 库脚本缺失')

  document.open()
  document.write(promptBoardHtml.replace(/<script>[\s\S]*<\/script>/, ''))
  document.close()
  vi.stubGlobal('fetch', fetchMock)
  // 包一层函数作用域，同一个文件里多次加载时顶层 const 不会重复声明。
  window.eval(`(() => {${script}\n})()`)

  await waitFor(() => {
    expect(document.querySelector('.detail textarea.prompt-text')).not.toBeNull()
  })
}

const editor = () => document.querySelector<HTMLTextAreaElement>('.detail textarea.prompt-text')!
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.detail button')]
  .find(btn => btn.textContent === text)!
const typeDraft = (value: string) => fireEvent.input(editor(), { target: { value } })

describe('Prompt 库「使用」模式的临时改动', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('临时改动不写回模板，复制用改动后的内容，刷新后还在，重置后回到模板', async () => {
    const server = createServer()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await loadPromptBoard(server.fetchMock)

    typeDraft(`${TEMPLATE}\n这次补充：部署到 ppe_fl_dev4`)
    fireEvent.change(editor())
    fireEvent.click(button('复制内容'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${TEMPLATE}\n这次补充：部署到 ppe_fl_dev4`))
    expect(server.posts).toHaveLength(0)
    expect(document.querySelector('.prompt-row.active .draft-badge')).not.toBeNull()

    await loadPromptBoard(server.fetchMock)
    expect(editor()).toHaveValue(`${TEMPLATE}\n这次补充：部署到 ppe_fl_dev4`)

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(button('重置为模板'))
    expect(editor()).toHaveValue(TEMPLATE)
    expect(document.querySelector('.draft-badge')).toBeNull()
    expect(server.posts).toHaveLength(0)
  })

  it('写回模板需要确认，确认后才保存', async () => {
    const server = createServer()
    await loadPromptBoard(server.fetchMock)
    typeDraft('改过的正文')

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(button('写回模板'))
    expect(server.posts).toHaveLength(0)

    confirmSpy.mockReturnValue(true)
    fireEvent.click(button('写回模板'))
    await waitFor(() => expect(server.posts).toHaveLength(1))
    expect(server.savedText()).toBe('改过的正文')
    expect(document.querySelector('.draft-badge')).toBeNull()
  })

  it('另存为新 prompt 时原模板不变', async () => {
    const server = createServer()
    await loadPromptBoard(server.fetchMock)
    typeDraft('这次的变体')
    vi.spyOn(window, 'prompt').mockReturnValue('出GOAL（dev4）')

    fireEvent.click(button('另存为新 prompt'))

    await waitFor(() => expect(server.posts).toHaveLength(1))
    expect(server.posts[0].presetGroups[0].presets).toEqual([
      { label: '出GOAL', text: TEMPLATE },
      { label: '出GOAL（dev4）', text: '这次的变体' },
      { label: '另一个', text: '另一个正文' },
    ])
    expect(document.querySelector('.detail-title')).toHaveTextContent('出GOAL（dev4）')
    expect(document.querySelector('.draft-badge')).toBeNull()
  })

  it('「编辑模板」模式下改动直接保存到模板，切换 prompt 后回到「使用」', async () => {
    const server = createServer()
    await loadPromptBoard(server.fetchMock)

    fireEvent.click(document.querySelector<HTMLButtonElement>('.detail-mode button[data-mode="edit"]')!)
    fireEvent.input(editor(), { target: { value: '直接改模板' } })
    fireEvent.change(editor())

    await waitFor(() => expect(server.posts).toHaveLength(1))
    expect(server.savedText()).toBe('直接改模板')

    fireEvent.click(document.querySelectorAll<HTMLElement>('.prompt-row')[1])
    expect(document.querySelector('.detail-mode button.active')).toHaveAttribute('data-mode', 'use')
  })
})
