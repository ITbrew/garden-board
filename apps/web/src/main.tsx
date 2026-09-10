import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
// The Subagents / Tools list pinned beside each card. Its own file so it can be read whole.
import './subagent-list.css'
// Notices when dist has been rebuilt under an already-open tab and reloads it. See the file.
import { watchForNewBuild } from './build-refresh'

watchForNewBuild()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
