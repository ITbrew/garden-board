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
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const ROOT = resolve(HERE, '..')

/** These launch a real CLI and spend real tokens. Held back by default, never hidden. */
const PAID = new Set(['test-hook-live.mjs', 'test-live-session.mjs', 'test-live-dispatch.mjs', 'test-message-card-live.mjs'])

const args = process.argv.slice(2)
const withPaid = args.includes('--paid')
const onlyAt = args.indexOf('--only')
const only = onlyAt >= 0 ? args[onlyAt + 1] : null

const all = readdirSync(HERE)
  .filter((f) => f.startsWith('test-') && f.endsWith('.mjs'))
  .filter((f) => (only ? f.includes(only) : true))
  .sort()

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
    const child = spawn(process.execPath, [join(HERE, file)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
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
