import { useSyncExternalStore } from 'react'
import { getNetworkQuality, subscribeNetworkQuality, type NetworkQuality } from '../utils/network-quality'

export const useNetworkQuality = (): NetworkQuality => (
  useSyncExternalStore(subscribeNetworkQuality, getNetworkQuality, getNetworkQuality)
)
