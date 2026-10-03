import { describe, expect, it } from 'vitest'
import { deflateFrames } from './fixtures/deflate-frames.mjs'
import frames from './fixtures/flate2-frames.json'
import { connectTimeout, createOutputInflater, encodeAckMessage, encodeInitMessage, parseControlMessage, reconnectDelay } from '../terminal-protocol'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('terminal wire protocol', () => {
  it('encodes negotiated init and cumulative byte acknowledgements', () => {
    expect(JSON.parse(new TextDecoder().decode(encodeInitMessage(90, 30)))).toEqual({
      AuthToken: '', columns: 90, rows: 30, features: ['heartbeat', 'deflate', 'flow'],
    })
    expect(new TextDecoder().decode(encodeAckMessage(123))).toBe('4{"type":"ack","bytes":123}')
  })

  it('validates controls and tolerates unknown fields and feature names', () => {
    expect(parseControlMessage(bytes('{"type":"hello","features":["heartbeat","future"],"extra":1}')))
      .toEqual({ type: 'hello', features: ['heartbeat', 'future'] })
    expect(parseControlMessage(bytes('{"type":"heartbeat"}'))).toEqual({ type: 'heartbeat' })
    expect(parseControlMessage(bytes('{"type":"closed","reason":"taken_over","retry":false}')))
      .toEqual({ type: 'closed', reason: 'taken_over', retry: false })
    for (const text of ['oops', 'null', '[]', '{}', '{"type":"future"}', '{"type":"hello","features":[3]}', '{"type":"closed","reason":3,"retry":false}']) {
      expect(parseControlMessage(bytes(text))).toBeNull()
    }
  })

  it('caps backoff at five seconds and connect timeout at twenty seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 100].map(reconnectDelay)).toEqual([500, 1000, 2000, 3000, 5000, 5000, 5000])
    expect([0, 1, 2, 3, 100].map(connectTimeout)).toEqual([10000, 15000, 20000, 20000, 20000])
  })
})


describe('streaming deflate interoperability', () => {
  it('decodes Rust sync-flushed frames immediately', () => {
    const chunks: Uint8Array[] = []
    const inflater = createOutputInflater(chunk => chunks.push(chunk))
    const expected = ['hello\n', '中文 😀\n', '\x1b]7337;/dev/pts/42\x1b\\']
    for (const [index, frame] of frames.entries()) {
      inflater.push(Uint8Array.from(atob(frame), char => char.charCodeAt(0)))
      expect(new TextDecoder().decode(chunks[index])).toBe(expected[index])
    }
  })

  it('decodes independently generated Node frames without finishing the stream', async () => {
    const payloads = ['first', '中文'.repeat(1000), 'z'.repeat(200000)]
    const frames = await deflateFrames(payloads)
    const received: Uint8Array[] = []
    const inflater = createOutputInflater(chunk => received.push(chunk))
    for (const [index, frame] of frames.entries()) {
      inflater.push(frame)
      expect(received.map(chunk => new TextDecoder().decode(chunk)).join('')).toBe(payloads[index])
      received.length = 0
    }
  })
})
