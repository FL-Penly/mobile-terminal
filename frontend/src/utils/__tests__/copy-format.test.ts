import { describe, expect, it } from 'vitest'

import {
  askAgentPrompt,
  countLines,
  formatBlocks,
  formatTerminalText,
  quoteForInput,
  stripLinePrefixes,
  toMarkdownCode,
  toOneLine,
} from '../copy-format'
import type { TranscriptBlock } from '../transcript-api'

describe('stripLinePrefixes', () => {
  it('removes Claude decorations but keeps relative indentation', () => {
    const text = [
      '⏺ Bash(cargo test)',
      '  ⎿  running 3 tests',
      '     test a ... ok',
      '       nested detail',
    ].join('\n')
    expect(stripLinePrefixes(text)).toBe([
      'Bash(cargo test)',
      '   running 3 tests',
      '   test a ... ok',
      '     nested detail',
    ].join('\n'))
  })

  it('drops shell prompts so commands can be pasted and run', () => {
    expect(stripLinePrefixes('➜  rust-terminal git:(main) git log --oneline -3')).toBe('git log --oneline -3')
    expect(stripLinePrefixes('bytedance@GP7TX6XVXY:~/project$ ls -la')).toBe('ls -la')
    expect(stripLinePrefixes('$ npm test\n> rust-terminal@1.0.0 test')).toBe('npm test\nrust-terminal@1.0.0 test')
    expect(stripLinePrefixes('❯ 帮我看看')).toBe('帮我看看')
  })

  it('leaves undecorated code alone', () => {
    const code = 'fn main() {\n    println!("hi");\n}'
    expect(stripLinePrefixes(code)).toBe(code)
  })
})

describe('toOneLine', () => {
  it('joins wrapped Chinese without spaces and other text with one space', () => {
    expect(toOneLine('修一下复制时长行\n被折断的问题')).toBe('修一下复制时长行被折断的问题')
    expect(toOneLine('cargo test\n  --release\n\n-- copy_mode')).toBe('cargo test --release -- copy_mode')
    expect(toOneLine('MR 已提交：\nhttps://example.com/mr/1')).toBe('MR 已提交：https://example.com/mr/1')
  })
})

describe('markdown fences', () => {
  it('uses a fence longer than any backtick run inside', () => {
    expect(toMarkdownCode('a', 'ts')).toBe('```ts\na\n```')
    expect(toMarkdownCode('```js\nx\n```')).toBe('````\n```js\nx\n```\n````')
  })
})

describe('formatTerminalText', () => {
  const lines = ['⏺ 改好了', '  ⎿  Updated src/a.ts', '➜  demo git:(main) npm test']

  it('produces each format from the same selection', () => {
    expect(formatTerminalText(lines, 'raw')).toBe(lines.join('\n'))
    expect(formatTerminalText(lines, 'strip')).toBe('改好了\n   Updated src/a.ts\nnpm test')
    expect(formatTerminalText(lines, 'markdown')).toBe('```\n改好了\n   Updated src/a.ts\nnpm test\n```')
    expect(formatTerminalText(lines, 'oneLine')).toBe('改好了 Updated src/a.ts npm test')
  })
})

describe('formatBlocks', () => {
  const blocks: TranscriptBlock[] = [
    { kind: 'user', id: 'u', text: '跑一下测试\n再看看' },
    { kind: 'assistant', id: 'a', text: '好的，**马上**。' },
    { kind: 'code', id: 'c', lang: 'rust', text: 'let x = 1;' },
    { kind: 'command', id: 'b', command: 'cargo test', output: 'ok', isError: false, exitCode: 0 },
    { kind: 'tool', id: 't', name: 'Read', summary: 'src/lib.rs' },
  ]

  it('keeps raw markdown and command prompts in raw form', () => {
    expect(formatBlocks(blocks, 'raw')).toBe(
      '跑一下测试\n再看看\n\n好的，**马上**。\n\nlet x = 1;\n\n$ cargo test\nok\n\nRead src/lib.rs',
    )
  })

  it('drops the $ prompt when stripping prefixes', () => {
    expect(formatBlocks([blocks[3]], 'strip')).toBe('cargo test\nok')
  })

  it('fences code and commands for Markdown and quotes the user', () => {
    expect(formatBlocks(blocks, 'markdown')).toBe([
      '> 跑一下测试\n> 再看看',
      '好的，**马上**。',
      '```rust\nlet x = 1;\n```',
      '```bash\n$ cargo test\nok\n```',
      '`Read src/lib.rs`',
    ].join('\n\n'))
  })

  it('merges everything into one line', () => {
    expect(formatBlocks(blocks.slice(0, 2), 'oneLine')).toBe('跑一下测试再看看好的，**马上**。')
  })
})

describe('handing text to the input box and the agent', () => {
  it('quotes every line and leaves the caret on a fresh line', () => {
    expect(quoteForInput('a\n\nb')).toBe('> a\n>\n> b\n\n')
  })

  it('wraps the selection in an explicit request', () => {
    expect(askAgentPrompt('x')).toBe('请解释或处理下面这段内容：\n\nx')
  })

  it('counts lines of the copied text', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a\nb')).toBe(2)
  })
})
