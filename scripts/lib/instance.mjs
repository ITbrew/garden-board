/**
 * A Garden of its own, for a test to take apart.
 *
 * Every test script here used to connect to whatever server was already running, which was fine
 * while the only thing running was mine and stopped being fine the moment the owner started using
 * the app for real work. Two of my scripts have already left debris on his live board, and one
 * rearranged three cards he was working with.
 *
 * So a test gets its own server, on its own port, with its own workspace directory: a separate
 * board, separate mailboxes, separate hook settings and a separate database. Nothing it does can
 * reach his, and it does not matter what is or is not running on 5178.
 *
 * The built output is what gets launched rather than the TypeScript, because a test that runs the
 * source through a watcher restarts itself halfway through when I save a file.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

/** Ask the OS for a port nobody is using, then let go of it. */
function freePort() {
  return new Promise((done) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Start one, wait until it answers, and hand back how to reach it and how to end it.
 *
 * `quiet` keeps the server's own logging out of the test output; pass false when a test is failing
 * for reasons that might be the server's.
 *
 * `home` gives two servers the same workspace, which is the only way to test anything about a
 * restart: what a card does when the backend comes back is a question about a board that already
 * exists, and a fresh temporary directory has no board in it. Passing one also stops the directory
 * being deleted on stop, since the point is that something else opens it afterwards. The test that
 * passed it owns the cleanup.
 *
 * `entry` picks which of the two launch shapes to start, and it exists because they are not
 * interchangeable and a test that only knows one of them can pass while the owner's board is broken.
 * `dist` is plain node against the built file and is what every other test wants: fast, and what a
 * packaged Garden runs. `tsx` reproduces how the board is actually started by `npm run dev:server`,
 * which is node carrying two loader flags in `execArgv` with a TypeScript entry point. Anything that
 * reconstructs a command line from a running process has to be tested against the second, because
 * `process.argv` does not contain those flags and code that rebuilds a launch from argv alone looks
 * correct under `dist` and produces a process that cannot start under `tsx`.
 */
export async function startInstance({ quiet = true, home: given = null, entry = 'dist' } = {}) {
  const port = await freePort()
  const home = given ?? mkdtempSync(join(tmpdir(), 'garden-test-home-'))

  const tsxRoot = join(ROOT, 'node_modules', 'tsx', 'dist')
  const [execArgs, cwd] =
    entry === 'tsx'
      ? [
          [
            '--require',
            join(tsxRoot, 'preflight.cjs'),
            '--import',
            pathToFileURL(join(tsxRoot, 'loader.mjs')).href,
            'src/index.ts',
          ],
          join(ROOT, 'server'),
        ]
      : [[join(ROOT, 'server', 'dist', 'index.js')], ROOT]

  const child = spawn(process.execPath, execArgs, {
    cwd,
    env: {
      ...process.env,
      GARDEN_PORT: String(port),
      GARDEN_HOME: home,
      GARDEN_DB: join(home, 'garden.db'),
      // Whatever session this was launched from must not leak into the sessions it launches.
      CLAUDE_CODE_CHILD_SESSION: undefined,
    },
    stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
  })

  let died = null
  child.on('exit', (code) => (died = code))
  if (quiet) child.stderr?.on('data', (b) => process.stderr.write(`[server] ${b}`))

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (died !== null) throw new Error(`the test server exited with code ${died} before answering`)
    if (await healthy(port)) {
      return {
        port,
        home,
        async stop() {
          child.kill()
          await new Promise((r) => setTimeout(r, 400))
          if (given) return
          try {
            rmSync(home, { recursive: true, force: true })
          } catch {
            // A mailbox the server still has open on Windows is not worth failing a test over.
          }
        },
      }
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  child.kill()
  throw new Error(`the test server never answered on ${port}. Has "npm run build" been run?`)
}
