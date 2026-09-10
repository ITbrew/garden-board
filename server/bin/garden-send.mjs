/**
 * How an agent hands work along a wire.
 *
 * Until this existed, a wire permitted a message that nothing could actually send: `wire.send`
 * arrives over the WebSocket, which only the owner's hands reach, so a manager had no way to give
 * its worker anything. The chain was drawn and could not be walked.
 *
 * The sender never names itself. `GARDEN_SESSION_ID` is set when Garden spawns the shell and
 * inherited by everything under it, which is the same thread the hook spine already runs on: it is
 * a fact about which terminal this is, not a claim the agent makes about itself. An agent that
 * deliberately overrode that variable could lie, and that is written down rather than pretended
 * away.
 *
 * Usage, from inside a session. Write the message to a file with a file writing tool, then name it:
 *   node <this> --to <card id> --kind done --task T-12 --file "<mail dir>/outbox/T-12.md"
 *   node <this> --to "Loader team" --kind work --task T-12 --text "one short line, no quotes"
 *
 * The body never goes inside the command, and both remaining ways of doing that are kept only for
 * what already uses them. A quote inside a --text value is reopened by the shell before this script
 * runs and the tail of the message is lost. A heredoc survives the quoting and then hits a harder
 * wall: the command carrying it has to be security scanned before it runs, and a few thousand
 * characters of prose cannot be, so the card stops and waits for the owner to approve it by hand.
 *
 * The kind is required rather than guessed from the text, because guessing it from prose is exactly
 * the inference this app exists to refuse. Which kinds exist is the server's business and not
 * repeated here: this file used to keep its own copy of the list, which is the same two-lists
 * arrangement that once had Garden telling managers in writing about a denial it had not written.
 * An unknown kind comes back from the server as a refusal naming every kind it does accept.
 */
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PORT = Number(process.env.GARDEN_PORT) || 5178

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/*
 * The token proves which card this is, where `GARDEN_SESSION_ID` above only claims it.
 *
 * Both are set by Garden when it spawns the shell, so on an honest card they agree and this changes
 * nothing at all. The difference is what a dishonest one can do: the id is a string a card can
 * overwrite, and the token is checked against a table the server minted and never wrote down, so a
 * card presenting itself as another card is caught rather than only written down as possible, which
 * is what the paragraph at the top of this file used to have to admit.
 *
 * Absent, the server falls back to the id and records that the sender was unverified. That is on
 * purpose: every terminal already running when this lands has no token, and mail that stops working
 * for those cards would be a worse failure than mail that is merely less well attested.
 */
const authHeaders = () =>
  process.env.GARDEN_SESSION_TOKEN
    ? { authorization: `Bearer ${process.env.GARDEN_SESSION_TOKEN}` }
    : {}

/*
 * Why the command line is walked in pairs instead of searched with indexOf.
 *
 * Windows PowerShell 5.1 rebuilds the command line when it invokes node.exe and does not escape a
 * double quote sitting inside an argument value. The value closes early at that quote and the rest
 * of the message arrives as stray argv entries. That loss happens before this script's first line,
 * so nothing here can recover the message; the only question is whether Garden notices. The old
 * `indexOf` lookup stepped over every unrecognised token in silence, which is exactly what a
 * shattered tail looks like, so half a message was posted, the server returned 200, and SENT.md
 * recorded the fragment as though it were what the card wrote. Well formed output at every surface
 * and nothing to go looking at.
 *
 * The proof of the damage is sitting in argv, so this reads it: every token at an even offset from
 * the script path must be a known flag, and no flag may appear twice. Silent truncation becomes an
 * error at the instant it happens, and nothing is sent.
 *
 * Walking in order also closes a second hole. `indexOf` returns the first match, so a fragment that
 * happens to read `--kind` could be picked up as the real kind whenever it landed earlier in argv
 * than the genuine flag, falsifying the metadata while every surface still read as a delivery. That
 * was order dependent rather than general, and it is gone either way now.
 *
 * What this still cannot catch, stated rather than pretended away: a shattered tail that happens to
 * consist entirely of alternating known-flag-then-value pairs with no repeats would parse. Prose
 * does not usually shatter into that shape, but it is not impossible, and it is the reason the
 * documentation half of this matters. stdin never has this problem at all.
 */
const FLAGS = new Set(['to', 'to-many', 'kind', 'task', 'text', 'file'])
const flags = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const token = process.argv[i]
  const name = token.startsWith('--') ? token.slice(2) : null
  if (name === null || !FLAGS.has(name)) {
    /*
     * Every line here is kept under 80 characters on purpose, and the same goes for the other
     * refusals below. Windows PowerShell 5.1 hard wraps a native command's stderr at around 117
     * columns including the prefix it adds, and a break landing between two words reads to whoever
     * relays it as though this file had emitted two lines. Wrapping it here means the wrap never
     * happens there, so a refusal read off a console is the same text as the bytes.
     */
    fail(
      `Nothing was sent. Unrecognised argument: ${JSON.stringify(token)}\n` +
        'Your shell probably reopened the command line at a quote inside your\n' +
        'message, so the rest of it arrived as stray arguments and only the part\n' +
        'before the quote would have been delivered.\n' +
        'Pipe the message in on stdin instead of passing --text.',
    )
  }
  if (flags.has(name)) {
    fail(
      `Nothing was sent. --${name} was given twice.\n` +
        'If you only wrote it once, your shell broke your message apart at a quote\n' +
        'and part of it is now being read as a flag.\n' +
        'Pipe the message in on stdin instead of passing --text.',
    )
  }
  flags.set(name, process.argv[i + 1])
}

function arg(name) {
  return flags.get(name)
}

const to = arg('to')
const toMany = arg('to-many')
const kind = arg('kind')
const task = arg('task') ?? null
const inline = arg('text')
const fromFile = arg('file')

/*
 * Sending one message to several cards, without weakening the check that catches a shattered line.
 *
 * `--to` deliberately refuses to appear twice, because a message broken apart at a quote arrives as
 * exactly that shape and the refusal is how the break is noticed. So a broadcast cannot be spelled
 * as a repeated `--to` without giving that up. It gets its own flag instead.
 *
 * Measured cost of not having it: on 2026-08-20 the owner reached 95 percent of his weekly usage
 * and asked for every card to stop. That took fifteen separate invocations of this command, and
 * every card then had to READ the message, which he also paid for.
 *
 * Two rules, both learned from that stop rather than imagined:
 *   a broadcast must come from a FILE, never from --text. A shattered inline body sent to one card
 *   is one bad message; sent to fifteen it is fifteen, and the sender sees fifteen successes.
 *   a broadcast is announced as one. The output says which names it resolved BEFORE it sends
 *   anything, so a typo in a list of fifteen is caught while it is still cheap.
 */
const recipients = (() => {
  if (to && toMany) {
    fail(
      'Nothing was sent. --to and --to-many were both given.\n' +
        'Use --to for one card, or --to-many "A, B, C" for several.',
    )
  }
  if (!toMany) return to ? [to] : []
  if (inline) {
    fail(
      'Nothing was sent. --to-many needs --file rather than --text.\n' +
        'A message broken apart by the shell is one bad send to one card and\n' +
        'many bad sends to many, and every one of them reports success.\n' +
        'Write the message to a file and pass --file <path>.',
    )
  }
  const names = String(toMany)
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
  if (names.length === 0) fail('Nothing was sent. --to-many was given with no names in it.')
  const seen = new Set()
  for (const n of names) {
    const key = n.toLowerCase()
    if (seen.has(key)) {
      fail(`Nothing was sent. "${n}" is in the list twice, so it would get the message twice.`)
    }
    seen.add(key)
  }
  return names
})()

/**
 * The message read off disk, which is the form that is always safe to run.
 *
 * Every other way of getting a body into this script puts the body inside the command that runs it,
 * and that is now a wall rather than a risk. Claude Code splits a command on its separators and
 * checks each part on its own, so `cat <<'EOF' | node <this>` is two commands: the `node` half is
 * allowed by name in the card's settings and never in question, and the `cat` half is the whole
 * message, matches nothing, and goes to a classifier that refuses anything it cannot scan:
 *
 *   Command exceeds the maximum analyzable length; its full text cannot be
 *   security-scanned and requires human review.
 *
 * The card then stops and waits for the owner to answer a prompt. Measured on his board over three
 * days: 274 sends, and 133 of them at or over the size that was refused. It is the median message,
 * not the rare enormous one, and each refusal cost him a card sitting idle until he noticed.
 *
 * A path costs the same number of characters whatever is in the file, so this shape has no size at
 * which it starts failing. The file is read whole rather than streamed because a message is small by
 * any file standard and a partial read here would be the truncation this file exists to prevent.
 */
function readFromFile(path) {
  const full = resolve(path)
  let raw
  try {
    raw = readFileSync(full, 'utf8')
  } catch (err) {
    fail(
      `Nothing was sent. Could not read ${full}\n` +
        `${err.code === 'ENOENT' ? 'There is no file there.' : err.message}\n` +
        'Write the message to a file first, with your file writing tool rather\n' +
        'than with a shell command, and pass that exact path to --file.',
    )
  }
  // A file written on Windows can start with a byte-order mark, which is invisible in every editor
  // and would land at the top of the recipient's INBOX.md as a stray character.
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

if (!process.env.GARDEN_SESSION_ID) {
  fail('This terminal was not started by Garden, so it has no card to send from.')
}
if (!to && !toMany) {
  fail(
    'Who to? Pass --to with a card title or id, or --to-many "A, B, C" for\n' +
      'several. Your PEERS.md lists who you may send to.',
  )
}
if (!kind) fail('Pass --kind. Your PEERS.md lists the kinds and what each one means.')

/*
 * A lifecycle kind with no task id is refused here, before the message is read and before anything
 * is posted.
 *
 * The server refuses it too, and that refusal is the one that counts. This is earlier and cheaper:
 * the card learns it forgot the flag without having its body read, and the wording is the server's
 * own sentence rather than a second one written here, so the two cannot drift into disagreeing about
 * why. That is why both the list and the sentence are imported from the file the server decides with
 * instead of being copied, which is the arrangement this file's own header warns about.
 *
 * Wrapped, and silent when it fails, on purpose. This module is TypeScript and is read by Node's own
 * type stripping; if some future Node cannot, the right outcome is a send that is checked one step
 * later by the server rather than a card that can no longer send mail at all. A convenience must
 * never be able to take the wire down.
 */
try {
  const tasks = await import('../src/tasks.ts')
  if (!task && tasks.isLifecycleKind(kind)) fail(`Nothing was sent. ${tasks.taskRequiredReason(kind)}`)
} catch (err) {
  // `fail` exits the process rather than throwing, so a refusal above cannot be swallowed here.
  if (process.env.GARDEN_DEBUG) process.stderr.write(`[garden-send] no local task check: ${err.message}\n`)
}

/*
 * Reading stdin without ever hanging, and without inventing a new way to truncate.
 *
 * A card that hedges by passing --text and piping the same message in used to lose the piped copy
 * without a word, which is the wrong half to drop: the piped one is the one that survived the
 * shell intact. So stdin is consulted even when --text is present, and both copies together are a
 * refusal rather than a guess.
 *
 * That consultation cannot be an open-ended await, which is what it was and which hung. `isTTY`
 * only covers a human at a terminal. A wrapper, a hook or a scheduled step hands its child an
 * inherited pipe that is not a tty, never carries a byte and never closes, and an unbounded read
 * of that never returns: the card produces no output at all, and a hang is worse than a refusal
 * because there is nothing to read and nothing to relay. Measured rather than argued: with an idle
 * stdin pipe, a send carrying a complete --text message sat for six seconds and was still going.
 *
 * Bounded, in three parts, and the third is the one that keeps this honest:
 *
 *   - Waiting for the FIRST byte is bounded. Nothing arrives in the window and stdin is treated as
 *     empty, which is exactly what an idle inherited pipe deserves. The window is short when
 *     --text was given, since stdin is only being consulted to catch a card sending both, and
 *     longer when it was not, since then stdin IS the message and something is genuinely expected.
 *   - Once bytes start arriving the stream must reach end of file. An idle gap mid-message is a
 *     REFUSAL, never a send of what turned up so far. Delivering a partial message on a timer would
 *     be this file's original defect rebuilt with a clock instead of a quote, so it is the one
 *     outcome that must not exist.
 *   - A tty short-circuits immediately, as before, because a human at a terminal is not piping.
 */
const FIRST_BYTE_WAIT_MS = inline || fromFile ? 1000 : 10000
const MID_MESSAGE_IDLE_MS = 10000

const readStdin = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({ text: '', truncated: false })

    let text = ''
    let timer = null
    const settle = (truncated) => {
      if (timer) clearTimeout(timer)
      process.stdin.pause()
      resolve({ text, truncated })
    }
    // Unref'd so a pending timer can never be the only thing keeping the process alive.
    const arm = (ms, onExpiry) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(onExpiry, ms)
      timer.unref()
    }

    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      text += chunk
      arm(MID_MESSAGE_IDLE_MS, () => settle(true))
    })
    process.stdin.on('end', () => settle(false))
    process.stdin.on('error', () => settle(false))
    arm(FIRST_BYTE_WAIT_MS, () => settle(false))
  })

const read = async () => {
  const { text: raw, truncated } = await readStdin()
  const piped = raw.trim()

  if (truncated) {
    fail(
      'Nothing was sent. Your message started arriving on stdin and then\n' +
        `stopped for ${MID_MESSAGE_IDLE_MS / 1000} seconds without ending, so Garden cannot tell\n` +
        'whether it was complete. It has not been delivered in part.\n' +
        'Send it again once whatever is producing it has finished.',
    )
  }
  /*
   * Two sources is a refusal, never a guess, and that rule now has three pairs rather than one.
   *
   * It is the same reasoning each time. Garden cannot tell which copy the card meant, the two are
   * not always the same text, and picking one silently means a card can be told its message went
   * while a different message went. Refusing costs a turn. Guessing costs the truth.
   */
  if (fromFile && inline) {
    fail(
      'Nothing was sent. You passed both --file and --text, and Garden will\n' +
        'not guess which one you meant.\n' +
        'Send one or the other. --file is the one with no size limit.',
    )
  }
  if (fromFile && piped) {
    fail(
      'Nothing was sent. You passed --file and also piped a message in, and\n' +
        'Garden will not guess which one you meant.\n' +
        'Send one or the other. --file is the one with no size limit.',
    )
  }
  if (inline && piped) {
    fail(
      'Nothing was sent. You passed --text and also piped a message in, and\n' +
        'Garden will not guess which one you meant.\n' +
        'Send one or the other. Stdin is the one that survives quotes.',
    )
  }
  if (fromFile) return readFromFile(fromFile)
  return inline ?? piped
}

const text = (await read()).trim()
if (!text) {
  if (fromFile) {
    fail(
      `Nothing to send. ${resolve(fromFile)} is there and holds nothing.\n` +
        'An empty file is not an empty message, so Garden refused rather than\n' +
        'posting a blank entry with your name on it. Write the message, then\n' +
        'run this again.',
    )
  }
  fail(
    'Nothing to send. Write the message to a file and pass --file, or pass\n' +
      '--text for a single short line.\n' +
      'If you did pipe something, nothing arrived within\n' +
      `${FIRST_BYTE_WAIT_MS / 1000} seconds, so check that whatever feeds this command\n` +
      'actually wrote something and closed.',
  )
}

/**
 * How long a piped message has to be before this suggests the file form on the way out.
 *
 * Set below the smallest refusal actually observed rather than at it. On his board a 1782 character
 * command was kicked to human review and a 634 character one was not, so the line is somewhere
 * between; the useful place to speak up is before a card reaches it, not after.
 */
const HINT_AT = 1200

/** One send. Resolves rather than throwing, so one refusal does not abandon the rest of a list. */
function sendTo(name) {
  const body = JSON.stringify({
    from: process.env.GARDEN_SESSION_ID,
    to: name,
    kind,
    taskId: task,
    text,
  })
  return new Promise((done) => {
    const r = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/mail',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...authHeaders(),
        },
      },
      (res) => {
        let out = ''
        res.on('data', (c) => (out += c))
        res.on('end', () => done({ name, ok: res.statusCode === 200, out: out.trim() }))
      },
    )
    r.on('error', (e) => done({ name, ok: false, out: `Garden is not answering: ${e.message}` }))
    r.end(body)
  })
}

if (recipients.length > 1) {
  /*
   * The names are printed before anything is sent, and the failures are counted after.
   *
   * A broadcast that reports fifteen lines of mixed success and refusal, with no total, is a wall
   * a sender skims. The last line is the one that has to be true at a glance.
   */
  process.stdout.write(`Sending to ${recipients.length} cards: ${recipients.join(', ')}\n\n`)
  const results = []
  for (const name of recipients) results.push(await sendTo(name))
  for (const r of results) process.stdout.write(`${r.ok ? '  ok    ' : '  FAILED'} ${r.name}: ${r.out}\n`)
  const bad = results.filter((r) => !r.ok)
  process.stdout.write(
    `\n${results.length - bad.length} of ${results.length} delivered.` +
      (bad.length ? ` FAILED: ${bad.map((r) => r.name).join(', ')}\n` : '\n'),
  )
  process.exit(bad.length ? 1 : 0)
}

const body = JSON.stringify({ from: process.env.GARDEN_SESSION_ID, to, kind, taskId: task, text })

const req = request(
  {
    host: '127.0.0.1',
    port: PORT,
    path: '/mail',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...authHeaders(),
    },
  },
  (res) => {
    let out = ''
    res.on('data', (c) => (out += c))
    res.on('end', () => {
      // The refusal reason is the useful part, so it goes to stderr in full rather than as a code.
      if (res.statusCode !== 200) fail(out || `Garden refused with ${res.statusCode}`)
      process.stdout.write(`${out}\n`)
      /*
       * The one thing that reaches a card already running on the old instructions.
       *
       * A card reads PEERS.md when its session starts and reasons from that copy for the rest of its
       * life, so rewriting the file changes nothing for anything currently working. This message went
       * through, which means the command carrying it was under whatever the classifier will scan, and
       * the next slightly longer one may not be. Printed after the answer rather than instead of it,
       * and only when the body was big enough for the question to be live.
       *
       * Under 80 columns for the reason the refusals above are: PowerShell hard wraps a native
       * command's output around 117 columns including its own prefix, and a break landing mid
       * sentence reads to whoever relays it as though this file emitted two lines.
       */
      if (!fromFile && text.length > HINT_AT) {
        process.stdout.write(
          '\nThat message was long enough to be worth sending a different way.\n' +
            'Write the next one to a file and pass --file <path> instead of piping\n' +
            'it in. A message inside the command has to be security scanned before\n' +
            'it runs, and past a few thousand characters that stops and waits for\n' +
            'the owner. A path is the same length whatever is in the file.\n',
        )
      }
      process.exit(0)
    })
  },
)
req.on('error', (e) => fail(`Garden is not answering on port ${PORT}: ${e.message}`))
req.end(body)
