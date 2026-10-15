import type { TranscriptBlock } from './transcript-api'

export type CopyFormat = 'raw' | 'strip' | 'markdown' | 'oneLine'

export const COPY_FORMATS: { id: CopyFormat; label: string }[] = [
  { id: 'raw', label: '原样' },
  { id: 'strip', label: '去掉前缀' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'oneLine', label: '合并成一行' },
]

// Shell prompts: "➜  repo git:(main) ", "user@host:~/dir$ ", "$ ", "% ", "❯ ".
const SHELL_PROMPT_RE = /^\s*(?:➜\s+\S+(?:\s+git:\([^)]*\))?\s+✗?\s*|\S+@\S+?[:\s]\S*\s*[$%#]\s|[$%❯›λ]\s+)/
// Agent UI decorations that sit before the content: Claude's ⏺ ⎿ ✻ and quote/box rules.
const DECORATION_RE = /^(\s*)(?:[⏺⎿✻●•│┃▌>]\s?)+/
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff]/
const CJK_PUNCTUATION_RE = /[\u3000-\u303f\uff00-\uffef]/

const isPromptLine = (line: string) => SHELL_PROMPT_RE.test(line)

export const stripLinePrefixes = (text: string): string => {
  const lines = text.split('\n').map(line => {
    if (isPromptLine(line)) return { prompt: true, text: line.replace(SHELL_PROMPT_RE, '') }
    // Keep the decoration's width so indentation under it survives the dedent below.
    const stripped = line.replace(DECORATION_RE, (match, indent: string) => indent + ' '.repeat(match.length - indent.length))
    return { prompt: false, text: stripped.replace(/\s+$/, '') }
  })
  const indents = lines
    .filter(line => !line.prompt && line.text.trim() !== '')
    .map(line => line.text.length - line.text.trimStart().length)
  const dedent = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map(line => (line.prompt ? line.text : line.text.slice(dedent))).join('\n')
}

const fenceFor = (text: string): string => {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length))
  return '`'.repeat(longest + 1)
}

export const toMarkdownCode = (text: string, lang = ''): string => {
  const fence = fenceFor(text)
  return `${fence}${lang}\n${text}\n${fence}`
}

// Chinese text and full-width punctuation rejoin without a space; other text gets one.
export const toOneLine = (text: string): string => text
  .split(/\s*\n\s*/)
  .filter(part => part !== '')
  .reduce((joined, part) => {
    if (!joined) return part
    const left = joined[joined.length - 1]
    const right = part[0]
    const tight = (CJK_RE.test(left) && CJK_RE.test(right))
      || CJK_PUNCTUATION_RE.test(left)
      || CJK_PUNCTUATION_RE.test(right)
    return joined + (tight ? '' : ' ') + part
  }, '')
  .replace(/[ \t]+/g, ' ')
  .trim()

export const formatTerminalText = (lines: string[], format: CopyFormat): string => {
  const raw = lines.join('\n')
  switch (format) {
    case 'raw': return raw
    case 'strip': return stripLinePrefixes(raw)
    case 'markdown': return toMarkdownCode(stripLinePrefixes(raw))
    case 'oneLine': return toOneLine(stripLinePrefixes(raw))
  }
}

const blockRaw = (block: TranscriptBlock): string => {
  switch (block.kind) {
    case 'user':
    case 'assistant':
    case 'code':
      return block.text
    case 'command':
      return block.output ? `$ ${block.command}\n${block.output}` : `$ ${block.command}`
    case 'tool':
      return block.summary ? `${block.name} ${block.summary}` : block.name
  }
}

const blockStripped = (block: TranscriptBlock): string => {
  if (block.kind !== 'command') return blockRaw(block)
  return block.output ? `${block.command}\n${block.output}` : block.command
}

const blockMarkdown = (block: TranscriptBlock): string => {
  switch (block.kind) {
    case 'user':
      return block.text.split('\n').map(line => `> ${line}`).join('\n')
    case 'assistant':
      return block.text
    case 'code':
      return toMarkdownCode(block.text, block.lang)
    case 'command':
      return toMarkdownCode(blockRaw(block), 'bash')
    case 'tool':
      return `\`${blockRaw(block)}\``
  }
}

export const formatBlocks = (blocks: TranscriptBlock[], format: CopyFormat): string => {
  switch (format) {
    case 'raw': return blocks.map(blockRaw).join('\n\n')
    case 'strip': return blocks.map(blockStripped).join('\n\n')
    case 'markdown': return blocks.map(blockMarkdown).join('\n\n')
    case 'oneLine': return toOneLine(blocks.map(blockStripped).join('\n'))
  }
}

export const countLines = (text: string): number => (text === '' ? 0 : text.split('\n').length)

export const quoteForInput = (text: string): string =>
  `${text.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n')}\n\n`

export const askAgentPrompt = (text: string): string => `请解释或处理下面这段内容：\n\n${text}`
