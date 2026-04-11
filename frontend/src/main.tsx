import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './styles/index.css'

if ('serviceWorker' in navigator) {
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true
      window.location.reload()
    }
  })

  navigator.serviceWorker.register('/sw.js').then((reg) => {
    setInterval(() => reg.update(), 60_000)

    const onNewSW = () => {
      reg.waiting?.postMessage({ type: 'SKIP_WAITING' })
    }

    if (reg.waiting) onNewSW()
    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing
      newSW?.addEventListener('statechange', () => {
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          onNewSW()
        }
      })
    })
  }).catch(err => console.warn('[SW] registration failed:', err))
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
