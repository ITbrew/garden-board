/**
 * A saved file never reaches the owner's open page until the page loads again. Canon 22 revision 10.
 *
 * His page is served by a Vite dev server from the checkout the cards edit, and Vite used to push each
 * saved file into it on the spot. A save to `preview.ts` swapped a fresh copy of `state.ts`, the store
 * and the socket, into his running page with nothing feeding it, and the board read offline with no
 * cards until he pressed F5. The owner: "its really annoying when resets happen and im left hung like
 * that".
 *
 * This starts its own Vite from the real config on a free port, loads the modules the way a page
 * does, and then tells it `preview.ts` changed, without touching the file. Nothing may be pushed to
 * the page. Then the same with `GARDEN_HMR=1`, where something must be, which is what shows the first
 * silence was the config holding the update back rather than this test failing to cause one.
 *
 * It never edits a file and never touches 5177.
 */
import { createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(ROOT, 'apps', 'web')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const port = await new Promise((done) => {
  const probe = createNetServer()
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => done(port))
  })
})
// The config reads its port from here, which is also what keeps this Vite off the owner's 5177.
process.env.GARDEN_WEB_PORT = String(port)
delete process.env.GARDEN_HMR

const { createServer } = await import('vite')
const server = await createServer({ root: WEB, configFile: join(WEB, 'vite.config.ts'), logLevel: 'silent' })
await server.listen()

try {
  // Load the page's modules the way a browser does, so the graph knows state.ts imports preview.ts.
  for (const path of ['/', '/src/main.tsx', '/src/App.tsx', '/src/state.ts', '/src/preview.ts', '/src/components/TerminalMini.tsx']) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`)
    if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  }

  const pushed = []
  const client = new WebSocket(`ws://127.0.0.1:${port}/`, 'vite-hmr')
  client.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.type === 'update' || m.type === 'full-reload') pushed.push(m.type)
  })
  await new Promise((r, j) => {
    client.on('open', r)
    client.on('error', j)
  })
  await sleep(500)

  const changed = join(WEB, 'src', 'preview.ts')
  server.watcher.emit('change', changed)
  await sleep(2000)
  check('a change to preview.ts is not pushed into an open page', pushed.length === 0, pushed.join(', ') || 'nothing pushed')

  process.env.GARDEN_HMR = '1'
  server.watcher.emit('change', changed)
  await sleep(2000)
  check('while GARDEN_HMR=1 still gets hot updates, so the silence above was the config', pushed.length > 0, pushed.join(', ') || 'nothing pushed')
  client.close()
} finally {
  await server.close()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
