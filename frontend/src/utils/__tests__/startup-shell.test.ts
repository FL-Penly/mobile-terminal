import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import html from '../../../index.html?raw'

describe('startup shell before the application loads', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    document.body.innerHTML = html.split('<body>')[1].split('</body>')[0]
    const bootstrap = document.querySelector('script:not([src])')
    expect(bootstrap).not.toBeNull()
    new Function(bootstrap!.textContent ?? '')()
  })

  afterEach(() => {
    window.dispatchEvent(new Event('vibeterm:ready'))
    document.body.innerHTML = ''
    performance.clearMarks('vibeterm:html-shell')
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('remains visible and offers a manual retry for a slow load', () => {
    expect(document.getElementById('startup-retry')).not.toBeVisible()
    vi.advanceTimersByTime(8000)
    expect(document.getElementById('startup-message')).toHaveTextContent('加载时间较长')
    expect(document.getElementById('startup-retry')).toBeVisible()
  })

  it('removes itself after React mounts and cancels the slow-load warning', () => {
    window.dispatchEvent(new Event('vibeterm:ready'))
    expect(document.getElementById('startup')).toBeNull()
    vi.advanceTimersByTime(8000)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('shows a startup error instead of leaving a blank page', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'module failed' }))
    expect(document.getElementById('startup-message')).toHaveTextContent('页面启动遇到错误')
    expect(document.getElementById('startup-retry')).toBeVisible()
    vi.advanceTimersByTime(8000)
    expect(document.getElementById('startup-message')).toHaveTextContent('页面启动遇到错误')
  })

  it('ignores unrelated image failures', () => {
    const image = document.createElement('img')
    document.body.append(image)
    image.dispatchEvent(new Event('error'))
    expect(document.getElementById('startup-message')).toHaveTextContent('正在加载终端')
  })
})
