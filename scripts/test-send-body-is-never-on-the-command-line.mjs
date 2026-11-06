/**
 * Proves a card is never taught to put a message inside the command that sends it.
 *
 * The failure this exists for, read off the owner's own board on 2026-08-14. Claude Code 2.1.232
 * refuses to auto-approve a Bash command it cannot security-scan:
 *
 *   Command exceeds the maximum analyzable length; its full text cannot be
 *   security-scanned and requires human review.
 *
 * PEERS.md taught exactly one way to send, `echo "what you want to say" | node <shim> ...`, and
 * `echo` cannot carry a paragraph, so a card with anything real to say reached for a heredoc and the
 * whole message ended up in the command. The CLI splits a command on its separators and checks each
 * part on its own: the shim half is allowed by name in the card's settings and never in question,
 * and the `cat <<'EOF'` half is the message, matches nothing, and is what gets refused. The card
 * then stops until the owner answers a prompt. His words: "it stops work each time it happens".
 *
 * Measured across three days of his transcripts before the fix: 274 sends, longest sub-command
 * median 1760 characters, and 133 of them at or over the 1782 that was actually refused. Half the
 * board's mail was over the line.
 *
 * So this reads the instructions a real card is given, runs them exactly as written, and checks the
 * message arrives whole. It uses its own Garden on its own port with its own workspace, so it can
 * never reach a board anyone is working on.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEND = join(ROOT, 'server', 'bin', 'garden-send.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Manager', { title: 'Worker', reportsTo: 0 }] })
const manager = board.cards[0]
const worker = board.cards[1]
await sleep(1200)

const mailDir = join(board.home, 'mail', manager.id)
const outbox = join(mailDir, 'outbox')
const peers = existsSync(join(mailDir, 'PEERS.md')) ? readFileSync(join(mailDir, 'PEERS.md'), 'utf8') : ''
const powers = existsSync(join(mailDir, 'POWERS.md')) ? readFileSync(join(mailDir, 'POWERS.md'), 'utf8') : ''

check('the card was given a PEERS.md to read', peers.length > 0)
check('and an outbox to write into', existsSync(outbox), outbox)

/** The first fenced command under a heading, which is the one a card copies. */
const taught = (text, heading) => {
  const after = text.slice(text.indexOf(heading))
  const fence = after.match(/```\r?\n([\s\S]*?)```/)
  return fence ? fence[1].trim() : ''
}

const sendCmd = taught(peers, '## Sending to one of them')
const hireCmd = taught(powers, 'The command, either way')

// --- what the card is taught -------------------------------------------------------------------

for (const [what, cmd] of [
  ['send', sendCmd],
  ['hire', hireCmd],
]) {
  check(`the taught ${what} command exists`, cmd.length > 0)
  check(
    `the taught ${what} command carries no message body`,
    !!cmd && !cmd.includes('<<') && !/\bEOF\b/.test(cmd) && !cmd.includes('echo "') && !/^\s*cat /.test(cmd),
    cmd.slice(0, 80),
  )
  check(`the taught ${what} command names a file instead`, cmd.includes('--file'), cmd.slice(-60))
  /*
   * Short enough that its length is never the question. The refusal happened at 1782 characters and
   * a 634 character command went through, so anything in the low hundreds is far below the band the
   * line sits in, whatever the exact threshold turns out to be.
   */
  check(`the taught ${what} command is short`, !!cmd && cmd.length < 400, `${cmd.length} characters`)
}

// --- and it is the same command whatever the message is ------------------------------------------

const bodyPath = join(outbox, 'T-1.md')
const runTaught = (body) => {
  writeFileSync(bodyPath, body, 'utf8')
  const cmd = sendCmd
    .replace('<their title>', 'Worker')
    .replace('<kind>', 'work')
    .replace('<task id>', 'T-1')
    .replace(/<task id>\.md/, 'T-1.md')
  // argv, not a shell string: this is the command as the card would run it, minus any shell.
  const args = cmd.match(/"[^"]*"|\S+/g).slice(1).map((a) => a.replace(/^"|"$/g, ''))
  const out = execFileSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, GARDEN_SESSION_ID: manager.id, GARDEN_PORT: String(board.port) },
  })
  return { cmd, out }
}

const short = runTaught('one line')
await sleep(600)

/*
 * Every hazard the shims' own comments were written about, in one body: apostrophes and double
 * quotes, which shattered a --text value; a backtick and a $(...) that a shell would expand; and a
 * literal heredoc marker, which is what a card reaching for the old shape would emit.
 */
const nasty =
  "It's a \"quoted\" line with a `backtick` and $(oops) in it.\n<<EOF\n--to --kind --text\n" +
  'x'.repeat(5800) +
  '\nEND OF THE LONG ONE'
const long = runTaught(nasty)
await sleep(1200)

check(
  'the command is the same length for a 6000 character message as for a short one',
  short.cmd.length === long.cmd.length,
  `${short.cmd.length} and ${long.cmd.length} characters`,
)

const inbox = readFileSync(join(board.home, 'mail', worker.id, 'INBOX.md'), 'utf8')
check('the short message arrived', inbox.includes('one line'))
const head = inbox.includes("It's a \"quoted\" line")
const tail = inbox.includes('END OF THE LONG ONE')
check(
  'and so did the whole of the long one, opening and closing',
  head && tail,
  head && tail ? `${nasty.length} characters, both ends present` : head ? 'the tail is missing' : 'the head is missing',
)

/*
 * And what a mailbox file does when the message is longer than it holds.
 *
 * Reachable because of this change rather than despite it. A body used to have to fit inside a shell
 * command to be sent at all, so nothing ever reached the 8000 character cap in `postMessage`, which
 * cut silently and left an entry that read as complete. Sending from a file removed the ceiling that
 * was hiding it.
 */
/*
 * Read the cap rather than assume it. This sent 9000 characters, which was over the 8000 the cap
 * used to be and is comfortably under the 24000 it was raised to on 2026-09-03, so nothing was cut,
 * no marker appeared, and the test reported the marker missing as though the honesty of a cut entry
 * had broken. It had not; the line had moved. Reading the number out of `mail.ts` means the next
 * person to move it does not also have to remember this file.
 */
const capSrc = readFileSync(join(ROOT, 'server', 'src', 'mail.ts'), 'utf8')
const ENTRY_LIMIT = Number((capSrc.match(/const ENTRY_LIMIT\s*=\s*(\d+)/) ?? [])[1])
check('the mailbox cap could be read from mail.ts', Number.isFinite(ENTRY_LIMIT) && ENTRY_LIMIT > 0, String(ENTRY_LIMIT))
runTaught(`OPENING LINE\n${'y'.repeat(ENTRY_LIMIT + 2000)}\nCLOSING LINE`)
await sleep(1200)
const big = readFileSync(join(board.home, 'mail', worker.id, 'INBOX.md'), 'utf8')
check(
  'a message past what the inbox holds says so, and says how much is missing',
  big.includes('Garden cut this entry here') && /\d+ more characters were sent/.test(big),
  (big.match(/\[Garden cut this entry here[^\]]*\]/) ?? ['(no marker, the entry reads as complete)'])[0].slice(0, 96),
)

// --- refusals, and nothing posted by any of them --------------------------------------------------

const before = readFileSync(join(board.home, 'mail', worker.id, 'INBOX.md'), 'utf8')
const refuse = (args, name) => {
  let message = ''
  try {
    execFileSync(process.execPath, [SEND, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GARDEN_SESSION_ID: manager.id, GARDEN_PORT: String(board.port) },
      input: '',
    })
    message = '(it did not refuse)'
  } catch (err) {
    message = String(err.stderr ?? '')
  }
  return message
}

/*
 * `question` rather than `work` for these three, and the reason is the whole point of them.
 *
 * These assert how the shim handles its ARGUMENTS: two body sources at once, a file that is not
 * there, a file with nothing in it. `work` is a lifecycle kind, so since task ownership landed it is
 * refused first for carrying no `--task`, and each of these then read back a refusal about task ids
 * instead of the one it was written for. Two of the three failed on that while looking like a defect
 * in the argument handling. `question` and `answer` are deliberately outside the task requirement
 * (`LIFECYCLE_KINDS` in `server/src/tasks.ts`), which makes `question` the kind that reaches the
 * code under test.
 */
const both = refuse([SEND, '--to', 'Worker', '--kind', 'question', '--file', bodyPath, '--text', 'hello'].slice(1))
check('passing --file and --text at once is refused', /Nothing was sent/.test(both), both.split('\n')[0])

const missing = refuse(['--to', 'Worker', '--kind', 'question', '--file', join(outbox, 'not-here.md')])
check(
  'a --file that is not there is refused, and the refusal names the path',
  /Nothing was sent/.test(missing) && missing.includes(resolve(join(outbox, 'not-here.md'))),
  missing.split('\n')[0],
)

writeFileSync(join(outbox, 'blank.md'), '   \n', 'utf8')
const blank = refuse(['--to', 'Worker', '--kind', 'question', '--file', join(outbox, 'blank.md')])
check('an empty file is refused rather than posted as a blank entry', /Nothing to send/.test(blank), blank.split('\n')[0])

await sleep(600)
const after = readFileSync(join(board.home, 'mail', worker.id, 'INBOX.md'), 'utf8')
check('and none of those refusals put anything in the inbox', before === after, `${before.length} then ${after.length} bytes`)

await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
