/**
 * Proves a card comes back into its own conversation after the backend has been restarted.
 *
 * The failure, read off the owner's own board on 2026-08-14. Garden restarted at 03:24, he pressed
 * Play, and card b177ad92 launched `claude --resume 3a4b6ba9-...`. The CLI printed
 *
 *   Session 3a4b6ba9-... is currently running as a background agent (bg).
 *   Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy.
 *
 * and exited, leaving a bare PowerShell prompt. The next bytes in his scrollback are him typing
 * `test`, then `claude`, which started a conversation that had never heard of the work he was in
 * the middle of. In his words: "i have to resume each terminal to their session manually".
 *
 * It happens on a restart specifically because Garden kills the shell it spawned, and a session the
 * CLI has moved into its own daemon is not in that process tree. The conversation stays held by a
 * process Garden did not start and cannot see in its own map.
 *
 * Three parts. What the CLI's registry looks like (checked against `claude agents --json`, which is
 * documented, so a change to the private layout fails here rather than silently turning the check
 * off), whether Garden reads it correctly, and what it puts on the command line as a result.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = (f) => pathToFileURL(join(process.cwd(), 'server', 'dist', f)).href
const { conversationHeldElsewhere } = await import(dist('cli-sessions.js'))
const { claudeAdapter } = await import(dist('adapters.js'))

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// --- part one: the registry is where and what Garden thinks -------------------------------------

/*
 * `claude agents --json` is the CLI's own scripting interface and needs no TTY. Every session it
 * reports must have a file behind it in the directory Garden reads, or Garden is reading the wrong
 * place and would silently decide nothing is ever held.
 */
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const listed = spawnSync('claude', ['agents', '--json'], { encoding: 'utf8', shell: true, timeout: 60_000 })
let sessions = null
try {
  sessions = JSON.parse(listed.stdout)
} catch {
  // Left null, and reported below rather than thrown: a machine with no CLI on PATH should say so.
}

if (!Array.isArray(sessions)) {
  console.log(`SKIP  the CLI did not answer "claude agents --json" here, so its layout is unchecked`)
} else {
  const onDisk = new Map()
  for (const name of readdirSync(join(configDir, 'sessions')).filter((f) => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(readFileSync(join(configDir, 'sessions', name), 'utf8'))
      if (raw.sessionId) onDisk.set(raw.sessionId, raw)
    } catch {
      // Being written right now.
    }
  }
  /*
   * Only the ones with a process behind them, which is the whole of what Garden claims to detect.
   *
   * The listing also carries background jobs the daemon is holding with no pid at all, in the
   * owner's config right now a session "blocked" since 2026-08-12. Whether the CLI refuses to resume
   * one of those is not known here and is not guessed at: a card that meets it is left exactly where
   * it is today, at a shell prompt, which is a gap worth naming rather than papering over.
   */
  const running = sessions.filter((s) => Number.isInteger(s.pid))
  const ids = running.map((s) => s.sessionId).filter(Boolean)
  const missing = ids.filter((id) => !onDisk.has(id))
  check(
    'every session the CLI lists with a live pid has a file where Garden looks for it',
    ids.length > 0 && missing.length === 0,
    `${ids.length} running of ${sessions.length} listed, ${onDisk.size} on disk` +
      `${missing.length ? `, missing ${missing.join(', ')}` : ''}`,
  )
  check(
    'and those files carry the pid and session id the check is built on',
    [...onDisk.values()].every((r) => Number.isInteger(r.pid) && typeof r.sessionId === 'string'),
    `${onDisk.size} files`,
  )
}

// --- part two: Garden reads it correctly --------------------------------------------------------

const fake = mkdtempSync(join(tmpdir(), 'garden-cli-registry-'))
mkdirSync(join(fake, 'sessions'), { recursive: true })

const HELD = '11111111-1111-4111-8111-111111111111'
const FINISHED = '22222222-2222-4222-8222-222222222222'
// This test's own process: alive by construction, and nothing can race it into being dead.
writeFileSync(
  join(fake, 'sessions', `${process.pid}.json`),
  JSON.stringify({ pid: process.pid, sessionId: HELD, kind: 'bg', cwd: 'C:\\Garden' }),
)
// A pid that cannot exist, standing for the file a process left behind when it died.
writeFileSync(
  join(fake, 'sessions', '4294967000.json'),
  JSON.stringify({ pid: 4294967000, sessionId: FINISHED, kind: 'interactive', cwd: 'C:\\Garden' }),
)
writeFileSync(join(fake, 'sessions', 'half-written.json'), '{"pid": 1234, "sess')

check(
  'a conversation a live process is in reads as held',
  conversationHeldElsewhere(HELD, fake) === true,
)
check(
  'one whose process is gone does not',
  conversationHeldElsewhere(FINISHED, fake) === false,
)
check(
  'and neither does one nothing has ever claimed',
  conversationHeldElsewhere('33333333-3333-4333-8333-333333333333', fake) === false,
)
check(
  'a config directory with no registry at all is not an error',
  conversationHeldElsewhere(HELD, join(fake, 'nothing-here')) === false,
)

// --- part three: what that produces on the command line -----------------------------------------

const RESUME = '44444444-4444-4444-8444-444444444444'
const commandFor = (extra) => claudeAdapter.launch('C:\\Garden', null, extra).args.join(' ')

check(
  'a card with nothing to resume launches plain',
  !commandFor({}).includes('--resume'),
  commandFor({}).slice(-60),
)
check(
  'a card whose conversation is free continues it',
  commandFor({ GARDEN_RESUME: RESUME }).includes(`--resume ${RESUME}`) &&
    !commandFor({ GARDEN_RESUME: RESUME }).includes('--fork-session'),
  commandFor({ GARDEN_RESUME: RESUME }).slice(-70),
)
check(
  'a card whose conversation is held branches a copy instead of starting empty',
  commandFor({ GARDEN_RESUME: RESUME, GARDEN_RESUME_FORK: '1' }).includes(`--resume ${RESUME} --fork-session`),
  commandFor({ GARDEN_RESUME: RESUME, GARDEN_RESUME_FORK: '1' }).slice(-70),
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
