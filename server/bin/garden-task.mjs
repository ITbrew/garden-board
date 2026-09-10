/**
 * How an agent reads and changes a task contract.
 *
 * The third shim, and the same reason as the other two: `task.create`, `task.bind`, `task.reassign`,
 * `task.split` and `task.verifier` arrive over the WebSocket, which only the owner's hands reach. A
 * manager told to hand work to a worker could send the mail and could not open the task the mail is
 * about, so the contract would only ever exist for work the owner personally typed in. It would have
 * been drawn and not walkable, which is what `garden-send.mjs` was written to fix for wires.
 *
 * Every op here goes to `POST /task`, which calls the same functions the socket messages call. One
 * set of rules, two doors. A refusal you read here is the server's own sentence, not this file's
 * paraphrase of it, for the reason garden-send.mjs stopped keeping its own copy of the kind list: two
 * lists drift, and the one a card reads is then not the one that decided.
 *
 * Who may do these things is the server's business and is not repeated here. Broadly: creating,
 * binding, reassigning and splitting belong to a card that hires, because handing work out is what
 * those cards are for; `show` is open to anyone on the board, because a card that cannot read its own
 * contract cannot be held to it.
 *
 * Usage, from inside a session:
 *   node <this> show --task T-12
 *   node <this> create --task T-12 --owner "Loader worker" --acceptance-file docs/orders/T-12.md
 *   node <this> bind --task T-12 --owner "Loader worker" --note "picked up from mail history"
 *   node <this> reassign --task T-12 --to "Other worker" --reason owner_stopped --note "..."
 *   node <this> reassign --task T-12 --to "Other worker" --reason blocked_elsewhere --blocked-by T-9
 *   node <this> split --task T-12 --into "T-12a=Worker A=server/src; T-12b=Worker B=apps/web"
 *   node <this> verifier --task T-12 --verifier "Reviewer"
 *   node <this> authority                     reads the setting back
 *   node <this> authority enforce             sets it, owner key or an orchestrator's token
 *   node <this> update-policy                 reads the update policy back
 *   node <this> update-policy when-safe       sets it, the same two identities
 *
 * Flags rather than stdin, which is the opposite of the other two shims and is deliberate. Their
 * payload is prose that runs to thousands of characters and shatters on a quote; every value here is
 * an id, a card title or a single word, and a subcommand with eight short flags is still a short
 * command. The one exception is acceptance criteria, which are prose: pass `--acceptance-file <path
 * in this project>` so Garden reads and hashes the file itself, or `--file <path>` to send the text
 * of a file you wrote. Never `--acceptance "..."` with a real paragraph in it.
 */
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PORT = Number(process.env.GARDEN_PORT) || 5178

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const OPS = new Set(['create', 'bind', 'reassign', 'split', 'verifier', 'show', 'authority', 'update-policy'])

const op = process.argv[2]
if (!op || op.startsWith('--')) {
  fail(
    'Which op? One of: create, bind, reassign, split, verifier, show,\n' +
      'authority, update-policy. It comes first, before any flag:\n' +
      '  node <this> show --task T-12',
  )
}
if (!OPS.has(op)) {
  fail(`Nothing happened. "${op}" is not an op. They are: ${[...OPS].join(', ')}.`)
}

/*
 * The command line is walked in pairs rather than searched, for the reason set out at length in
 * garden-send.mjs: an unrecognised token is the visible proof that the shell shattered an argument at
 * a quote, and stepping over it in silence is how half a thing is sent while every surface reads as
 * success. Every token at an even offset from the op must be a known flag, and no flag may repeat.
 *
 * Lines are kept under 80 characters on purpose. PowerShell 5.1 hard wraps a native command's stderr
 * around 117 columns including its own prefix, and a break landing mid-sentence reads to whoever
 * relays it as though this file emitted two lines.
 */
const FLAGS = new Set([
  'task',
  'owner',
  'assigner',
  'to',
  'reason',
  'note',
  'blocked-by',
  'role',
  'territory',
  'parent',
  'verifier',
  'clear-verifier',
  'into',
  'acceptance',
  'acceptance-file',
  'file',
  'project',
])
// Flags that are a switch rather than a value, so the walk must not eat the next token as theirs.
const SWITCHES = new Set(['clear-verifier'])

/*
 * `authority` takes its value as a bare word, and it is the only op here that does.
 *
 * `garden-task.mjs authority enforce` reads the way the setting is spoken about, and a flag would
 * make it `--to enforce`, which reads like a card. The walk below still refuses every other stray
 * token, so the pair rule that catches a shell shattering a quoted value is intact: exactly one
 * position is exempt, it is the one immediately after this op, and it may not begin with `--`.
 */
let setting = null
let walkFrom = 3
if ((op === 'authority' || op === 'update-policy') && process.argv[3] && !process.argv[3].startsWith('--')) {
  setting = process.argv[3]
  walkFrom = 4
}

const flags = new Map()
for (let i = walkFrom; i < process.argv.length; ) {
  const token = process.argv[i]
  const name = token.startsWith('--') ? token.slice(2) : null
  if (name === null || !FLAGS.has(name)) {
    fail(
      `Nothing happened. Unrecognised argument: ${JSON.stringify(token)}\n` +
        'Your shell probably reopened the command line at a quote, so the rest\n' +
        'arrived as stray arguments.\n' +
        `Flags for this command: ${[...FLAGS].map((f) => `--${f}`).join(' ')}`,
    )
  }
  if (flags.has(name)) {
    fail(
      `Nothing happened. --${name} was given twice.\n` +
        'If you only wrote it once, your shell broke a value apart at a quote and\n' +
        'part of it is now being read as a flag.',
    )
  }
  if (SWITCHES.has(name)) {
    flags.set(name, true)
    i += 1
  } else {
    flags.set(name, process.argv[i + 1])
    i += 2
  }
}

const arg = (name) => flags.get(name)

/**
 * The owner's key, for the one op the owner runs with his own hands.
 *
 * Read from the same file the server writes, honouring `GARDEN_HOME` so a scratch instance is
 * answered by its own key rather than by the real board's. Absent is the ordinary case inside a
 * card, which sends its token instead, so this returns null rather than failing.
 */
function ownerKey() {
  const dir = process.env.GARDEN_HOME || join(homedir(), '.garden')
  try {
    const held = readFileSync(join(dir, 'owner.key'), 'utf8').trim()
    return held || null
  } catch {
    return null
  }
}

/*
 * `authority` is the one op that can come from outside a card.
 *
 * Every other op here acts as a card and is refused without one, which is the whole point of the
 * ownership plane. This setting is the owner's own, it used to be two radio buttons in the sidebar,
 * and taking those away without leaving him a way to reach it from a terminal would be removing the
 * control rather than moving it. So: a card sends its token, and the owner sends the key the server
 * wrote at start.
 */
const key = op === 'authority' || op === 'update-policy' ? ownerKey() : null
if (!process.env.GARDEN_SESSION_ID && !key) {
  fail(
    key !== null || op === 'authority' || op === 'update-policy'
      ? 'This terminal was not started by Garden and there is no owner key to\n' +
        'read, so nothing here can say who is asking. Run it from a card, or\n' +
        'start the board once so it writes the key.'
      : 'This terminal was not started by Garden, so it has no card to act as.',
  )
}

const taskId = arg('task')
if (!taskId && op !== 'authority' && op !== 'update-policy') {
  fail('Pass --task <id>. Every op here is about one task.')
}

/** Prose read off disk, for the one field that is prose. */
function readFile(path) {
  const full = resolve(path)
  try {
    const raw = readFileSync(full, 'utf8')
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  } catch (err) {
    return fail(
      `Nothing happened. Could not read ${full}\n` +
        `${err.code === 'ENOENT' ? 'There is no file there.' : err.message}`,
    )
  }
}

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * The pieces of a split, as one flag.
 *
 * `id=owner=path,path`, pieces separated by semicolons. Owner and territory are both optional: a
 * piece with no owner is paused rather than guessed at, and a piece with no territory inherits the
 * parent's. Three fields on `=` rather than something cleverer because every value in them is an id
 * or a title, and a grammar a card has to think about is a grammar it gets wrong at the moment it is
 * splitting work under pressure.
 */
function pieces(raw) {
  const out = []
  for (const chunk of String(raw).split(';')) {
    const text = chunk.trim()
    if (!text) continue
    const [id, owner, territory] = text.split('=').map((x) => (x === undefined ? '' : x.trim()))
    if (!id) {
      fail(
        `Nothing happened. A piece of the split has no id: ${JSON.stringify(text)}\n` +
          'Each piece is id=owner=paths, separated by semicolons.',
      )
    }
    out.push({
      id,
      ownerId: owner || null,
      ...(territory ? { territory: list(territory) } : {}),
    })
  }
  if (out.length === 0) fail('Nothing happened. --into named no pieces.')
  return out
}

const payload = (() => {
  if (op === 'show') return { op: 'show', taskId }

  if (op === 'authority') {
    const allowed = ['off', 'shadow', 'enforce']
    if (setting !== null && !allowed.includes(setting)) {
      fail(
        `Nothing happened. "${setting}" is not a setting.\n` +
          `They are: ${allowed.join(', ')}.\n` +
          '  off      nothing is checked\n' +
          '  shadow   refusals are recorded and the message goes anyway\n' +
          '  enforce  refusals refuse\n' +
          'With no setting at all it reads back what the board is on.',
      )
    }
    return { op: 'authority', authority: setting, projectId: arg('project') }
  }

  /*
   * The same shape as `authority`, and deliberately so: one bare word, or none to read it back.
   *
   * Nothing on the board acts on this setting yet, and every answer says so rather than letting a
   * policy that does nothing look like a policy that does something.
   */
  if (op === 'update-policy') {
    const allowed = ['manual', 'when-safe']
    if (setting !== null && !allowed.includes(setting)) {
      fail(
        `Nothing happened. "${setting}" is not a policy.\n` +
          `They are: ${allowed.join(', ')}.\n` +
          '  manual     nothing authorizes a restart, so each one is the owner\'s\n' +
          '  when-safe  a card may be restarted once it reaches a safe boundary\n' +
          'With no policy at all it reads back what the board is on.',
      )
    }
    return { op: 'update-policy', policy: setting, projectId: arg('project') }
  }

  if (op === 'create') {
    if (!arg('owner')) {
      fail(
        'Pass --owner <card>: who is accountable for this task.\n' +
          'Garden will not open a task without one. An ownerless task is exactly\n' +
          'what this guard exists to stop.',
      )
    }
    if (arg('acceptance') && arg('acceptance-file')) {
      fail(
        'Nothing happened. You passed both --acceptance and --acceptance-file,\n' +
          'and Garden will not guess which one is the finish line.',
      )
    }
    if (arg('file') && arg('acceptance')) {
      fail('Nothing happened. --file and --acceptance are two copies of the same field.')
    }
    /*
     * Two ways to state the finish line, and they are not the same thing.
     *
     * `--acceptance-file` sends the PATH, and the server reads the file and hashes it, so whether the
     * criteria have changed under the work is afterwards a fact anybody can check. `--file` sends the
     * TEXT, which is right when the criteria live somewhere the server cannot reach, and gives up
     * that check. Prefer the first whenever the file is inside the project.
     */
    const acceptance = arg('file') ? readFile(arg('file')) : (arg('acceptance') ?? null)
    return {
      op: 'create',
      task: {
        id: taskId,
        ownerId: arg('owner'),
        ...(arg('assigner') ? { assignerId: arg('assigner') } : {}),
        ...(acceptance ? { acceptance } : {}),
        ...(arg('acceptance-file') ? { acceptanceRef: { path: arg('acceptance-file') } } : {}),
        ...(arg('role') ? { requiredRole: arg('role') } : {}),
        ...(arg('territory') ? { territory: list(arg('territory')) } : {}),
        ...(arg('verifier') ? { verifierId: arg('verifier') } : {}),
        ...(arg('parent') ? { parentId: arg('parent') } : {}),
      },
    }
  }

  if (op === 'bind') {
    if (!arg('owner')) fail('Pass --owner <card>: who this task has actually belonged to.')
    return {
      op: 'bind',
      taskId,
      ownerId: arg('owner'),
      ...(arg('assigner') ? { assignerId: arg('assigner') } : {}),
      note: arg('note') ?? '',
    }
  }

  if (op === 'reassign') {
    if (!arg('to')) fail('Pass --to <card>: who is taking it over.')
    if (!arg('reason')) {
      fail(
        'Pass --reason. Garden checks the reason rather than taking your word\n' +
          'for it, so a wrong one is a refusal naming what it actually found.\n' +
          'They are: owner_stopped, owner_silent, missing_capability,\n' +
          'missing_territory, blocked_elsewhere, legacy_bind.',
      )
    }
    if (arg('reason') === 'blocked_elsewhere' && !arg('blocked-by')) {
      fail(
        'Pass --blocked-by <task id>: the task, held by another card, that\n' +
          'this work is waiting on. Garden checks that field and reads nothing\n' +
          'out of the note, so naming it in the note alone is a refusal.',
      )
    }
    return {
      op: 'reassign',
      taskId,
      toOwnerId: arg('to'),
      reason: arg('reason'),
      note: arg('note') ?? '',
      ...(arg('blocked-by') ? { blockedBy: arg('blocked-by') } : {}),
    }
  }

  if (op === 'split') {
    if (!arg('into')) {
      fail(
        'Pass --into "id=owner=paths; id=owner=paths".\n' +
          'Owner and paths are optional per piece: a piece with no owner is\n' +
          'paused rather than given to somebody Garden picked.',
      )
    }
    return { op: 'split', taskId, into: pieces(arg('into')) }
  }

  // verifier
  if (arg('clear-verifier')) {
    if (arg('verifier')) fail('Nothing happened. --verifier and --clear-verifier contradict each other.')
    return { op: 'verifier', taskId, verifierId: null }
  }
  if (!arg('verifier')) {
    fail(
      'Pass --verifier <card>, or --clear-verifier to remove the one that is\n' +
        'there. Clearing is spelled out rather than done by an empty value,\n' +
        'because losing a verifier by typo is the failure this role prevents.',
    )
  }
  return { op: 'verifier', taskId, verifierId: arg('verifier') }
})()

const body = JSON.stringify({ from: process.env.GARDEN_SESSION_ID, ...payload })

/*
 * The token proves which card this is, where `GARDEN_SESSION_ID` only claims it.
 *
 * Both are set by Garden when it spawns the shell, so on an honest card they agree and this changes
 * nothing. The difference is what a dishonest one can do: an id is a string that can be overwritten,
 * and the token is checked against a table the server minted, so a card that rewrites its id to act
 * as another card is caught rather than merely written down as possible. Absent, the server falls
 * back to the id and records that it was unverified, which is what keeps existing terminals working
 * across the restart that introduces this.
 */
const headers = {
  'content-type': 'application/json',
  'content-length': Buffer.byteLength(body),
  ...(process.env.GARDEN_SESSION_TOKEN
    ? { authorization: `Bearer ${process.env.GARDEN_SESSION_TOKEN}` }
    : {}),
  /*
   * A header of its own rather than the bearer slot, so the two credentials never stand in for one
   * another. A card token and the owner key mean different things to the server, and putting the
   * key where a token is expected would make a failed lookup ambiguous: the server could no longer
   * tell "this card's token is stale" from "the owner sent his key". Sent only for the two ops the
   * owner reaches directly, `authority` and `update-policy`.
   */
  ...(key ? { 'x-garden-owner-key': key } : {}),
}

const req = request({ host: '127.0.0.1', port: PORT, path: '/task', method: 'POST', headers }, (res) => {
  let out = ''
  res.on('data', (c) => (out += c))
  res.on('end', () => {
    // The refusal reason is the useful part, so it goes out in full rather than as a code.
    if (res.statusCode !== 200) fail(out || `Garden refused with ${res.statusCode}`)
    process.stdout.write(`${out}\n`)
    process.exit(0)
  })
})
req.on('error', (e) => fail(`Garden is not answering on port ${PORT}: ${e.message}`))
req.end(body)
