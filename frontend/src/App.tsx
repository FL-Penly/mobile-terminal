import { useEffect } from 'react'
import { TerminalProvider } from './contexts/TerminalContext'
import { ServerEventsProvider } from './contexts/ServerEventsContext'
import { Layout } from './components/Layout'
import { Terminal } from './components/Terminal'
import { markStartup } from './utils/startup-timing'

function App() {
  useEffect(() => {
    markStartup('react-mounted')
    window.dispatchEvent(new Event('vibeterm:ready'))
    const setVh = () => {
      const vh = window.innerHeight * 0.01
      document.documentElement.style.setProperty('--vh', `${vh}px`)
    }
    setVh()
    window.addEventListener('resize', setVh)
    return () => window.removeEventListener('resize', setVh)
  }, [])

  return (
    <TerminalProvider>
      <ServerEventsProvider>
        <Layout>
          <Terminal />
        </Layout>
      </ServerEventsProvider>
    </TerminalProvider>
  )
}

export default App
