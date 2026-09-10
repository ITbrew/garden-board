/**
 * How an agent brings another card into existence.
 *
 * Until this existed, `session.create` arrived only over the WebSocket, which only the owner's hands
 * reach. So a card asked to hire had nothing to call: it either asked the owner to do it or fell
 * back to the CLI's own Agent tool, which produces an untitled helper that lives inside one turn and
 * is gone when the turn ends. The owner watched exactly that happen: subagents with no titles,
 * retired after one shot, rarely deferring to anyone, standing in for the full cards he had asked
 * for.
 *
 * The roots go on stdin, and they are required. A card hired with no roots of its own reads only the
 * project's instructions and the machine's, and answers as whatever those describe rather than as
 * the thing it was hired to be. That is the "it inherited everything ever written" complaint, and
 * the fix is that whoever asks for a card has to say what that card is for, in its own words, before
 * it exists. They are written into the new card's own CLAUDE.md, below the line Garden maintains, so
 * Garden's half stays accurate and the hirer's half is never overwritten.
 *
 * Stdin rather than a --roots value for the same reason the message body is: Windows PowerShell 5.1
 * reopens the command line at a quote inside an argument, and the tail is lost before this script's
 * first line runs.
 *
 * The asker never names itself. `GARDEN_SESSION_ID` is set when Garden spawns the shell and is
 * inherited by everything under it, so it is a fact about which terminal this is rather than a claim
 * the agent makes. An agent that deliberately overrode it could present itself as another card, and
 * that is written down rather than pretended away. What the lie buys is nothing: the board ceiling
 * is checked before the role is, and it applies to every path including the owner's, so a forged id
 * changes who is blamed for a card, never whether the board has room for one.
 *
 * Usage, from inside a session. Write the roots to a file with a file writing tool, then name it:
 *   node <this> --title "Loader worker" --role worker --file "<mail dir>/outbox/roots.md"
 *   node <this> --start <card id>
 *
 * Never inside the command. Real roots run to thousands of characters, and a command carrying that
 * much prose has to be security scanned before it runs, cannot be, and stops to ask the owner.
 *
 * Who may actually create is the server's business and is not repeated here. Ask when you are not
 * the orchestrator and the request is filed as mail to whoever is, and answered along a wire.
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
 * The command line is walked in pairs rather than searched, for the reason set out at length in
 * garden-send.mjs: an unrecognised token is the visible proof that the shell shattered an argument
 * at a quote, and stepping over it in silence is how half a thing gets sent while every surface
 * reads as success. Every token at an even offset must be a known flag and no flag may repeat.
 *
 * Lines are kept under 80 characters on purpose. PowerShell 5.1 hard wraps a native command's
 * stderr around 117 columns including its own prefix, and a break landing mid-sentence reads to
 * whoever relays it as though this file emitted two lines.
 */
const FLAGS = new Set([
  'title',
  'role',
  'reports-to',
  'model',
  'effort',
  'team-size',
  'owns',
  'adapter',
  'start',
  'file',
])
const flags = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const token = process.argv[i]
  const name = token.startsWith('--') ? token.slice(2) : null
  if (name === null || !FLAGS.has(name)) {
    fail(
      `Nothing was created. Unrecognised argument: ${JSON.stringify(token)}\n` +
        'Your shell probably reopened the command line at a quote, so the rest\n' +
        'arrived as stray arguments.\n' +
        'Put the roots on stdin rather than in an argument value.',
    )
  }
  if (flags.has(name)) {
    fail(
      `Nothing was created. --${name} was given twice.\n` +
        'If you only wrote it once, your shell broke an argument apart at a quote\n' +
        'and part of it is now being read as a flag.',
    )
  }
  flags.set(name, process.argv[i + 1])
}

const arg = (name) => flags.get(name)

if (!process.env.GARDEN_SESSION_ID) {
  fail('This terminal was not started by Garden, so it has no card to ask from.')
}

/*
 * Starting an existing card is the one verb that needs no roots, because the card already has them.
 * It is here rather than in a second shim so a card has one command to learn for the whole subject
 * of other cards existing.
 */
const startId = arg('start')
if (startId) {
  post({ from: process.env.GARDEN_SESSION_ID, action: 'start', cardId: startId })
} else {
  await createFlow()
}

async function createFlow() {
  const title = arg('title')
  const role = arg('role')
  if (!title) fail('What is it called? Pass --title. It is how other cards address it.')
  if (!role) {
    fail(
      'Pass --role. It decides what the card may reach for, and it cannot be\n' +
        'changed without restarting the card, because the CLI reads its\n' +
        'permissions once at launch.',
    )
  }

  /*
   * Reading stdin without ever hanging and without inventing a new way to truncate, the same three
   * bounded parts garden-send.mjs uses and for the same measured reasons. A wrapper or a hook hands
   * its child an inherited pipe that never carries a byte and never closes, and an unbounded read of
   * that never returns, which is worse than a refusal because there is nothing to relay. The middle
   * rule is the one that keeps this honest: an idle gap once bytes have started is a refusal, never
   * a create using whatever turned up, because a card built from half its roots is worse than one
   * that was never built.
   */
  // Short when the roots are already named on disk, since stdin is then only being consulted to
  // catch a card hedging with both, and long when stdin IS the roots and something is expected.
  const FIRST_BYTE_WAIT_MS = arg('file') ? 1000 : 10000
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

  /*
   * The roots off disk, which is the form that is always safe to run.
   *
   * Roots are the longest thing any card ever hands another: a real set runs to thousands of
   * characters, because it says what the card is for, what it owns, what it must not touch and who
   * it defers to. That makes this the worst place on the board to put a body inside a command.
   * Claude Code splits a command on its separators and checks each part, so `cat roots.md | node
   * <this>` is fine only while roots.md already exists; a card that builds it with a heredoc in the
   * same command hands the classifier a few thousand characters it will not scan, and the card stops
   * and waits for the owner. See garden-send.mjs, which carries the measurements.
   */
  const fromFile = arg('file')

  const readFromFile = (path) => {
    const full = resolve(path)
    let raw
    try {
      raw = readFileSync(full, 'utf8')
    } catch (err) {
      fail(
        `Nothing was created. Could not read ${full}\n` +
          `${err.code === 'ENOENT' ? 'There is no file there.' : err.message}\n` +
          'Write the roots to a file first, with your file writing tool rather\n' +
          'than with a shell command, and pass that exact path to --file.',
      )
    }
    const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim()
    if (!text) {
      fail(
        `Nothing was created. ${full} is there and holds nothing.\n` +
          'A card hired with empty roots reads only the project instructions and\n' +
          'answers as whatever those describe rather than as what you hired, so\n' +
          'Garden refused rather than making one.',
      )
    }
    return text
  }

  const fromStdin = async () => {
    const { text: raw, truncated } = await readStdin()
    if (truncated) {
      fail(
        'Nothing was created. The roots started arriving on stdin and then\n' +
          `stopped for ${MID_MESSAGE_IDLE_MS / 1000} seconds without ending, so Garden cannot tell\n` +
          'whether they were complete. No card was made from half of them.',
      )
    }
    return raw.trim()
  }

  /*
   * One source, and two at once is a refusal rather than a guess.
   *
   * Same rule garden-send.mjs holds for the same reason: Garden cannot tell which set the card meant,
   * the two are not always the same text, and picking one silently means a card can be built from
   * roots nobody chose while the asker is told the ones it wrote went in.
   */
  let roots
  if (fromFile) {
    const piped = await fromStdin()
    if (piped) {
      fail(
        'Nothing was created. You passed --file and also piped roots in, and\n' +
          'Garden will not guess which set you meant.\n' +
          'Send one or the other. --file is the one with no size limit.',
      )
    }
    roots = readFromFile(fromFile)
  } else {
    roots = await fromStdin()
  }

  if (!roots) {
    fail(
      'No roots. Write them to a file and pass --file: what this card is for,\n' +
        'in its own words, the part of the work it owns, what it should not\n' +
        'touch, and who it defers to for the rest.\n' +
        'A card hired without them reads only the project instructions and\n' +
        'answers as whatever those describe rather than as what you hired.',
    )
  }

  const owns = arg('owns')
  const teamSize = arg('team-size')
  post({
    from: process.env.GARDEN_SESSION_ID,
    action: 'create',
    title,
    role,
    reportsTo: arg('reports-to') ?? null,
    adapterId: arg('adapter') ?? 'claude',
    model: arg('model') ?? null,
    effort: arg('effort') ?? null,
    teamSize: teamSize === undefined ? null : Number(teamSize),
    // Comma separated because a card usually owns one folder, and a list of paths through a shell
    // argument is another place a quote could shatter something.
    ownedPaths: owns ? owns.split(',').map((p) => p.trim()).filter(Boolean) : null,
    roots,
  })
}

function post(payload) {
  const body = JSON.stringify(payload)
  const req = request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/hire',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        /*
         * The token proves which card this is, where `GARDEN_SESSION_ID` only claims it, and the
         * header is what turns the admission at the top of this file from a permanent one into a
         * transitional one. A card that overwrites its id to hire as somebody else is now caught
         * against a table the server minted. Absent, the server falls back to the id and records
         * that the asker was unverified, so terminals already running when this landed keep working.
         */
        ...(process.env.GARDEN_SESSION_TOKEN
          ? { authorization: `Bearer ${process.env.GARDEN_SESSION_TOKEN}` }
          : {}),
      },
    },
    (res) => {
      let out = ''
      res.on('data', (c) => (out += c))
      res.on('end', () => {
        // The refusal reason is the useful part, so it goes out in full rather than as a code.
        if (res.statusCode !== 200) fail(out || `Garden refused with ${res.statusCode}`)
        process.stdout.write(`${out}\n`)
        process.exit(0)
      })
    },
  )
  req.on('error', (e) => fail(`Garden is not answering on port ${PORT}: ${e.message}`))
  req.end(body)
}
