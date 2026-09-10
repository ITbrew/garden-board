/**
 * Start Garden's server again once the one that asked has let go of its port.
 *
 * A process cannot restart itself. It can spawn something that outlives it, and that is this: it is
 * launched detached by the server, waits for the port to actually close, starts the replacement, and
 * exits. Nothing else on the board depends on it, and if it fails the only consequence is that the
 * server stays down until the owner starts it himself, which is the same position he was in before
 * there was a button.
 *
 * Waiting on the PORT rather than on a delay, because a fixed sleep is a guess about how long the
 * old server takes to flush every card's scrollback and tear down ten PTYs, and guessing wrong hands
 * the replacement an address already in use. A port that refuses a connection is the thing actually
 * being waited for.
 *
 *   node garden-restart.mjs --port 5178 --cwd C:/Garden --exec <path> --args <json array>
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const port = Number(arg('port'))
const cwd = arg('cwd') || process.cwd()
const exec = arg('exec')
let args = []
try {
  args = JSON.parse(arg('args') || '[]')
} catch {
  // A malformed list is a reason to do nothing rather than to start something unexpected.
  process.exit(1)
}
if (!port || !exec) process.exit(1)

/** True while something is still listening, which means the old server has not finished. */
const stillUp = () =>
  new Promise((done) => {
    const probe = connect({ port, host: '127.0.0.1' })
    probe.setTimeout(800)
    probe.on('connect', () => {
      probe.destroy()
      done(true)
    })
    probe.on('timeout', () => {
      probe.destroy()
      done(true)
    })
    probe.on('error', () => done(false))
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * Bounded, because waiting forever for a port that never frees would leave a stray process running
 * on the owner's machine with nothing to show for it. Thirty seconds is far past what a clean
 * shutdown takes and short enough to give up honestly.
 */
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  if (!(await stillUp())) break
  await sleep(250)
}
if (await stillUp()) process.exit(1)

// Detached and with its handles let go, so this helper exiting cannot take the new server with it.
const child = spawn(exec, args, { cwd, detached: true, stdio: 'ignore', env: process.env })
child.unref()
