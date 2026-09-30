import { describe, expect, it } from 'vitest'
import { encodeTerminalKey, type KeyModifiers } from '../terminal-keys'

const encode = (key: string, modifiers: Partial<KeyModifiers> = {}, applicationCursorKeysMode = false) => encodeTerminalKey({
  key, modifiers: { ctrl: false, alt: false, shift: false, ...modifiers },
}, { applicationCursorKeysMode })

describe('terminal key encoding', () => {
  it.each([
    ['ArrowLeft', { shift: true }, '\x1b[1;2D'],
    ['ArrowRight', { shift: true }, '\x1b[1;2C'],
    ['ArrowUp', { ctrl: true }, '\x1b[1;5A'],
    ['ArrowDown', { ctrl: true, alt: true, shift: true }, '\x1b[1;8B'],
    ['Home', { alt: true }, '\x1b[1;3H'],
    ['End', { ctrl: true, shift: true }, '\x1b[1;6F'],
    ['PageUp', { shift: true }, '\x1b[5;2~'],
    ['Delete', { ctrl: true }, '\x1b[3;5~'],
    ['F1', {}, '\x1bOP'],
    ['F4', { shift: true }, '\x1b[1;2S'],
    ['F5', { shift: true }, '\x1b[15;2~'],
    ['F12', { ctrl: true, alt: true }, '\x1b[24;7~'],
    ['Tab', { shift: true }, '\x1b[Z'],
    ['Enter', { shift: true }, '\x1b[13;2u'],
    ['Enter', { alt: true }, '\x1b\r'],
    ['Backspace', { ctrl: true }, '\b'],
    ['c', { ctrl: true }, '\x03'],
    ['r', { ctrl: true }, '\x12'],
    ['p', { ctrl: true, alt: true }, '\x1b\x10'],
    ['b', { alt: true }, '\x1bb'],
    ['a', { shift: true }, 'A'],
    ['1', { shift: true }, '!'],
    ['/', { shift: true }, '?'],
    ['Space', { ctrl: true }, '\0'],
    ['[', { ctrl: true }, '\x1b'],
    ['\\', { ctrl: true }, '\x1c'],
    [']', { ctrl: true }, '\x1d'],
    ['6', { ctrl: true }, '\x1e'],
    ['_', { ctrl: true }, '\x1f'],
    ['?', { ctrl: true }, '\x7f'],
  ])('encodes %s with %j', (key, modifiers, expected) => {
    expect(encode(key, modifiers)).toEqual({ ok: true, data: expected })
  })

  it('respects application cursor mode without changing modified navigation', () => {
    expect(encode('ArrowLeft')).toEqual({ ok: true, data: '\x1b[D' })
    expect(encode('ArrowLeft', {}, true)).toEqual({ ok: true, data: '\x1bOD' })
    expect(encode('Home', {}, true)).toEqual({ ok: true, data: '\x1bOH' })
    expect(encode('ArrowLeft', { shift: true }, true)).toEqual({ ok: true, data: '\x1b[1;2D' })
  })

  it.each([
    ['Tab', { ctrl: true }], ['Enter', { ctrl: true }], ['p', { ctrl: true, shift: true }],
    ['Escape', { shift: true }], ['9', { ctrl: true }], ['F13', {}], ['paste text', {}],
  ])('rejects %s with %j instead of sending a different shortcut', (key, modifiers) => {
    expect(encode(key, modifiers)).toMatchObject({ ok: false, reason: 'unsupportedKey' })
  })
})
