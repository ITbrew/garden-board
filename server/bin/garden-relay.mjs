/**
 * Mail between two Garden boards that do not share a machine.
 *
 * `garden-send.mjs` posts to the server on 127.0.0.1, which is the right answer for two cards on
 * one board and no answer at all for a card on the owner's other PC. There is no socket between the
 * two machines and there should not be one: opening a port on a home network to carry agent mail is
 * a larger decision than the problem needs. What the two machines already share is a folder, an SMB
 * share mounted at `Z:` on this one, and a folder is enough to carry mail if the protocol is honest
 * about what a folder can and cannot promise.
 *
 * So this is a spool, not a transport. One side writes a file. The other side, whenever it next
 * looks, finds it. Nothing here assumes the other board is running, or reachable, or even exists
 * yet, because for most of the day it will not be.
 *
 * ## Layout on the share
 *
 *   <root>/
 *     <board id>/inbox/       messages addressed TO that board, written BY the other one
 *     <board id>/delivered/   what this board has already handed to its own server
 *
 * A board only ever writes into somebody else's `inbox` and into its own `delivered`. It never
 * edits another board's `delivered` and never rewrites a message it did not write. That one rule is
 * what keeps two writers on one folder from needing a lock.
 *
 * ## Why the write is a rename
 *
 * A file appearing on an SMB share is not atomic: the other side can list the directory while half
 * the bytes are there and read a truncated message as though it were the whole one. So every
 * message is written to a temporary name in the same directory and then renamed into place, because
 * rename within a directory is atomic and a reader either sees the old state or the complete file.
 * The temp name starts with a dot so a reader skipping dotfiles cannot pick one up even mid-write.
 *
 * ## Why delivery is idempotent
 *
 * A pull can die between posting a message to the local server and recording that it did. Rerunning
 * it must not deliver the same message twice, and the marker for that has to survive a restart, so
 * it is a file rather than anything in memory: the message is MOVED into `delivered/` once the
 * server has taken it. A message in `inbox/` has not been delivered, a message in `delivered/` has,
 * and there is no third state to get wrong.
 *
 * Usage:
 *   node garden-relay.mjs --send --to-board <id> --to "<card>" --kind work --task <id> --file <f>
 *   node garden-relay.mjs --pull
 *   node garden-relay.mjs --watch 15
 *   node garden-relay.mjs --list
 *   node garden-relay.mjs --init --to-board <id>
 *
 * ## One folder, two names
 *
 * The share is this machine's `E:\`, shared over the network, and the other PC mounts
 * it at `Z:`. So `E:\garden-mail` here and `Z:\garden-mail` there are the same directory, and
 * neither board needs to know which name the other one uses.
 *
 * That also explains a dead end worth recording, because it cost an afternoon. An agent sandboxed
 * on this machine cannot open `Z:\` or the share's network path at all, even though `net use` reports
 * the mapping as OK and even though both resolve back to the same disk it is already working on.
 * Network paths are refused as a class, and a loopback share is still a network path. The fix is not
 * a permission rule, it is to address the folder by its local name.
 *
 * Environment:
 *   GARDEN_RELAY_ROOT   where the shared folder is, from THIS machine's point of view. Unset, the
 *                       local name is tried before the network one, because a sandbox that refuses
 *                       `Z:` will happily open `E:`.
 *   GARDEN_BOARD_ID     what this board is called on the share. Required, and deliberately so:
 *                       a default would let both machines call themselves the same thing and each
 *                       deliver its own outgoing mail straight back to itself.
 *   GARDEN_PORT         the local Garden server. Default 5178.
 */
import { request } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, parse } from 'node:path'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.GARDEN_PORT) || 5178
/*
 * The local name first. On the machine that hosts the share these are the same folder, and only one
 * of the two can actually be opened from inside a sandbox.
 */
function resolveRoot() {
  if (process.env.GARDEN_RELAY_ROOT) return process.env.GARDEN_RELAY_ROOT
  for (const candidate of ['E:\\garden-mail', 'Z:\\garden-mail']) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // An unreachable drive throws rather than returning false. That is a "no", not a crash.
    }
  }
  return 'E:\\garden-mail'
}

const ROOT = resolveRoot()
const BOARD = process.env.GARDEN_BOARD_ID || ''

const KINDS = new Set(['work', 'question', 'answer', 'review', 'done', 'confirm', 'assessment', 'remediation'])

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/*
 * The command line is walked in pairs rather than searched, for the same reason garden-send.mjs
 * does it: on PowerShell 5.1 a quote inside an argument reopens the command line and the tail
 * arrives as stray tokens. An unrecognised token is the visible proof that happened, so it is a
 * refusal rather than something to step over. Half a message sent while every surface reads as
 * success is the failure this avoids.
 */
const FLAGS = new Set(['--to-board', '--to', '--kind', '--task', '--file', '--from', '--watch'])
const BARE = new Set(['--send', '--pull', '--list', '--init', '--yes'])

function parseArgs(argv) {
  const out = {}
  let i = 0
  while (i < argv.length) {
    const token = argv[i]
    if (BARE.has(token)) {
      if (out[token] !== undefined) fail(`Nothing was done. Repeated flag: ${token}`)
      out[token] = true
      i += 1
      continue
    }
    if (!FLAGS.has(token)) {
      fail(
        `Nothing was done. Unrecognised argument: ${JSON.stringify(token)}\n` +
          'Your shell probably reopened the command line at a quote, so the\n' +
          'rest arrived as stray arguments. Put the message in a file and\n' +
          'name it with --file rather than inlining it.',
      )
    }
    if (out[token] !== undefined) fail(`Nothing was done. Repeated flag: ${token}`)
    const value = argv[i + 1]
    if (value === undefined) fail(`Nothing was done. ${token} was given no value.`)
    out[token] = value
    i += 2
  }
  return out
}

/** The share, checked in a way that says which of the two failures it was. */
function requireRoot() {
  if (!existsSync(ROOT)) {
    fail(
      `The relay root is not reachable: ${ROOT}\n` +
        'That is either the share being offline or this process not being allowed\n' +
        'to see it. Neither is something to retry in a loop. Check the mapping\n' +
        "with `net use` before assuming the other board is at fault.",
    )
  }
}

function requireBoard() {
  if (!BOARD.trim()) {
    fail(
      'Nothing was done. GARDEN_BOARD_ID is not set.\n' +
        'Each board needs its own name on the share. If both machines used the\n' +
        'same one, each would deliver its own outgoing mail back to itself and\n' +
        'the other board would never see a thing.',
    )
  }
}

function boardDirs(id) {
  const base = join(ROOT, id)
  return { base, inbox: join(base, 'inbox'), delivered: join(base, 'delivered') }
}

function ensureBoard(id) {
  const d = boardDirs(id)
  mkdirSync(d.inbox, { recursive: true })
  mkdirSync(d.delivered, { recursive: true })
  return d
}

/** Message files only. Dotfiles are half-written temporaries by construction. */
function messageFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    .sort()
}

function doInit(args) {
  requireBoard()
  /*
   * The one action that is allowed to create the root, since creating it is the point. What it will
   * not do is create a drive: if the share itself is missing, `mkdir -p` on `Z:\garden-mail` would
   * otherwise fail with something about a path rather than about a disconnected share.
   */
  const drive = parse(ROOT).root
  if (drive && !existsSync(drive)) {
    fail(
      `Nothing was created. The drive is not reachable: ${drive}\n` +
        'On the machine hosting the share this should be a local path. A sandboxed\n' +
        'process cannot open a network path at all, including one that loops back to\n' +
        'its own disk, so prefer the local name over the mapped letter.',
    )
  }
  mkdirSync(ROOT, { recursive: true })
  ensureBoard(BOARD)
  const peer = args['--to-board']
  if (peer) ensureBoard(peer)
  process.stdout.write(
    `Ready on ${ROOT}\n` +
      `  this board: ${BOARD}\n` +
      (peer ? `  peer board: ${peer}\n` : '  no peer named, so only this board was created\n'),
  )
}

function doSend(args) {
  requireRoot()
  requireBoard()
  const toBoard = args['--to-board']
  const to = args['--to']
  const kind = args['--kind']
  const task = args['--task']
  const file = args['--file']

  if (!toBoard) fail('Nothing was sent. --to-board names the board on the other machine.')
  if (!to) fail('Nothing was sent. --to names the card on that board.')
  if (!kind) fail('Nothing was sent. --kind is required.')
  if (!KINDS.has(kind)) fail(`Nothing was sent. Unknown kind ${JSON.stringify(kind)}.`)
  if (!task) fail('Nothing was sent. --task ties the conversation together.')
  if (!file) fail('Nothing was sent. --file names the file holding the body.')
  if (toBoard === BOARD) {
    fail(
      `Nothing was sent. --to-board is this board (${BOARD}).\n` +
        'Mail to a card on this board goes through garden-send.mjs, which hands it\n' +
        'to the server directly. The relay is only for the other machine.',
    )
  }
  if (!existsSync(file)) fail(`Nothing was sent. No such file: ${file}`)

  const text = readFileSync(file, 'utf8')
  if (!text.trim()) fail('Nothing was sent. The message body is empty.')

  const id = randomUUID()
  const envelope = {
    id,
    fromBoard: BOARD,
    fromCard: args['--from'] || process.env.GARDEN_SESSION_ID || null,
    to,
    kind,
    taskId: task,
    sentAt: new Date().toISOString(),
    text,
  }

  const d = ensureBoard(toBoard)
  const name = `${envelope.sentAt.replace(/[:.]/g, '-')}-${id}.json`
  // Temp in the SAME directory, then rename: across directories a rename is a copy and stops
  // being atomic, which is the whole point of doing it this way.
  const tmp = join(d.inbox, `.${id}.tmp`)
  writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf8')
  renameSync(tmp, join(d.inbox, name))

  process.stdout.write(
    `Spooled for ${toBoard}: ${name}\n` +
      'Spooled is not delivered. It reaches the card when that board next pulls.\n',
  )
}

/*
 * Garden's `/mail` will not take a message from nobody, and the first version of this file tried to
 * send one.
 *
 * `resolveSender` decides who a request is from by the token Garden minted for the card running the
 * command, falling back to the `from` id in the body. This sent `from: null` and no token, so both
 * were absent and every pulled message was refused with "the card sending this is not one Garden
 * knows". Found by the orchestrator on the other board, which tested a pull before I did and read
 * both servers' handlers to explain it.
 *
 * So a pull is not a neutral act of plumbing. It is a card on this board delivering mail under its
 * own name, and the consequences follow from that rather than being worked around:
 *
 *   - `--pull` has to run inside a card's shell, because that is where the two variables exist.
 *   - Every wire check applies to the pulling card. It must be wired to each recipient.
 *   - Garden refuses `a card cannot send to itself`, so the pulling card can never be a recipient.
 *     That is the argument for a dedicated bridge card rather than pulling as the orchestrator.
 *
 * `from` is still sent alongside the token, exactly as garden-send.mjs does, because a terminal that
 * was already open when tokens landed has no token and the id keeps mail working for it.
 */
function postLocal(envelope) {
  const body = JSON.stringify({
    from: process.env.GARDEN_SESSION_ID ?? null,
    to: envelope.to,
    kind: envelope.kind,
    taskId: envelope.taskId,
    // Where it came from is part of the message rather than a header, because the receiving card
    // reads prose and would otherwise have no way to know this did not come from its own board.
    text:
      `[relayed from board "${envelope.fromBoard}"` +
      (envelope.fromCard ? `, card ${envelope.fromCard}` : '') +
      `, sent ${envelope.sentAt}]\n\n${envelope.text}`,
  })
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/mail',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(process.env.GARDEN_SESSION_TOKEN
            ? { authorization: `Bearer ${process.env.GARDEN_SESSION_TOKEN}` }
            : {}),
        },
      },
      (res) => {
        let out = ''
        res.on('data', (c) => (out += c))
        res.on('end', () =>
          resolve({
            ok: res.statusCode === 200,
            // Garden accepted this but could not prove who sent it. Under `shadow` that is a plain
            // 200, so without this header a stale token is invisible to the sender.
            unverified: res.headers['x-garden-sender-unverified'] === '1',
            out: out.trim(),
          }),
        )
      },
    )
    // `transport` separates "Garden did not answer" from "Garden answered and said no". The caller
    // turns that into the exit code, because retrying helps the first and never helps the second.
    req.on('error', (e) =>
      resolve({ ok: false, transport: true, out: `Garden is not answering on port ${PORT}: ${e.message}` }),
    )
    req.write(body)
    req.end()
  })
}

/**
 * One sweep of this board's inbox. No printing of summaries, no exit code, no assumptions about
 * being run once, so `--pull` and `--watch` share a body rather than drifting apart.
 */
async function pullOnce() {
  const d = ensureBoard(BOARD)
  const files = messageFiles(d.inbox)
  const out = { waiting: files.length, delivered: [], stuck: [], transportFailed: false, unverified: false }

  for (const name of files) {
    const path = join(d.inbox, name)
    let envelope
    try {
      envelope = JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
      // A message that will not parse is left exactly where it is. Moving it would hide it, and
      // deleting it would destroy something this board did not write.
      out.stuck.push(`${name}: unreadable (${e.message})`)
      continue
    }
    const res = await postLocal(envelope)
    /*
     * Read before the refusal branch, not after it.
     *
     * Who sent this and whether the recipient exists are two separate answers, and Garden gives
     * both on a refusal as readily as on a delivery. The flood this exists to stop was a message
     * that was ALSO being refused, retried every fifteen seconds for days, writing an unverified
     * row each time. Checking only the delivered path would have missed exactly that case.
     */
    if (res.unverified) out.unverified = true
    if (!res.ok) {
      if (res.transport) out.transportFailed = true
      out.stuck.push(`${name}: ${res.out}`)
      continue
    }
    // Only now, and the move is what records it. A crash before this point redelivers, which is
    // the direction to fail in.
    renameSync(path, join(d.delivered, name))
    out.delivered.push(envelope)
  }
  return out
}

/**
 * Tell Garden this card is alive, the way the CLI does.
 *
 * Garden decides a card failed to launch by asking whether an event row landed for it within the
 * 60 second grace, and rows are written by the `SessionStart` hook POSTing to `/hook`. Nothing a
 * process prints on its PTY counts. So a watcher that never makes this call is killed a minute in
 * no matter how healthy it is, which is the one thing that would make the bridge card look exactly
 * like the two dead cards it was invented to replace.
 *
 * Best effort on purpose: a board that is not answering is not a reason for the watcher to die, and
 * the next poll will say so on its own.
 */
function reportToGarden(hookEventName) {
  const body = JSON.stringify({
    gardenSessionId: process.env.GARDEN_SESSION_ID || null,
    receivedAt: Date.now(),
    event: { hook_event_name: hookEventName },
  })
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/hook',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(true))
      },
    )
    req.on('error', () => resolve(false))
    req.end(body)
  })
}

async function doWatch(args) {
  requireRoot()
  requireBoard()
  requireIdentity()

  const seconds = Number(args['--watch'])
  if (!Number.isFinite(seconds) || seconds < 5) {
    fail(
      `Nothing was watched. --watch takes a number of seconds, at least 5, and got ${JSON.stringify(args['--watch'])}.\n` +
        'Below five this polls a network share harder than it reads it.',
    )
  }

  const reported = await reportToGarden('SessionStart')
  process.stdout.write(
    `watching ${ROOT} as board "${BOARD}", every ${seconds}s` +
      (reported ? '' : ' (Garden did not answer the launch report; the board may kill this card)') +
      '\n',
  )

  let lastError = 'none'
  let lastDelivered = 'never'
  let stop = false
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stop = true
      reportToGarden('SessionEnd').then(() => process.exit(0))
    })
  }

  while (!stop) {
    let line
    try {
      const r = await pullOnce()
      /*
       * A stale token is fatal to a watcher, and this is the only place it can be noticed.
       *
       * Garden's `shadow` authority accepts an unrecognised token and answers 200, so before the
       * header existed a watcher whose board had restarted looked healthy forever while every poll
       * wrote a `SenderUnverified` row. One did: fifteen second polling for four and a half days,
       * 96,507 rows, a 385 MB database, and a board too busy rendering them to take a keystroke.
       *
       * The process cannot fix itself, because its token comes from its environment at startup and
       * the server mints new ones on every restart. So the only useful thing it can do is say so
       * and exit, which puts the card on the board in a state the owner can see.
       */
      if (r.unverified) {
        await reportToGarden('SessionEnd')
        fail(
          'Stopped watching: Garden does not recognise this card\'s session token.\n' +
            'Tokens live in the running server\'s memory, so every board restart invalidates every\n' +
            'one of them. Mail sent from here is being accepted unverified rather than refused,\n' +
            'which is why this looked fine.\n' +
            'Restart this card from the board so it is handed a current token.',
        )
      }
      /*
       * Only what changed gets its own line. A watcher that prints a paragraph every fifteen
       * seconds turns the card body into a waterfall nobody reads, and the card body is the whole
       * reason this is a poll loop rather than a cron job.
       */
      for (const e of r.delivered) {
        process.stdout.write(`delivered to ${e.to} (task ${e.taskId}) from board ${e.fromBoard}\n`)
      }
      if (r.delivered.length) lastDelivered = new Date().toISOString()
      if (r.stuck.length) lastError = r.stuck[0].split(': ').slice(1).join(': ').slice(0, 80) || 'refused'
      else if (!r.transportFailed) lastError = 'none'

      const waitingOut = messageFiles(boardDirs(peerGuess()).inbox).length
      line =
        `peer ${peerGuess()} | share ok | waiting in ${messageFiles(boardDirs(BOARD).inbox).length} / out ${waitingOut}` +
        ` | last delivered ${lastDelivered} | last error ${lastError}`
    } catch (e) {
      // The share going away is the expected failure here, not an exception to crash on. The last
      // good summary stays on the body so the card does not go blank the moment the network does.
      lastError = e.message.slice(0, 80)
      line = `peer ${peerGuess()} | share unreachable since ${new Date().toISOString()} | last error ${lastError}`
    }
    process.stdout.write(`${line}\n`)
    // Deliberately not unref'd: this timer IS the process's reason to stay alive.
    await new Promise((r) => setTimeout(r, seconds * 1000))
  }
}

/**
 * The other board's directory name, for the status line only.
 *
 * Guessed rather than configured, because the share holds exactly two boards today and requiring a
 * `--peer` flag to render one word would be a flag that exists only to be typed. Wrong guess costs
 * a label, never a delivery: nothing routes on this.
 */
function peerGuess() {
  try {
    const others = readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== BOARD)
      .map((e) => e.name)
    return others.length === 1 ? others[0] : others.join(',') || 'none'
  } catch {
    return 'unknown'
  }
}

function requireIdentity() {
  if (!process.env.GARDEN_SESSION_ID && !process.env.GARDEN_SESSION_TOKEN) {
    fail(
      'Nothing was pulled. Neither GARDEN_SESSION_ID nor GARDEN_SESSION_TOKEN is set.\n' +
        'A pull delivers mail to this board under the name of the card that runs it,\n' +
        'and Garden refuses a message from a card it cannot identify. Run it from\n' +
        "inside a card's shell, where Garden sets both, rather than from a bare terminal.",
    )
  }
}

async function doPull() {
  requireRoot()
  requireBoard()
  /*
   * Checked once, before anything is read, rather than discovered per message. Without an identity
   * every message fails the same way, and a run that reports twenty refusals for one missing
   * variable buries the cause in its own output.
   */
  requireIdentity()

  const r = await pullOnce()
  if (r.waiting === 0) {
    process.stdout.write('Nothing waiting.\n')
    return
  }
  for (const e of r.delivered) {
    process.stdout.write(`delivered to ${e.to} (task ${e.taskId}) from board ${e.fromBoard}\n`)
  }

  process.stdout.write(`\n${r.delivered.length} delivered, ${r.stuck.length} left in the inbox.\n`)
  for (const s of r.stuck) process.stdout.write(`  ${s}\n`)

  /*
   * Three outcomes, not two, because the first version had only two and that was wrong.
   *
   * It exited 1 whenever anything was refused, including a run that delivered two messages and was
   * refused two others. The carrier card reading that had to decide for itself whether a non-zero
   * exit meant the run had failed, and it worked it out correctly by ignoring the exit code and
   * reading the summary line instead. A tool whose exit code has to be ignored to be understood is
   * a tool with the wrong exit codes, and a watcher polling this every 15 seconds cannot read prose.
   *
   *   0  nothing is waiting that this run could have moved
   *   1  the run could not do its job, and retrying is the right response
   *   2  the run worked, and something needs a person: an unknown recipient, a missing wire, a file
   *      that will not parse. Retrying that on a timer is just noise until somebody acts
   */
  if (r.unverified) {
    process.stdout.write(
      '\nGarden accepted these without recognising this card\'s session token, so they were sent\n' +
        'unverified rather than as this card. The board has been restarted since this shell was\n' +
        'given its token. Restart this card to be handed a current one.\n',
    )
  }
  if (r.transportFailed) process.exitCode = 1
  else if (r.stuck.length > 0 || r.unverified) process.exitCode = 2
}

function doList() {
  requireRoot()
  requireBoard()
  const boards = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  if (boards.length === 0) {
    process.stdout.write(`No boards on ${ROOT} yet. Run --init.\n`)
    return
  }
  for (const b of boards) {
    const d = boardDirs(b)
    const waiting = messageFiles(d.inbox).length
    const done = messageFiles(d.delivered).length
    const mine = b === BOARD ? '  <- this board' : ''
    process.stdout.write(`${b}: ${waiting} waiting, ${done} delivered${mine}\n`)
  }
}

const args = parseArgs(process.argv.slice(2))
const chosen = ['--send', '--pull', '--list', '--init', '--watch'].filter((f) => args[f] !== undefined)
if (chosen.length === 0) {
  fail('Nothing was done. Pick one of --send, --pull, --list, --init or --watch.')
}
if (chosen.length > 1) {
  fail(`Nothing was done. Pick one action, not ${chosen.join(' and ')}.`)
}

if (args['--init']) doInit(args)
else if (args['--send']) doSend(args)
else if (args['--list']) doList()
else if (args['--watch'] !== undefined) await doWatch(args)
else await doPull()
