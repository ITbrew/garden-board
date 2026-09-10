/**
 * The restart helper replaces the page half as well as the backend, and only when it is told to.
 *
 * The owner pressed Restart server, got his board back, and was still on the previous build with
 * `builds differ` beside the version: "i pressed restart server button, it brought board back, but
 * itst still on v1.1.11 and it says builds differ. this needs to be resolved in a one shot". The
 * button restarted the backend alone, so the stale Vite holding 5177 under `strictPort` stayed
 * exactly where it was and the chip it was pressed to clear was the thing it guaranteed.
 *
 * What would go red before the change:
 *
 *   - `--web-port` is not a flag, so the page half is never stopped and never started.
 *
 * What has to stay green forever, and is the more important half of this file: **without
 * `--web-port` the helper touches no page half at all**. Every instance a test starts is launched
 * without it, so if that assertion ever fails, a test restarting its own server would stop the
 * owner's real Vite on 5177. That accident has happened here in another form and is what the flag
 * exists to make impossible.
 *
 * Nothing here goes near 5177, npm run dev:web, or the real Garden. The helper is run directly, in a
 * temporary directory with a package.json of its own whose `dev:web` starts a listener on a port
 * this test picked, so the real code path is exercised (kill the holder, wait for the port, npm run
 * dev:web in the cwd) against processes this test created and can account for.
 */
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HELPER = join(ROOT, 'server', 'bin', 'garden-restart.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

/** A port nothing is using, asked of the operating system rather than guessed at. */
const freePort = () =>
  new Promise((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => done(port))
    })
  })

const listening = (port) =>
  new Promise((done) => {
    const probe = connect({ port, host: '127.0.0.1' })
    probe.setTimeout(600)
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

const waitFor = async (fn, ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(200)
  }
  return false
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const dir = mkdtempSync(join(tmpdir(), 'garden-restart-web-'))
const started = []

/*
 * A stand-in for each half: it holds a port and writes down that it did. Which is all either half
 * has to do for this file, because what is being tested is the helper's decisions about processes
 * and ports, not what Garden or Vite serve over them.
 */
writeFileSync(
  join(dir, 'listener.mjs'),
  [
    "import { createServer } from 'node:net'",
    "import { appendFileSync } from 'node:fs'",
    'const [port, label, marker] = process.argv.slice(2)',
    'const s = createServer((c) => c.end())',
    "s.listen(Number(port), '127.0.0.1', () => appendFileSync(marker, label + ' ' + process.pid + '\\n'))",
    'setInterval(() => {}, 60_000)',
    '',
  ].join('\n'),
)

const webPort = await freePort()
const serverPort = await freePort()

writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify(
    {
      name: 'garden-restart-web-stand-in',
      version: '0.0.0',
      private: true,
      type: 'module',
      // The helper starts the page half exactly as the launcher does, through npm, so this is the
      // one place the test gets to say what "the page half" is.
      scripts: { 'dev:web': `node listener.mjs ${webPort} web web.marker` },
    },
    null,
    2,
  ),
)

const startStandIn = (port, label, marker) => {
  const child = spawn(process.execPath, [join(dir, 'listener.mjs'), String(port), label, marker], {
    cwd: dir,
    stdio: 'ignore',
  })
  started.push(child)
  return child
}

/*
 * A port of its own per run, because the helper's first act is to wait for the old server's port to
 * close and it gives up after thirty seconds. Reusing the port the previous run's stand-in is still
 * holding would make the helper exit before it reached the page half, and every assertion about the
 * page half would then be passing on an empty run.
 */
const runHelper = (port, extra) =>
  new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        HELPER,
        '--port', String(port),
        '--cwd', dir,
        '--exec', process.execPath,
        '--args', JSON.stringify([join(dir, 'listener.mjs'), String(port), 'server', 'server.marker']),
        ...extra,
      ],
      { cwd: dir, stdio: 'ignore' },
    )
    started.push(child)
    child.on('close', (code) => done(code))
  })

const markerText = (name) => {
  const p = join(dir, name)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

const stop = (code) => {
  for (const c of started) {
    try {
      c.kill()
    } catch {
      /* already gone */
    }
  }
  // The page half the helper started is not a child of this process, so it is stopped by port.
  for (const line of markerText('web.marker').trim().split('\n')) {
    const pid = Number(line.trim().split(/\s+/)[1])
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid)
      } catch {
        /* already gone */
      }
    }
  }
  for (const line of markerText('server.marker').trim().split('\n')) {
    const pid = Number(line.trim().split(/\s+/)[1])
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid)
      } catch {
        /* already gone */
      }
    }
  }
  setTimeout(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the temp directory outliving this run costs nothing */
    }
    process.exit(code)
  }, 500)
}

// --- told which page half is ours: it is replaced ---

const oldWeb = startStandIn(webPort, 'old-web', join(dir, 'old-web.marker'))
const up = await waitFor(() => listening(webPort), 5000)
check('a stand-in page half is up before the restart', up, `port ${webPort}`)

await runHelper(serverPort, ['--web-port', String(webPort)])

const backendBack = await waitFor(() => markerText('server.marker').includes('server'), 15_000)
check('the backend comes back', backendBack, markerText('server.marker').trim() || 'no marker')

const oldGone = await waitFor(async () => !alive(oldWeb.pid), 15_000)
check('the page half that was running is stopped', oldGone, `pid ${oldWeb.pid}`)

/*
 * npm has to resolve, install nothing, and start the script, so this is the slow assertion in the
 * file rather than a hung one.
 */
const webBack = await waitFor(() => markerText('web.marker').includes('web'), 90_000)
check('and a fresh one is started in its place', webBack, markerText('web.marker').trim() || 'no marker')
check('on the same port', await listening(webPort), `port ${webPort}`)

const freshPid = Number(markerText('web.marker').trim().split(/\s+/)[1])
check('and it is a different process', !!freshPid && freshPid !== oldWeb.pid, `${oldWeb.pid} -> ${freshPid}`)

// --- not told: nothing on the machine's page half is touched ---

/*
 * The assertion that keeps a test run away from the owner's Vite. Every instance a test starts is
 * launched without GARDEN_WEB_PORT, so the flag is absent here for the same reason it is absent
 * there, and the stand-in below stands in for his real one.
 */
const otherPort = await freePort()
const bystander = startStandIn(otherPort, 'bystander', join(dir, 'bystander.marker'))
await waitFor(() => listening(otherPort), 5000)

await runHelper(await freePort(), [])
await sleep(1500)

check('with no --web-port, a page half already running is left alone', alive(bystander.pid), `pid ${bystander.pid}`)
check('and it still holds its port', await listening(otherPort), `port ${otherPort}`)

// --- told, but nothing is there: nothing is started ---

/*
 * Replace rather than ensure. A port with nothing on it means the board is served some other way,
 * most likely the built app on the backend's own port, and a dev server nobody asked for is not a
 * restart.
 */
const emptyPort = await freePort()
await runHelper(await freePort(), ['--web-port', String(emptyPort)])
await sleep(2000)
check('a page half that was not running is not started', !(await listening(emptyPort)), `port ${emptyPort}`)

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
stop(failures ? 1 : 0)
