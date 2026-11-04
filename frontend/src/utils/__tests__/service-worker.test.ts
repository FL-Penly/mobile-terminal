import source from '../../../public/sw.js?raw'
import { describe, expect, it, vi } from 'vitest'


const setup = (fetchResponse: () => Promise<Response>, options: {
  put?: () => Promise<void>
  open?: () => Promise<never>
} = {}) => {
  const handlers = new Map<string, (event: unknown) => void>()
  const cache = {
    match: vi.fn(async () => new Response('old app')),
    put: vi.fn(options.put ?? (async () => {})),
  }
  const fetch = vi.fn(fetchResponse)
  const worker = new Function('self', 'caches', 'fetch', 'URL', 'Response', 'AbortController', source)
  worker(
    { addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) },
    { open: options.open ?? (async () => cache) },
    fetch, URL, Response, AbortController,
  )
  let response: Promise<Response> | undefined
  let background: Promise<unknown> | undefined
  handlers.get('fetch')?.({
    request: { url: 'https://terminal.test/', method: 'GET', mode: 'navigate' },
    respondWith: (value: Promise<Response>) => { response = value },
    waitUntil: (value: Promise<unknown>) => { background = value },
  })
  return { response, background, cache, fetch }
}

describe('application navigation cache', () => {
  it('delivers the page while cache writing is still pending', async () => {
    let finishWrite: () => void = () => {}
    const write = new Promise<void>(resolve => { finishWrite = resolve })
    const { response, background } = setup(async () => new Response('new app'), { put: () => write })
    let completed = false
    void background?.then(() => { completed = true })
    expect(await (await response)?.text()).toBe('new app')
    expect(completed).toBe(false)
    finishWrite()
    await background
    expect(completed).toBe(true)
  })

  it('serves fresh content even when cache writing fails', async () => {
    const { response, background, cache } = setup(async () => new Response('new app'), {
      put: async () => { throw new Error('quota exceeded') },
    })
    expect(await (await response)?.text()).toBe('new app')
    await expect(background).resolves.toBeUndefined()
    expect(cache.match).not.toHaveBeenCalled()
  })

  it('does not wait for cache storage to open before showing the page', async () => {
    const { response } = setup(async () => new Response('new app'), { open: () => new Promise(() => {}) })
    expect(await (await response)?.text()).toBe('new app')
  })

  it('works online when cache storage is unavailable', async () => {
    const { response, background } = setup(async () => new Response('new app'), {
      open: async () => { throw new Error('storage unavailable') },
    })
    expect(await (await response)?.text()).toBe('new app')
    await background
  })

  it('returns an offline response when both network and cache are unavailable', async () => {
    const { response } = setup(async () => { throw new Error('offline') }, {
      open: async () => { throw new Error('storage unavailable') },
    })
    expect((await response)?.status).toBe(503)
  })

  it('falls back to the cached page for a server error', async () => {
    const { response } = setup(async () => new Response('error', { status: 503 }))
    expect(await (await response)?.text()).toBe('old app')
  })

  it('loads the new application immediately instead of the cached HTML', async () => {
    const { response, cache, fetch } = setup(async () => new Response('new app'))
    expect(await (await response)?.text()).toBe('new app')
    expect(cache.put).toHaveBeenCalledOnce()
    expect(cache.match).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cache: 'no-cache' }))
  })

  it('opens the cached page on a slow link and keeps downloading for the next open', async () => {
    vi.useFakeTimers()
    try {
      let finish: (response: Response) => void = () => {}
      const { response, background, cache, fetch } = setup(() => new Promise(resolve => { finish = resolve }))
      await vi.advanceTimersByTimeAsync(3000)
      expect(await (await response)?.text()).toBe('old app')
      expect(fetch).toHaveBeenCalledOnce()
      expect(cache.put).not.toHaveBeenCalled()
      finish(new Response('new app'))
      await background
      expect(cache.put).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a slow first load instead of failing when nothing is cached', async () => {
    vi.useFakeTimers()
    try {
      let finish: (response: Response) => void = () => {}
      const { response } = setup(() => new Promise(resolve => { finish = resolve }), {
        open: async () => { throw new Error('storage unavailable') },
      })
      let settled = false
      void response?.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(30000)
      expect(settled).toBe(false)
      finish(new Response('new app'))
      expect(await (await response)?.text()).toBe('new app')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the cached application available offline', async () => {
    const { response } = setup(async () => { throw new Error('offline') })
    expect(await (await response)?.text()).toBe('old app')
  })
})
