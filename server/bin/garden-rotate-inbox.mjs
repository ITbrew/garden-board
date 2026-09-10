/**
 * Keeping a mailbox readable, because nothing else does.
 *
 * `postMessage` caps a single entry at 8000 characters, which stops one agent pasting a file into a
 * message and growing the file without bound. **It does not cap the FILE.** `INBOX.md` and `SENT.md`
 * are appended to for the life of a card, and on this board the orchestrator's inbox reached 8.7 MB
 * and about 170,000 lines in nine days, with four more mailboxes between 1 and 2.5 MB.
 *
 * That matters because of what the card is told when mail arrives: "Read your INBOX.md before you
 * continue." A card that does what it is told reads a file whose size is the board's entire history,
 * and the owner pays for it. The orchestrator survived the week only by never reading its own inbox
 * whole: every read was a `grep` for the last header and a `sed` range after it, which works and is
 * not what the instruction says.
 *
 * So this moves everything except the most recent messages into `INBOX-archive.md` beside it, oldest
 * first, and leaves a line at the top of the trimmed file saying where the rest went. Nothing is
 * deleted, and the archive is append-only in the same order the messages arrived.
 *
 * Usage:
 *   node <this>                  report what it WOULD move. Changes nothing.
 *   node <this> --keep 40        keep the newest 40 messages, archive the rest
 *   node <this> --apply          do it, keeping the default 30
 *
 * By default it only touches the mailbox of the card that runs it, because a tool that can rewrite
 * another card's inbox is a tool that can lose its mail.
 *
 * `--card <id>` lifts that, and exists because board maintenance is a real job that belongs to
 * somebody. The owner asked the orchestrator to trim every oversized mailbox on his board, and the
 * alternative to a documented flag was setting `GARDEN_SESSION_ID` to another card's id on the
 * command line, which is the same power with none of the intent written down. A loophole around a
 * rule this file states in its own header is worse than an argument that says who it is for.
 *
 *   node <this> --card <id> --apply
 *
 * It is not a per-card restriction the server enforces; nothing here can check who is asking. It is
 * a statement of who it is FOR, which is the orchestrator doing maintenance, and a card that reaches
 * for it to trim a peer is doing something it should not.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ME = process.env.GARDEN_SESSION_ID || null

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const FLAGS = new Set(['--apply', '--keep', '--card'])
const opts = {}
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]
  if (!FLAGS.has(token)) fail(`I do not know the argument "${token}". I take --apply, --keep <n> and --card <id>.`)
  if (token in opts) fail(`${token} was given twice.`)
  if (token === '--apply') {
    opts[token] = true
    continue
  }
  const value = argv[++i]
  if (value === undefined) fail(`${token} was given with nothing after it.`)
  if (token === '--card') {
    opts[token] = String(value).trim()
    continue
  }
  const n = Number(value)
  /*
   * Zero is allowed and means empty the inbox completely, archiving everything.
   *
   * It was rejected in the first version because keeping nothing looked like a mistake. It is not:
   * the owner asked for a clean board, and every message still exists in INBOX-archive.md in order.
   * What it DOES cost is visibility of anything unacted, so the caller is warned rather than stopped.
   */
  if (!Number.isInteger(n) || n < 0) fail(`--keep needs a whole number of messages, not "${value}".`)
  opts[token] = n
}

const TARGET = opts['--card'] ?? ME
if (!TARGET) {
  fail(
    'GARDEN_SESSION_ID is not set and no --card was given, so I cannot tell whose\n' +
      'mailbox to work on.',
  )
}
if (opts['--card'] && opts['--card'] !== ME) {
  // Named out loud rather than done quietly, so a log of this run says whose mail moved.
  process.stdout.write(`Working on ANOTHER card's mailbox: ${TARGET}\n\n`)
}

const KEEP = opts['--keep'] ?? 30
const dir = join(homedir(), '.garden', 'mail', TARGET)
const inbox = join(dir, 'INBOX.md')
const archive = join(dir, 'INBOX-archive.md')
if (!existsSync(inbox)) fail(`There is no inbox at ${inbox}.`)

const text = readFileSync(inbox, 'utf8')
const lines = text.split('\n')

/*
 * Messages are cut on the header the server writes and nothing else.
 *
 * A body contains blank lines and its own markdown headings, so a splitter keyed on either would cut
 * a message in half and archive the top of it while leaving the bottom, which is worse than leaving
 * the file alone. If the header pattern ever changes this finds zero messages and refuses, rather
 * than guessing at a boundary.
 */
const HEADER = /^## From .+?, \d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*$/
const starts = []
for (let i = 0; i < lines.length; i++) if (HEADER.test(lines[i])) starts.push(i)

if (starts.length === 0) {
  fail(
    'Found no message headers in that inbox, so I do not know where one message ends\n' +
      'and the next begins. Nothing was changed.',
  )
}

const sizeKb = Math.round(statSync(inbox).size / 1024)
if (starts.length <= KEEP) {
  process.stdout.write(
    `${starts.length} messages, ${sizeKb} KB. Keeping ${KEEP}, so there is nothing to move.\n`,
  )
  process.exit(0)
}

// Everything before the header of the KEEP-th newest message is what moves.
/*
 * With KEEP of zero the cut is past the last message rather than at a header, so the index is the
 * line count and not an entry in `starts`. Reading `starts[starts.length]` would be undefined and
 * the slices would silently produce an inbox identical to the original.
 */
const cutAt = KEEP === 0 ? lines.length : starts[starts.length - KEEP]
const preamble = lines.slice(0, starts[0]).join('\n')
const moving = lines.slice(starts[0], cutAt).join('\n')
const staying = lines.slice(cutAt).join('\n')
const movedCount = starts.length - KEEP

if (!opts['--apply']) {
  process.stdout.write(
    `${starts.length} messages, ${sizeKb} KB.\n` +
      `Would move the oldest ${movedCount} to INBOX-archive.md and keep the newest ${KEEP}.\n` +
      `That takes the inbox to about ${Math.round(Buffer.byteLength(staying) / 1024)} KB.\n\n` +
      'Nothing was changed. Pass --apply to do it.\n',
  )
  process.exit(0)
}

/*
 * The archive is appended to and the inbox is rewritten, in that order.
 *
 * If the append succeeds and the rewrite fails, the mail exists twice, which is recoverable by
 * reading. If the rewrite went first and the append failed, it would exist nowhere. The order is the
 * whole safety of this and it is worth a sentence rather than a comment saying "append first".
 */
const priorArchive = existsSync(archive) ? readFileSync(archive, 'utf8').replace(/\n*$/, '\n\n') : `# Archived mail\n\n`
writeFileSync(archive, priorArchive + moving.replace(/\n*$/, '\n'))

const note =
  `${preamble ? `${preamble.replace(/\n*$/, '')}\n\n` : ''}` +
  `*[${movedCount} older messages were moved to INBOX-archive.md beside this file. ` +
  `They are not lost and they are in the order they arrived.]*\n\n`
writeFileSync(inbox, note + staying.replace(/\n*$/, '\n'))

process.stdout.write(
  `Moved ${movedCount} messages to ${archive}.\n` +
    `Inbox is now ${Math.round(statSync(inbox).size / 1024)} KB, was ${sizeKb} KB.\n`,
)
