/**
 * Does the board's Restart button bring the server back when the board was started the way the
 * owner's board is actually started?
 *
 * `test-restart-survives-a-tsx-launch.mjs` already covers a tsx launch, and it passes. It spawns
 * node directly with the two loader flags. That is not what `scripts/launch.ps1` does. The launcher
 * runs
 *
 *   Start-Process cmd.exe /c "npm run dev:server"  -WindowStyle Hidden  -Redirect...
 *
 * which is cmd, then npm, then npm again for the workspace, then tsx's own CLI, then the node
 * process that is the server. Five processes deep, with the server's stdout and stderr redirected
 * into files by the outermost one. Every one of those is a difference the existing test does not
 * have, and the owner reports the button killing Garden and leaving him to reopen it from the
 * desktop, which is the failure that test says cannot happen.
 *
 * So this starts a board in that exact shape, on its own port and its own home, asks for a restart
 * over the socket the way the button does, and waits to see whether anything answers again.
 *
 * Never the live board. Its own port, its own GARDEN_HOME, its own database, and it kills what it
 * started on the way out however it ends.
 *
 *   node scripts/test-restart-from-the-launcher-shape.mjs
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (what, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** True while something is listening, which is the only honest way to ask if the server is up. */
const up = (port) =>
  new Promise((done) => {
    const probe = connect({ port, host: '127.0.0.1' })
    probe.setTimeout(700)
    probe.on('connect', () => {
      probe.destroy()
      done(true)
    })
    probe.on('timeout', () => {
      probe.destroy()
      done(false)
    })
    probe.on('error', () => done(false))
  })

const waitUntil = async (fn, ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(300)
  }
  return false
}

const PORT = 5400 + Math.floor(Math.random() * 300)
const home = mkdtempSync(join(tmpdir(), 'garden-launcher-restart-'))

/*
 * cmd.exe wrapping npm, which is the launcher's own shape. `shell: false` with cmd named
 * explicitly rather than `shell: true`, so what runs is visible here rather than assembled by node.
 */
const launcher = spawn('cmd.exe', ['/c', 'npm run dev:server'], {
  cwd: ROOT,
  env: {
    ...process.env,
    GARDEN_PORT: String(PORT),
    GARDEN_HOME: home,
    GARDEN_DB: join(home, 'garden.db'),
    CLAUDE_CODE_CHILD_SESSION: undefined,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

const out = []
launcher.stdout.on('data', (b) => out.push(String(b)))
launcher.stderr.on('data', (b) => out.push(String(b)))

/** Kill the whole tree, since npm and tsx sit between this and the server. */
const killTree = () =>
  new Promise((done) => {
    if (!launcher.pid) return done()
    spawn('taskkill', ['/pid', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' }).on('close', done)
  })

const bail = async (why) => {
  console.log(`ABORT: ${why}`)
  if (out.length) console.log(out.join('').slice(-2000))
  await killTree()
  process.exit(1)
}

// A tsx start compiles the server on the way in, so this is patient rather than quick.
if (!(await waitUntil(() => up(PORT), 90_000))) await bail(`nothing came up on ${PORT}`)
console.log(`a board started the launcher's way, on ${PORT}`)
check('it is up before the restart', await up(PORT))

/*
 * The pid of the process that is actually listening, before and after.
 *
 * Up on the same port is not the same claim as restarted: a restart that silently failed to stop
 * the old server would leave the port answering and look identical from outside. The pid is what
 * tells those two apart.
 */
const listenerPid = async () => {
  const ps = spawn('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
  ])
  let text = ''
  ps.stdout.on('data', (b) => (text += String(b)))
  await new Promise((r) => ps.on('close', r))
  return text.trim()
}

const before = await listenerPid()
console.log(`listening pid before: ${before || 'unknown'}`)

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
await new Promise((r, x) => {
  ws.on('open', r)
  ws.on('error', x)
})
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)

// Exactly what the button sends. Nothing else about the button is simulated, because nothing else
// about it reaches the server.
ws.send(JSON.stringify({ t: 'server.restart' }))

const wentDown = await waitUntil(async () => !(await up(PORT)), 20_000)
check('the server stops', wentDown, wentDown ? 'it stopped answering' : 'it never went down')

/*
 * Sixty seconds, because the replacement is a fresh tsx start and compiles the server again. The
 * existing tsx test allows less and passes; if this one needs the whole window that is itself worth
 * knowing, so the time taken is printed either way.
 */
const began = Date.now()
const cameBack = await waitUntil(() => up(PORT), 60_000)
const took = ((Date.now() - began) / 1000).toFixed(1)
check(
  'and it comes back on its own, with no second launch',
  cameBack,
  cameBack ? `answering again after ${took}s` : `still down after ${took}s, which is the reported fault`,
)

if (cameBack) {
  const after = await listenerPid()
  console.log(`listening pid after: ${after || 'unknown'}`)
  check(
    'and it is a new process rather than the old one that never died',
    Boolean(before) && Boolean(after) && before !== after,
    `${before} then ${after}`,
  )

  /*
   * A port that answers is not a board. The old failure this whole area exists for was a
   * replacement that started, failed to resolve its own imports, and left something half-alive, so
   * the check is that it speaks the protocol.
   */
  let state = null
  const back = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  await new Promise((r) => {
    back.on('open', r)
    back.on('error', r)
  })
  back.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') state = m
  })
  back.send(JSON.stringify({ t: 'hello' }))
  await sleep(2500)
  check('and it answers as a working board', state !== null, state ? 'sent its state' : 'no state came back')
  back.close()
}

if (!cameBack && out.length) {
  console.log('--- what the launcher tree printed ---')
  console.log(out.join('').slice(-3000))
}

await killTree()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
