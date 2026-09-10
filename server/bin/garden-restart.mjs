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
 * The page half goes with it when `--web-port` says which one this server belongs to. Restarting the
 * backend alone is what left the owner looking at the old build with `builds differ` beside it, and
 * canon 22 has the reasoning: no session lives in the page half, so replacing it costs seconds and
 * no state, while leaving it produces the exact warning the button was pressed to clear. Without
 * `--web-port` nothing here goes near a page half, which is what keeps an instance a test started
 * away from the owner's real one.
 *
 *   node garden-restart.mjs --port 5178 --cwd C:/Garden --exec <path> --args <json array>
 *                           [--web-port 5177]
 */
import { execFileSync, spawn } from 'node:child_process'
import { connect } from 'node:net'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const port = Number(arg('port'))
// Absent means there is no page half to replace, which is the answer for every server that was not
// started by the launcher. It is never defaulted to 5177: that default would let a test instance
// stop the owner's real Vite.
const webPort = Number(arg('web-port')) || 0
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

/** True while something is still listening, which means the old process has not finished. */
const listening = (p) =>
  new Promise((done) => {
    const probe = connect({ port: p, host: '127.0.0.1' })
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
  if (!(await listening(port))) break
  await sleep(250)
}
if (await listening(port)) process.exit(1)

// Detached and with its handles let go, so this helper exiting cannot take the new server with it.
const child = spawn(exec, args, { cwd, detached: true, stdio: 'ignore', env: process.env })
child.unref()

/*
 * The page half, after the backend and never before it, so nothing here delays the board coming
 * back. The page reconnects on its own either way: Vite's client reloads the window when its server
 * returns, and the board's socket badge covers the seconds in between.
 */
if (webPort) await replacePageHalf()

async function replacePageHalf() {
  /*
   * Replace, rather than ensure it is running. A port with nothing on it means the board is being
   * served some other way, most likely the built app on the backend's own port, and starting a dev
   * server the owner did not ask for is not a restart.
   */
  if (!(await listening(webPort))) return

  const pids = holdersOf(webPort)
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {
      // Already gone, or not ours to stop. Either way the wait below is the thing that decides.
    }
  }

  // Vite is strictPort, so a replacement started while the old one still holds the port exits
  // instead of moving aside, silently. Waiting on the port is what makes the start meaningful.
  const webDeadline = Date.now() + 15_000
  while (Date.now() < webDeadline) {
    if (!(await listening(webPort))) break
    await sleep(250)
  }
  if (await listening(webPort)) return

  /*
   * Started the way the launcher starts it, through npm, so there is one definition of what the page
   * half is. Hidden and with its output dropped: a console here would be a window the owner did not
   * open, and a console Garden writes to is how the board froze twice (see scripts/launch.ps1).
   */
  const web =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'npm run dev:web'], {
          cwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: process.env,
        })
      : spawn('npm', ['run', 'dev:web'], { cwd, detached: true, stdio: 'ignore', env: process.env })
  web.unref()
}

/**
 * The process ids listening on a port.
 *
 * `netstat` rather than a PowerShell cmdlet because this runs detached with no console and needs no
 * module: the answer is one line of text. Anything unreadable is an empty list, which leaves the
 * port alone, which is the safe direction for a function whose job is to kill things.
 */
function holdersOf(p) {
  if (process.platform !== 'win32') return []
  let out = ''
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 10_000 })
  } catch {
    return []
  }
  const found = new Set()
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    // TCP  127.0.0.1:5177  0.0.0.0:0  LISTENING  12345
    if (parts.length < 5 || parts[3] !== 'LISTENING') continue
    if (!parts[1].endsWith(`:${p}`)) continue
    const pid = Number(parts[4])
    if (pid > 0 && pid !== process.pid) found.add(pid)
  }
  return [...found]
}
