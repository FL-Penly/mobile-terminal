import { constants, createDeflateRaw } from 'node:zlib'

export async function deflateFrames(payloads) {
  const compressor = createDeflateRaw()
  const chunks = []
  compressor.on('data', chunk => chunks.push(chunk))
  const frames = []
  try {
    for (const payload of payloads) {
      compressor.write(payload)
      await new Promise((resolve, reject) => {
        compressor.flush(constants.Z_SYNC_FLUSH, error => error ? reject(error) : resolve())
      })
      frames.push(Buffer.concat(chunks.splice(0)))
    }
    return frames
  } finally {
    compressor.destroy()
  }
}
