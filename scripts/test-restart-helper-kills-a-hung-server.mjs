/**
 * The restart helper against a backend that will not leave.
 *
 * Every other restart test starts a board that shuts down cleanly, and all of them pass, and on
 * 2026-09-11 the owner pressed Restart server and got a dead board anyway. His backend had stopped
 * in native ConPTY teardown after killing its one running card: still holding port 5178, answering
 * nothing, for hours. The helper waited its thirty seconds for the port to close, saw it never did,
 * and exited without starting anything. That is the one shape none of the green tests exercised.
 *
 * So this is not a Garden. It is the helper, a fixture that holds a port and never answers, and a
 * replacement that answers `/health`. The helper is given the fixture's pid the way the server now
 * gives it its own, and the assertions are the two things the owner needed that morning: the old
 * process is gone, and something is answering on the port again.
 *
 * It takes a little over thirty seconds, because the helper's polite wait is thirty seconds and
 * this test is about what happens after it. Shortening that wait to make the test fast would be
 * testing a different helper.
 *
 *   node scripts/test-restart-helper-kills-a-hung-server.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const HELPER = join(ROOT, 'server', 'bin', 'garden-restart.mjs')

let failed = 0
const check = (what, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () =>
  new Promise((done) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })

const healthy = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok && (await res.text()) === 'replacement'
  } catch {
    return false
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const dir = mkdtempSync(join(tmpdir(), 'garden-hung-restart-'))
const PORT = await freePort()

/*
 * The corpse. A listening socket whose owner accepts connections and never writes a byte, which is
 * what the owner's backend looked like from the outside: a TCP probe says "up", `/health` hangs.
 */
const hung = join(dir, 'hung.mjs')
writeFileSync(
  hung,
  `import { createServer } from 'node:net'
createServer((socket) => socket.on('error', () => {})).listen(${PORT}, '127.0.0.1')
setInterval(() => {}, 60_000)
`,
)
// The replacement: the smallest thing that can pass for a board coming back.
const replacement = join(dir, 'replacement.mjs')
writeFileSync(
  replacement,
  `import { createServer } from 'node:http'
createServer((req, res) => { res.statusCode = 200; res.end('replacement') }).listen(${PORT}, '127.0.0.1')
`,
)

const corpse = spawn(process.execPath, [hung], { stdio: 'ignore' })
await sleep(800)
check('a process holds the port and answers nothing', alive(corpse.pid) && !(await healthy(PORT)), `pid ${corpse.pid}`)

const startedAt = Date.now()
const helper = spawn(
  process.execPath,
  [
    HELPER,
    '--port', String(PORT),
    '--cwd', dir,
    '--exec', process.execPath,
    '--pid', String(corpse.pid),
    '--args', JSON.stringify([replacement]),
  ],
  { stdio: 'ignore' },
)
const helperExit = new Promise((r) => helper.on('exit', r))

// Thirty seconds of polite waiting, then the kill, then up to ten more. Sixty is far past that.
let upAt = 0
for (let i = 0; i < 120 && !upAt; i++) {
  await sleep(500)
  if (await healthy(PORT)) upAt = Date.now()
}
check(
  'the old process is gone',
  !alive(corpse.pid),
  alive(corpse.pid) ? 'still running' : 'ended by the helper',
)
check(
  'and a replacement is answering on the port',
  upAt > 0,
  upAt ? `after ${((upAt - startedAt) / 1000).toFixed(1)}s` : 'nothing ever answered',
)
const code = await Promise.race([helperExit, sleep(5000).then(() => 'still running')])
check('the helper exited saying it succeeded', code === 0, `exit ${code}`)

// End the replacement by port, since the helper started it detached and nothing here holds it.
try {
  const ps = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$p = (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if ($p) { Stop-Process -Id $p -Force }`,
    ],
    { stdio: 'ignore' },
  )
  await new Promise((r) => ps.on('close', r))
} catch {
  // Nothing listening, which is also fine.
}
try {
  if (alive(corpse.pid)) process.kill(corpse.pid, 'SIGKILL')
} catch {
  // Gone.
}
for (let i = 0; i < 10; i++) {
  try {
    rmSync(dir, { recursive: true, force: true })
    break
  } catch {
    await sleep(300)
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
