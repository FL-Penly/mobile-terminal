import { useCallback, useMemo, useSyncExternalStore } from 'react'

export const useMediaQuery = (query: string): boolean => {
  const media = useMemo(() => window.matchMedia(query), [query])
  const subscribe = useCallback((notify: () => void) => {
    // Older iOS Safari exposes only the legacy MediaQueryList subscription.
    if (typeof media.addEventListener !== 'function') {
      media.addListener(notify)
      return () => media.removeListener(notify)
    }
    media.addEventListener('change', notify)
    return () => media.removeEventListener('change', notify)
  }, [media])
  const snapshot = useCallback(() => media.matches, [media])
  return useSyncExternalStore(subscribe, snapshot)
}
