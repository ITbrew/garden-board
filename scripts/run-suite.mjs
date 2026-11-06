/**
 * Run the whole suite and say plainly what happened.
 *
 * Sequential rather than parallel, and that is not laziness. Each test now starts a Garden of its
 * own with a real PTY behind it, so a dozen at once means a dozen ConPTY processes competing for
 * the same machine, and the flakiness that produces reads exactly like a real failure. The suite
 * takes longer and the result means something.
 *
 * Three tests spawn a real Claude session and cost real tokens, so they are held back unless asked
 * for by name. They are named in the summary either way rather than quietly skipped, because an
 * unmentioned omission reads exactly like a pass.
 *
 *   node scripts/run-suite.mjs             everything that costs nothing
 *   node scripts/run-suite.mjs --paid      those three as well
 *   node scripts/run-suite.mjs --only doc  only tests whose name contains "doc"
 *
 * A test named in `known-red.json` is allowed to fail without failing the run, and is printed
 * loudly with its reason and the date it went on the list. That is the only way a gate can be
 * switched on over a suite that is not green yet without the gate being a lie.
 *
 * The half that stops such a list rotting: a quarantined test that PASSES fails the run. Something
 * fixed it, and the entry has to come off rather than sit there forever excusing a test that no
 * longer needs excusing.
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const ROOT = resolve(HERE, '..')

/*
 * Refuse to run while a board is open on this machine.
 *
 * `check-no-live-board.mjs` reads the text of every test looking for the live port, and it is a good
 * guard against a test that NAMES the board. It cannot catch a test that reaches the board without
 * naming it, and it says nothing at all about whether a board is running right now.
 *
 * On 2026-09-18 the other PC ran this suite with the owner's board open. He watched Vite restart in
 * a loop and his board reset repeatedly, and reported it as a launcher bug; it was the suite. The
 * exact mechanism is not established and the two tests first blamed both ask the OS for a free port
 * and work in temp directories, so this is deliberately not a fix aimed at those two files. It is
 * the blunt version of the rule the roots already state: a test gets its own instance, its own port
 * and its own directory, and the cheapest way to guarantee the owner's board is not that instance is
 * to decline to start while it is up.
 *
 * Both ports matter. 5178 is the backend and 5177 is Vite under `strictPort`, which is the one no
 * static check was watching.
 */
const listening = (port) =>
  new Promise((done) => {
    const probe = connect({ port, host: '127.0.0.1' })
    probe.setTimeout(500)
    const settle = (answer) => {
      probe.destroy()
      done(answer)
    }
    probe.on('connect', () => settle(true))
    probe.on('timeout', () => settle(false))
    probe.on('error', () => settle(false))
  })

/*
 * Read out of the sources that define them rather than written here, so moving a port cannot leave
 * this watching one nobody uses. Same reasoning as check-no-live-board.mjs, which reads the backend
 * port the same way. The web port's home is the vite config, since that is what binds it.
 */
const portFrom = (file, pattern, fallback) => {
  try {
    const found = readFileSync(join(ROOT, file), 'utf8').match(pattern)
    return found ? Number(found[1]) : fallback
  } catch {
    return fallback
  }
}
const BOARD_PORTS = [
  portFrom('packages/shared/src/index.ts', /export const DEFAULT_PORT\s*=\s*(\d+)/, 5178),
  portFrom('apps/web/vite.config.ts', /port:\s*(\d+)/, 5177),
]

const busy = []
for (const p of BOARD_PORTS) if (await listening(p)) busy.push(p)
if (busy.length && !process.argv.includes('--board-is-not-mine')) {
  console.log(`\nREFUSED. A board is answering on ${busy.join(' and ')} on this machine.`)
  console.log('\nThis suite starts and stops real Gardens, and it has disturbed a live board before:')
  console.log('the owner saw Vite restarting in a loop and blamed the launcher. Close the board and')
  console.log('run this again. Nothing has been run and nothing has been changed.')
  console.log('\nIf those ports genuinely belong to something that is not the owner\'s board, say so:')
  console.log('  node scripts/run-suite.mjs --board-is-not-mine')
  process.exit(1)
}

/** These launch a real CLI and spend real tokens. Held back by default, never hidden. */
const PAID = new Set([
  'test-hook-live.mjs',
  'test-live-session.mjs',
  'test-live-dispatch.mjs',
  'test-message-card-live.mjs',
  'test-live-one-entry-wakes-a-card.mjs',
])

const args = process.argv.slice(2)
const withPaid = args.includes('--paid')
const onlyAt = args.indexOf('--only')
const only = onlyAt >= 0 ? args[onlyAt + 1] : null

const all = readdirSync(HERE)
  .filter((f) => f.startsWith('test-') && f.endsWith('.mjs'))
  .filter((f) => (only ? f.includes(only) : true))
  .sort()

/*
 * The one unit test that lives beside the code it tests rather than in here.
 *
 * Everything else in this directory drives a real instance, so `scripts/` is the right home for it.
 * `profiles.test.ts` is a different kind of thing: it calls one pure function with fixtures in a
 * temp directory, and a unit test belongs next to its unit. Node 24 strips the types and runs the
 * `.ts` directly, and `runOne` joins against HERE, so the relative path resolves.
 *
 * Named explicitly rather than discovered, because a glob over `server/src` would quietly start
 * running anything anyone later names `*.test.ts` from a suite that spends real money on some of
 * its entries. One line per test that lives outside this folder is a cheap price for that.
 *
 * The card that wrote the test could not add this line: it owns `server/src/profiles.test.ts` and
 * Garden refused it the write, correctly, rather than let two cards edit one file. So the test was
 * green and not in the suite, which is the worst of both.
 */
if (!only || 'profiles.test.ts'.includes(only)) all.push('../server/src/profiles.test.ts')

/*
 * Tests that cannot run from this checkout at all, whatever anyone passes.
 *
 * Different from a paid test, which is held back to save money, and different again from a known-red
 * one, which is broken and meant to be fixed. This one is correct and its refusal is the feature:
 * `test-terminal-geometry-tui.mjs` holds a source file in two states, and doing that inside
 * `C:\Garden` hot-reloads the owner's running app into the broken half, which is what it cost on
 * 2026-08-13 (canon 14 revision 6). Its first assertion refuses if its own root is the checkout.
 *
 * So it printed FAIL on every suite run, for doing exactly the right thing. Named here rather than
 * left to look like breakage.
 */
const ELSEWHERE = new Map([
  [
    'test-terminal-geometry-tui.mjs',
    'refuses to run from the checkout the dev server watches. Run it from a worktree.',
  ],
])

const held = all.filter((f) => (PAID.has(f) && !withPaid) || ELSEWHERE.has(f))
const run = all.filter((f) => !held.includes(f))

/**
 * Tests allowed to be red, each with a reason and a date.
 *
 * Read rather than hardcoded so the list is a file somebody can look at, and so a diff of it shows
 * up in review as its own thing rather than buried in this runner.
 */
let known = []
try {
  known = JSON.parse(readFileSync(join(HERE, 'known-red.json'), 'utf8')).tests ?? []
} catch {
  // No list is the healthy state, and the suite should not need one to run.
}
const excused = new Map(known.map((k) => [k.test, k]))

/** A test that hangs is a failed test, not a suite that never finishes. */
const TIMEOUT_MS = 300_000

function runOne(file) {
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(process.execPath, [join(HERE, file)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (out += b))
    const timer = setTimeout(() => {
      child.kill()
      done({ file, code: 'timeout', ms: Date.now() - started, out })
    }, TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ file, code, ms: Date.now() - started, out })
    })
  })
}

console.log(`running ${run.length} tests, one at a time\n`)

const results = []
for (const file of run) {
  const r = await runOne(file)
  results.push(r)
  const failed = r.code !== 0
  const secs = (r.ms / 1000).toFixed(0).padStart(3)
  console.log(`${failed ? 'FAIL' : 'pass'}  ${secs}s  ${file}`)
  if (failed) {
    // Only the lines that say what went wrong, so one broken test does not bury the rest.
    const lines = r.out.split('\n').filter((l) => /^(FAIL|SKIP)|Error|error TS|not found/.test(l.trim()))
    for (const l of lines.slice(0, 8)) console.log(`        ${l.trim()}`)
    if (r.code === 'timeout') console.log(`        gave up after ${TIMEOUT_MS / 1000}s`)
  }
}

const red = results.filter((r) => r.code !== 0)
const newlyRed = red.filter((r) => !excused.has(r.file))
const stillRed = red.filter((r) => excused.has(r.file))
// A quarantined test that passed. Somebody fixed it and the excuse has to go.
const recovered = results.filter((r) => r.code === 0 && excused.has(r.file))

console.log(`\n${results.length - red.length} of ${results.length} passed`)
if (newlyRed.length) console.log(`failed: ${newlyRed.map((r) => r.file).join(', ')}`)

if (stillRed.length) {
  console.log(`\nknown red, not counted against this run:`)
  for (const r of stillRed) {
    const k = excused.get(r.file)
    console.log(`  ${r.file}  (since ${k.since})`)
    console.log(`      ${k.reason}`)
  }
}

if (recovered.length) {
  console.log(`\nthese are on known-red.json and they PASSED:`)
  for (const r of recovered) console.log(`  ${r.file}`)
  console.log('Take them off the list. An excuse nobody needs any more is how the list stops meaning anything.')
}

const paidHeld = held.filter((f) => PAID.has(f))
if (paidHeld.length) console.log(`\nheld back, they spend real tokens: ${paidHeld.join(', ')}  (pass --paid to run them)`)
for (const [file, why] of ELSEWHERE) {
  if (held.includes(file)) console.log(`not run here: ${file}\n      ${why}`)
}
process.exit(newlyRed.length || recovered.length ? 1 : 0)
