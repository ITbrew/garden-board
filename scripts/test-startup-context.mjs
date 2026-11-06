#!/usr/bin/env node
/**
 * What a card is actually handed at startup, measured rather than assumed.
 *
 * Runs the real hook as a real child process with a synthetic SessionStart event, against scratch
 * files in a temp directory. Never the live board: `GARDEN_HOME` and the mail directory both point
 * at the scratch tree, because a script pointed at the owner's real workspace has already destroyed
 * his database once.
 *
 * Usage: node scripts/test-startup-context.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOOK = join(fileURLToPath(new URL('..', import.meta.url)), 'server', 'hooks', 'garden-hook.mjs')
const root = mkdtempSync(join(tmpdir(), 'garden-roots-test-'))
let failures = 0

function pad(label, n) {
  return `${label} `.padEnd(28, '.') + ` ${n}`
}

function check(name, ok, detail) {
  if (ok) console.log(`  pass  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`)
  }
}

/*
 * A clean environment, because this test is increasingly run from inside a card.
 *
 * Every GARDEN_* variable is inherited by anything a card runs, so passing `process.env` straight
 * through handed the hook the *tester's* card identity: its memory directory, its mail directory,
 * and in particular GARDEN_BRIEF_DELIVERED. That last one silently turned the fallback-route case
 * into a no-op, and it failed as "the brief is not inlined" while the code was fine. A test that
 * reads the environment it is run from is measuring the runner, not the thing.
 */
const clean = () => {
  const out = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GARDEN_')) out[k] = v
  return out
}

/** Run the hook the way the CLI runs it: event on stdin, JSON on stdout. */
function startupContext(env) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'test' }),
    encoding: 'utf8',
    env: { ...clean(), GARDEN_HOME: root, ...env },
  })
  if (res.status !== 0) throw new Error(`hook exited ${res.status}: ${res.stderr}`)
  try {
    return JSON.parse(res.stdout)?.hookSpecificOutput?.additionalContext ?? ''
  } catch {
    return ''
  }
}

/** The final line `filler` would produce, which is what "arrived whole" actually means. */
function lastLine(label, n) {
  return `${label} line ${Math.ceil(n / 60) - 1} `
}

/** A card on disk, with files of the sizes asked for. */
function card(name, sizes) {
  const memory = join(root, 'memory', 'proj', name)
  const mail = join(root, 'mail', name)
  const roots = join(root, 'roots')
  mkdirSync(memory, { recursive: true })
  mkdirSync(mail, { recursive: true })
  mkdirSync(join(roots, 'roles'), { recursive: true })

  const filler = (label, n) =>
    `# ${label}\n\n` + Array.from({ length: Math.ceil(n / 60) }, (_, i) => `${label} line ${i} ${'x'.repeat(40)}`).join('\n')

  writeFileSync(join(roots, 'ALL.md'), filler('SHARED', sizes.shared ?? 2070))
  writeFileSync(join(roots, 'roles', 'boss.md'), filler('ROLE', sizes.role ?? 519))
  writeFileSync(join(memory, 'CLAUDE.md'), filler('BRIEF', sizes.brief ?? 5236))
  writeFileSync(join(mail, 'POWERS.md'), filler('POWERS', sizes.powers ?? 1200))
  writeFileSync(join(mail, 'PEERS.md'), filler('PEERS', sizes.peers ?? 6244))
  // Newest last, which is the format the seeded header asks for.
  writeFileSync(
    join(memory, 'LESSONS.md'),
    `# Lessons\n\nOLDEST-LESSON\n` + 'filler line\n'.repeat(Math.ceil((sizes.lessons ?? 6501) / 12)) + 'NEWEST-LESSON\n',
  )
  writeFileSync(join(mail, 'INBOX.md'), filler('INBOX', sizes.inbox ?? 3000))

  return {
    GARDEN_CARD: name,
    GARDEN_MEMORY_DIR: memory,
    GARDEN_MAIL_DIR: mail,
    GARDEN_ROOTS_ALL: join(roots, 'ALL.md'),
    GARDEN_ROOTS_ROLE: join(roots, 'roles', 'boss.md'),
  }
}

try {
  console.log('A card carrying the real file sizes measured on the board:\n')
  const big = card('big-card', {})
  const ctx = startupContext({ ...big, GARDEN_BRIEF_DELIVERED: '1' })
  console.log(pad('  total characters', ctx.length))

  check('stays under the CLI ceiling', ctx.length < 10000, `${ctx.length}`)
  /*
   * "Whole" means the LAST line of the file is present. An earlier version of this check looked for
   * a [Trimmed] marker anywhere after the word SHARED, which matched a marker belonging to a
   * different section entirely and reported a failure that was not there. A check that can fail for
   * a reason other than the one it names is not a check.
   */
  check('the shared roots arrive whole', ctx.includes(lastLine('SHARED', 2070)), 'last line missing')
  check('the role roots arrive whole', ctx.includes(lastLine('ROLE', 519)), 'last line missing')
  check('lessons keep the newest end', ctx.includes('NEWEST-LESSON'), 'newest lesson was cut')
  check('lessons drop the oldest end', !ctx.includes('OLDEST-LESSON'), 'expected the old end to be trimmed')
  check('the brief is not sent twice', !ctx.includes('BRIEF'), 'brief was inlined despite the flag')
  check('the roots directory is named', ctx.includes('ROOTS.md'))
  check('peers are present at all', ctx.includes('PEERS'))

  console.log('\nA small card, where everything genuinely fits:\n')
  const small = card('small-card', { shared: 900, role: 400, powers: 600, peers: 500, lessons: 300, inbox: 200 })
  const ctx2 = startupContext({ ...small, GARDEN_BRIEF_DELIVERED: '1' })
  console.log(pad('  total characters', ctx2.length))
  check('nothing is trimmed at all', !ctx2.includes('[Trimmed'), 'a small card should never be cut')
  check('no earlier-entries marker either', !ctx2.includes('[Earlier entries'), 'tail files fit too')

  /*
   * The busiest card on the real board has a 281,051 character inbox. Without a cap on the one
   * unbounded input, it takes an equal share of everything and PEERS.md pays for it, which is the
   * file naming who this card is allowed to send to. A card that cannot see its wires cannot hand
   * work over, so this is the check that the cap is doing its job.
   */
  console.log('\nA card with a 280,000 character inbox:\n')
  const flooded = card('flooded-card', { inbox: 281051, peers: 3435, lessons: 300, powers: 1601 })
  const ctx4 = startupContext({ ...flooded, GARDEN_BRIEF_DELIVERED: '1' })
  console.log(pad('  total characters', ctx4.length))
  check('still under the CLI ceiling', ctx4.length < 10000, `${ctx4.length}`)
  /*
   * The backstop is the last-resort slice at the very end, and it cuts blind. Landing exactly on it
   * means the allocation overspent and something was lost with no marker saying so, which is the
   * silent failure this whole change exists to remove. Checking the ceiling alone hides that,
   * because the backstop keeps the output under the ceiling by definition.
   */
  check('the blind backstop never fires', ctx4.length < 9600, `landed on ${ctx4.length}`)
  check('peers survive the flood', ctx4.includes(lastLine('PEERS', 3435)), 'peers were cut by the inbox')
  check('lessons survive the flood', ctx4.includes('NEWEST-LESSON'))
  check('the shared roots still arrive whole', ctx4.includes(lastLine('SHARED', 2070)))
  check('the inbox is still there, just short', ctx4.includes('INBOX'))

  console.log('\nThe old fallback route, for a launcher that does not pass the brief:\n')
  const ctx3 = startupContext({ ...small })
  check('the brief is inlined when nothing else carried it', ctx3.includes('BRIEF'))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
