import source from '../../../public/sw.js?raw'
import { describe, expect, it, vi } from 'vitest'


const setup = (fetchResponse: () => Promise<Response>) => {
  const handlers = new Map<string, (event: unknown) => void>()
  const cache = {
    match: vi.fn(async () => new Response('old app')),
    put: vi.fn(async () => {}),
  }
  const fetch = vi.fn(fetchResponse)
  const worker = new Function('self', 'caches', 'fetch', 'URL', 'Response', 'AbortSignal', source)
  worker(
    { addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) },
    { open: async () => cache },
    fetch, URL, Response, AbortSignal,
  )
  let response: Promise<Response> | undefined
  handlers.get('fetch')?.({
    request: { url: 'https://terminal.test/', method: 'GET', mode: 'navigate' },
    respondWith: (value: Promise<Response>) => { response = value },
  })
  return { response, cache, fetch }
}

describe('application navigation cache', () => {
  it('loads the new application immediately instead of the cached HTML', async () => {
    const { response, cache, fetch } = setup(async () => new Response('new app'))
    expect(await (await response)?.text()).toBe('new app')
    expect(cache.put).toHaveBeenCalledOnce()
    expect(cache.match).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cache: 'no-cache' }))
  })

  it('keeps the cached application available offline', async () => {
    const { response } = setup(async () => { throw new Error('offline') })
    expect(await (await response)?.text()).toBe('old app')
  })
})
