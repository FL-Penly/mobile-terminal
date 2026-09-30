export interface KeyModifiers {
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export interface TerminalKeystroke {
  key: string
  modifiers: KeyModifiers
}

export interface KeyboardModes {
  applicationCursorKeysMode: boolean
}

export type EncodedKey = { ok: true; data: string } | { ok: false; reason: 'unsupportedKey'; message: string }

const ESC = '\x1b'
const cursorKeys: Record<string, string> = {
  ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F',
}
const tildeKeys: Record<string, number> = {
  Insert: 2, Delete: 3, PageUp: 5, PageDown: 6,
  F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
}
const functionKeys: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' }
const shiftedCharacters: Record<string, string> = Object.fromEntries(
  Array.from('`1234567890-=[]\\;\',./').map((key, index) => [key, '~!@#$%^&*()_+{}|:"<>?'[index]]),
)

// xterm/VT key conventions. Do not invent CSI-u sequences for combinations that
// require negotiated extended-keyboard support. Shift+Enter is the existing
// application compatibility exception used by this project.
export const encodeTerminalKey = ({ key, modifiers }: TerminalKeystroke, modes: KeyboardModes): EncodedKey => {
  const { ctrl, alt, shift } = modifiers
  const modifier = 1 + Number(shift) + 2 * Number(alt) + 4 * Number(ctrl)
  const success = (data: string): EncodedKey => ({ ok: true, data })
  const unsupported = (): EncodedKey => ({
    ok: false,
    reason: 'unsupportedKey',
    message: '当前终端模式无法可靠区分这个组合，未发送。',
  })
  const cursor = Object.prototype.hasOwnProperty.call(cursorKeys, key) ? cursorKeys[key] : undefined
  if (cursor) return success(modifier > 1 ? `${ESC}[1;${modifier}${cursor}` : `${ESC}${modes.applicationCursorKeysMode ? 'O' : '['}${cursor}`)
  const fn = Object.prototype.hasOwnProperty.call(functionKeys, key) ? functionKeys[key] : undefined
  if (fn) return success(modifier > 1 ? `${ESC}[1;${modifier}${fn}` : `${ESC}O${fn}`)
  const tilde = Object.prototype.hasOwnProperty.call(tildeKeys, key) ? tildeKeys[key] : undefined
  if (tilde) return success(`${ESC}[${tilde}${modifier > 1 ? `;${modifier}` : ''}~`)

  let data: string
  switch (key) {
    case 'Tab':
      if (ctrl) return unsupported()
      data = shift ? `${ESC}[Z` : '\t'
      break
    case 'Enter':
      if (ctrl || (shift && alt)) return unsupported()
      data = shift ? `${ESC}[13;2u` : '\r'
      break
    case 'Escape':
      if (ctrl || shift) return unsupported()
      data = ESC
      break
    case 'Backspace':
      if (shift) return unsupported()
      data = ctrl ? '\b' : '\x7f'
      break
    default: {
      const character = key === 'Space' ? ' ' : key
      if (!/^[\x20-\x7e]$/.test(character)) return unsupported()
      // Legacy Ctrl+Shift+letter loses Shift; report this rather than silently
      // firing the unshifted command. Modified navigation keys remain supported.
      if (ctrl && shift) return unsupported()
      if (ctrl) {
        const upper = character.toUpperCase()
        if (/^[A-Z]$/.test(upper)) data = String.fromCharCode(upper.charCodeAt(0) - 64)
        else if (' @2'.includes(character)) data = '\0'
        else if (character === '[' || character === '3') data = ESC
        else if (character === '\\' || character === '4') data = '\x1c'
        else if (character === ']' || character === '5') data = '\x1d'
        else if (character === '^' || character === '6') data = '\x1e'
        else if (character === '_' || character === '/' || character === '7') data = '\x1f'
        else if (character === '?' || character === '8') data = '\x7f'
        else return unsupported()
      } else {
        data = shift ? shiftedCharacters[character] ?? character.toUpperCase() : character
      }
    }
  }
  return success((alt ? ESC : '') + data)
}
