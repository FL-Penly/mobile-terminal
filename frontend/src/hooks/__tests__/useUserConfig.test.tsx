import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useUserConfig } from '../useUserConfig'
import { loadUserConfig, saveUserConfig } from '../../components/SettingsModal'

const config = { commands: [], presets: [{ label: 'prompt', text: 'hello' }], presetGroups: [{ id: 'a', label: '我的模板', presets: [{ label: 'prompt', text: 'hello' }] }], activePresetGroupId: 'a' }
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => undefined) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('does not replace failed loads with defaults and automatically retries without a refresh', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(json(config))
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(useUserConfig)
  await act(async () => {})
  expect(result.current.ready).toBe(false)
  expect(result.current.status).toContain('加载失败')
  act(() => result.current.update(config))
  expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(result.current.ready).toBe(true)
  expect(result.current.config.presetGroups[0].label).toBe('我的模板')
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('retains edits after a failed save, and only retries writes explicitly', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(config)).mockResolvedValueOnce(new Response('', { status: 500 })).mockResolvedValueOnce(json({ success: true }))
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(useUserConfig)
  await act(async () => {})
  const edit = { ...config, commands: [{ label: 'new', cmd: 'pwd', autoEnter: false }] }
  await act(async () => { result.current.update(edit) })
  expect(result.current.config).toEqual(edit)
  expect(result.current.status).toContain('保存失败')
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(fetcher).toHaveBeenCalledTimes(2)
  await act(async () => { result.current.retry() })
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(result.current.status).toBe('')
})

it('serializes saves and sends the newest pending edit after the first save completes', async () => {
  let complete: (response: Response) => void = () => undefined
  const pending = new Promise<Response>(resolve => { complete = resolve })
  const fetcher = vi.fn().mockResolvedValueOnce(json(config)).mockReturnValueOnce(pending).mockResolvedValueOnce(json({ success: true }))
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(useUserConfig)
  await act(async () => {})
  act(() => { result.current.update({ ...config, activePresetGroupId: 'first' }); result.current.update(config) })
  expect(fetcher).toHaveBeenCalledTimes(2)
  await act(async () => { complete(json({ success: true })) })
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(JSON.parse(fetcher.mock.calls[2][1].body).activePresetGroupId).toBe('a')
})

it('coalesces resume/retry events and removes timers on unmount', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('offline'))
  vi.stubGlobal('fetch', fetcher)
  const { result, unmount } = renderHook(useUserConfig)
  act(() => { result.current.retry(); window.dispatchEvent(new Event('online')) })
  expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () => {})
  unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('rejects HTTP errors and malformed config rather than reporting success', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(json([])).mockResolvedValueOnce(new Response('', { status: 500 })))
  await expect(loadUserConfig()).rejects.toThrow('503')
  await expect(loadUserConfig()).rejects.toThrow('Invalid')
  await expect(saveUserConfig(config)).rejects.toThrow('500')
})
