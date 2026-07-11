export const observeTerminalResize = (element: Element, onResize: () => void): (() => void) => {
  if (typeof ResizeObserver === 'undefined') return () => undefined
  const observer = new ResizeObserver(onResize)
  observer.observe(element)
  return () => observer.disconnect()
}
