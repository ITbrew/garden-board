/**
 * The two halves of Garden each say which build they are, and the page can tell them apart.
 *
 * Checks the server end of that: an instance of its own reports a version and a commit at /health
 * and in the state message the page loads from. The page end is a Vite define and a comparison in
 * the header, which typecheck covers and this cannot reach without a browser.
 *
 * Its own instance, its own port, its own home. Never the owner's board.
 */
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
import { startInstance } from './lib/instance.mjs'

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const declared = JSON.parse(readFileSync('server/package.json', 'utf8')).version
const garden = await startInstance({ entry: 'tsx' })

const health = await (await fetch(`http://127.0.0.1:${garden.port}/health`)).json()
check('/health carries a build', !!health.build, JSON.stringify(health.build))
check('/health version is the one in server/package.json', health.build?.version === declared,
  `${health.build?.version} vs ${declared}`)
check('/health names a commit', typeof health.build?.commit === 'string' && health.build.commit.length > 0,
  String(health.build?.commit))

const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
const state = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no state message in 15s')), 15000)
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello' })))
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') {
      clearTimeout(timer)
      resolve(m)
    }
  })
})
check('the state the page loads carries the same build', JSON.stringify(state.build) === JSON.stringify(health.build),
  JSON.stringify(state.build))

ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
