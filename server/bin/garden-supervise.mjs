/**
 * Keep Garden's server running, and leave evidence when it does not.
 *
 * On 2026-08-24 fifteen cards died inside eighteen seconds. Every card's PTY is a child of the one
 * server process, so when the server goes they all go together, with no error and no survivor to
 * report it. The owner found out because his board emptied. Two things were missing and this is
 * both of them.
 *
 * NOTHING RECORDED THE DEATH. The server's stdout goes to whatever terminal launched it and is gone
 * when that window closes; the newest server log on the machine was five days stale. So the cause
 * had to be inferred from free memory and an application queue log rather than read. A supervisor that
 * restarts the server without writing down why it died would fix the symptom and destroy the only
 * chance of fixing the cause, so the log comes first here and the restart second.
 *
 * NOTHING BROUGHT IT BACK. There was no supervisor at all: a dead server stayed dead until the owner
 * noticed and started it, which is why he was copy-pasting resume ids by hand.
 *
 *   node garden-supervise.mjs                 supervise, log, restart on death
 *   node garden-supervise.mjs --dry-run <cmd> supervise an arbitrary command instead (for testing)
 *   node garden-supervise.mjs --once          run it, log the exit, do NOT restart
 *
 * What it deliberately does NOT do: revive cards. A crash loop that automatically relaunched fifteen
 * agents would spend the owner's money in a circle, and spending is his decision rather than a
 * recovery step. Instead the cards that were live at the moment of death are written to the log and
 * to a `last-loss.json`, so bringing them back is one informed command rather than a guess.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, existsSync, writeFileSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { get } from 'node:http'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valueOf = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}

const PORT = Number(valueOf('--port') ?? 5178)
const GARDEN = valueOf('--cwd') ?? 'C:/Garden'
const ONCE = has('--once')
const DRY = valueOf('--dry-run')

/*
 * Overridable so this can be exercised without writing into the real board's log.
 *
 * The standing rule on this project is that a harness never runs against the live workspace, and a
 * supervisor with a hard-coded log path cannot be tested at all without breaking it.
 */
const LOG_DIR = valueOf('--log-dir') ?? join(homedir(), '.garden', 'logs')
mkdirSync(LOG_DIR, { recursive: true })
const LOG = join(LOG_DIR, 'server.log')

/*
 * Rotate on size rather than on date.
 *
 * A date-stamped file is tidy and answers the wrong question: the interesting window is the minutes
 * before a death, and that window does not respect midnight. One file that is always the current one
 * with a single .1 behind it means "read the end of server.log" is always the right instruction.
 */
const MAX_BYTES = 8 * 1024 * 1024
function rotateIfBig() {
  try {
    if (existsSync(LOG) && statSync(LOG).size > MAX_BYTES) renameSync(LOG, `${LOG}.1`)
  } catch {
    // A locked or vanished log must never stop the server from starting.
  }
}

let out = null
function openLog() {
  rotateIfBig()
  out = createWriteStream(LOG, { flags: 'a' })
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
function note(line) {
  const text = `[supervise ${stamp()}] ${line}\n`
  process.stdout.write(text)
  try {
    out?.write(text)
  } catch {
    /* logging must never be fatal */
  }
}

/**
 * Ask the server which cards are alive, so a death can say what it took with it.
 *
 * Best-effort by construction: it runs against a server that is about to die or has just died, and a
 * failure here must produce a smaller log entry rather than block the restart.
 */
function liveCards() {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

let lastHealth = null
const pollHealth = setInterval(async () => {
  const h = await liveCards()
  if (h) lastHealth = { ...h, at: stamp() }
}, 15_000)
pollHealth.unref?.()

/*
 * Backoff, and a ceiling on it.
 *
 * If the server dies because the machine is out of memory, restarting it instantly makes the machine
 * worse and produces a hot loop that buries the log entry explaining why under thousands of its own
 * restarts. Doubling from 2s to a 60s ceiling keeps it trying without becoming the problem.
 *
 * A run that stays up for a while is treated as recovered and the delay is reset, otherwise a server
 * that is fine for hours would still be punished for a crash last week.
 */
const MIN_DELAY = 2_000
const MAX_DELAY = 60_000
const HEALTHY_AFTER = 120_000
let delay = MIN_DELAY

function launch() {
  openLog()
  const cmd = DRY ?? process.execPath
  const args = DRY ? [] : [join(GARDEN, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts']
  const cwd = DRY ? process.cwd() : join(GARDEN, 'server')

  note(`starting: ${cmd} ${args.join(' ')} (cwd ${cwd})`)
  const startedAt = Date.now()

  const child = spawn(cmd, args, {
    cwd,
    shell: Boolean(DRY),
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  // Tee: the console still behaves exactly as it did, and the file is the part that survives.
  child.stdout?.on('data', (d) => {
    process.stdout.write(d)
    try {
      out?.write(d)
    } catch {
      /* ignore */
    }
  })
  child.stderr?.on('data', (d) => {
    process.stderr.write(d)
    try {
      out?.write(d)
    } catch {
      /* ignore */
    }
  })

  child.on('exit', (code, signal) => {
    const upFor = Math.round((Date.now() - startedAt) / 1000)
    note(`SERVER EXITED after ${upFor}s: code=${code} signal=${signal ?? 'none'}`)
    if (lastHealth) {
      note(`last healthy poll ${lastHealth.at}: sessions=${lastHealth.sessions} app=${lastHealth.app}`)
      try {
        writeFileSync(
          join(LOG_DIR, 'last-loss.json'),
          `${JSON.stringify({ diedAt: stamp(), upForSeconds: upFor, code, signal, lastHealth }, null, 1)}\n`,
        )
      } catch {
        /* ignore */
      }
    } else {
      note('no healthy poll was ever recorded, so nothing is known about what it was running')
    }

    if (ONCE) {
      note('--once given, not restarting')
      process.exit(code ?? 0)
    }

    if (upFor * 1000 >= HEALTHY_AFTER) delay = MIN_DELAY
    note(`restarting in ${Math.round(delay / 1000)}s`)
    setTimeout(launch, delay)
    delay = Math.min(delay * 2, MAX_DELAY)
  })

  child.on('error', (err) => note(`could not spawn: ${err.message}`))

  // Passing the signal on rather than dying first, so Ctrl+C stops the server too instead of
  // orphaning it and leaving its port held by something nothing is watching any more.
  const passOn = (sig) => () => {
    note(`got ${sig}, stopping the server`)
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    process.exit(0)
  }
  process.once('SIGINT', passOn('SIGINT'))
  process.once('SIGTERM', passOn('SIGTERM'))
}

note(`supervising, logging to ${LOG}`)
launch()
