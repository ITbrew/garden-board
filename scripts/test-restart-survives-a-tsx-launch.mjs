/**
 * Proves the Restart server button works on the board the owner actually runs.
 *
 * His report, 2026-09-08: "the restart server button has never actually brought the garden back to
 * life, it always kills it and i have to close window and reopen the shortcut". Meanwhile
 * `test-restart-button-brings-it-back.mjs` has passed the whole time, which is the interesting part
 * and the reason this file exists as well as that one.
 *
 * The two tests differ in one thing: how the server under test was started. That one launches
 * `server/dist/index.js` with plain node. `npm run dev:server`, which is what the launcher runs and
 * what the owner's board is, starts node with two tsx loader flags and a TypeScript entry point:
 *
 *   node --require .../tsx/dist/preflight.cjs --import file:///.../tsx/dist/loader.mjs src/index.ts
 *
 * Node keeps those flags in `process.execArgv`, NOT in `process.argv`. So a restart that rebuilds
 * its own command line from `process.argv` alone produces `node src/index.ts`, with no loader, which
 * cannot run a TypeScript file and dies on the spot. Under `dist` there are no execArgv to lose and
 * the same code is correct. A test can therefore be green for a year while the button has never once
 * worked, which is exactly what happened.
 *
 * The rule this leaves behind: anything that reconstructs a process from itself must be tested
 * against every shape that process is really started in. There are two here, and now there is a test
 * for each.
 */
import WebSocket from 'ws'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

let failed = 0
const check = (what, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * Up means the board answers `/health`, not that something holds the port.
 *
 * An earlier version of this file probed the socket and reported the server back after 34 seconds
 * on a run where the replacement had never started at all. A TCP probe on a loopback port under
 * load is not a reliable statement about who owns it, and a half-started process holds a socket
 * before it is a board. `/health` is what the launcher itself waits for and is the only signal here.
 */
const healthy = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

const home = mkdtempSync(join(tmpdir(), 'garden-tsx-restart-home-'))
const garden = await startInstance({ home, entry: 'tsx' })
const PORT = garden.port
console.log(`a board started the way the launcher starts it, on ${PORT}`)

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

check('it is up before the restart', await healthy(PORT))

ws.send(JSON.stringify({ t: 'server.restart' }))

let downAt = 0
for (let i = 0; i < 300 && !downAt; i++) {
  await sleep(100)
  if (!(await healthy(PORT))) downAt = Date.now()
}
check('the server stops', downAt > 0, downAt ? 'it stopped answering' : 'it never went down')

/*
 * Patiently, because a tsx start compiles the server's TypeScript on the way in and takes seconds
 * rather than the third of a second the built shape takes. Ninety of them is far past that and
 * short enough to fail honestly.
 */
let upAt = 0
if (downAt) {
  for (let i = 0; i < 180 && !upAt; i++) {
    await sleep(500)
    if (await healthy(PORT)) upAt = Date.now()
  }
}
check(
  'and it comes back as a working board, with the loader flags it was launched with',
  upAt > 0,
  upAt ? `answering again after ${((upAt - downAt) / 1000).toFixed(1)}s` : 'it never answered again',
)

try {
  ws.close()
} catch {
  // It died with the server it was talking to, which is the point.
}

/*
 * The replacement has to be ended by this test, and only by port.
 *
 * It was started detached by the restart helper, so nothing here holds a handle to it, and it is
 * indistinguishable on a command line from the board the owner runs: same node, same flags, same
 * entry point, same working directory. The port is the one thing that is this test's own, allocated
 * for this run, so the process listening on it is the process to end. Anything looser would be a
 * test that can kill the owner's board.
 */
try {
  const out = execSync(
    `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
    { encoding: 'utf8' },
  )
  for (const found of out.match(/[0-9]+/g) ?? []) {
    const pid = Number(found)
    if (Number.isInteger(pid) && pid > 0) process.kill(pid)
  }
} catch {
  // Nothing listening, which is the other acceptable outcome.
}
await garden.stop()

/*
 * Retried, because Windows releases a file handle a moment after the process that held it exits and
 * the database is open until then. A leaked temporary directory is a small cost; a test that fails
 * on its own cleanup and hides its result is not.
 */
for (let i = 0; i < 10; i++) {
  try {
    rmSync(home, { recursive: true, force: true })
    break
  } catch {
    await sleep(500)
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
