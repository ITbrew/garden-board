#!/usr/bin/env node
/**
 * Loops from the terminal: the same four fields the rail's Loops section sets.
 *
 *   garden-loop.mjs                              list the loops on this card's board
 *   garden-loop.mjs --on  --card "Orchestrator" --minutes 15 --prompt-file tick.md
 *   garden-loop.mjs --off --card "Orchestrator"
 *   garden-loop.mjs --minutes 30 --card "Orchestrator"
 *   garden-loop.mjs --delete --card "Orchestrator"
 *
 * One loop per card is what this command manages; the rail can hold more. The prompt comes from a
 * file, never the command line, for the same reason mail bodies do: a long command cannot be
 * security-scanned and PowerShell rebuilds quoted values. Nothing here types into a card: the
 * server's loop tick does that, and only when the card is idle.
 */
import { readFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const PORT = Number(process.env.GARDEN_PORT) || 5178
const ME = process.env.GARDEN_SESSION_ID || null

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const VALUED = new Set(['--card', '--minutes', '--prompt-file', '--project'])
const BARE = new Set(['--on', '--off', '--delete', '--json'])
const opts = {}
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]
  if (!VALUED.has(token) && !BARE.has(token)) {
    fail(`I do not know the argument ${JSON.stringify(token)}. I take --card, --minutes, --prompt-file, --project, --on, --off, --delete and --json.`)
  }
  if (token in opts) fail(`${token} was given twice, so one of the values was going to be ignored.`)
  if (BARE.has(token)) {
    opts[token] = true
    continue
  }
  const value = argv[++i]
  if (value === undefined) fail(`${token} was given with nothing after it.`)
  opts[token] = value
}
if (opts['--on'] && opts['--off']) fail('--on and --off together say nothing.')
const changing = opts['--on'] || opts['--off'] || opts['--delete'] || opts['--minutes'] || opts['--prompt-file']
if (changing && !opts['--card']) fail('Say which card with --card "<title>".')
let minutes
if (opts['--minutes'] !== undefined) {
  minutes = Number(opts['--minutes'])
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) fail('--minutes is a whole number from 1 to 1440.')
}
let prompt
if (opts['--prompt-file']) {
  try {
    prompt = readFileSync(opts['--prompt-file'], 'utf8').trim()
  } catch (e) {
    fail(`Could not read ${opts['--prompt-file']}: ${e.message}`)
  }
  if (!prompt) fail('The prompt file is empty.')
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
  headers: process.env.GARDEN_SESSION_TOKEN
    ? { authorization: `Bearer ${process.env.GARDEN_SESSION_TOKEN}` }
    : {},
})
ws.on('error', (e) => fail(`Garden is not answering on port ${PORT}: ${e.message}`))
/*
 * The token goes in the hello, not only in the header.
 *
 * `identify` on the server reads `msg.key` and `msg.token` off the hello message and never looks at
 * the Authorization header, so a hello with no token is a connection that proved nothing. On a board
 * that is not enforcing task authority that is treated as the owner, which meant this command ran
 * with the owner's hand: a card could switch another card's loop off through it and the rule in
 * canon 25 never got a chance to refuse. Measured by
 * `scripts/test-a-card-turns-its-own-loop-off.mjs`, which failed exactly that way before this line.
 *
 * With the token presented, the card is itself: its own loop it may change, another card's it may
 * not unless it is a card that may create cards.
 */
ws.on('open', () =>
  ws.send(JSON.stringify({ t: 'hello', ...(process.env.GARDEN_SESSION_TOKEN ? { token: process.env.GARDEN_SESSION_TOKEN } : {}) })),
)

let projectId = opts['--project'] || null
let sessions = []
let asked = false
let acted = false

function since(ms) {
  if (ms == null) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${(s / 3600).toFixed(1)}h ago`
}

function print(loops) {
  if (opts['--json']) {
    process.stdout.write(JSON.stringify(loops, null, 2) + '\n')
    return
  }
  if (loops.length === 0) {
    process.stdout.write('No loops on this board.\n')
    return
  }
  for (const l of loops) {
    const card = sessions.find((s) => s.id === l.sessionId)
    const title = card ? card.title : `(card gone ${l.sessionId})`
    process.stdout.write(
      `${title.padEnd(24)} ${l.enabled ? 'ON ' : 'off'}  every ${String(l.minutes).padStart(4)} min` +
        `  last: ${l.lastOutcome ?? 'never due'} ${l.lastFiredAt ? since(l.lastFiredAt) : ''}\n` +
        `    ${l.prompt.length > 110 ? l.prompt.slice(0, 107) + '...' : l.prompt}\n`,
    )
  }
}

ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(String(raw))
  } catch {
    return
  }
  if (msg.t === 'error' && asked) fail(`Garden refused: ${msg.message}`)
  if (msg.t === 'state' && !asked) {
    sessions = Array.isArray(msg.sessions) ? msg.sessions : []
    if (!projectId) {
      const mine = ME ? sessions.find((s) => s.id === ME) : null
      if (mine) projectId = mine.projectId
      else if (Array.isArray(msg.projects) && msg.projects.length === 1) projectId = msg.projects[0].id
      else fail('Which board? Pass --project <id>; this terminal is not a card and there is more than one project.')
    }
    asked = true
    ws.send(JSON.stringify({ t: 'loop.list', projectId }))
    return
  }
  if (msg.t !== 'loops' || msg.projectId !== projectId) return
  if (!changing || acted) {
    print(msg.loops)
    ws.close()
    process.exit(0)
  }
  acted = true
  const card = sessions.find((s) => s.projectId === projectId && s.closedAt === null && s.title === opts['--card'])
  if (!card) fail(`No open card titled ${JSON.stringify(opts['--card'])} on this board.`)
  const existing = msg.loops.find((l) => l.sessionId === card.id)
  if (opts['--delete']) {
    if (!existing) fail(`${card.title} has no loop to delete.`)
    ws.send(JSON.stringify({ t: 'loop.delete', projectId, id: existing.id }))
    return
  }
  if (!existing && (!prompt || minutes === undefined)) {
    fail(`${card.title} has no loop yet. Creating one needs --minutes and --prompt-file.`)
  }
  ws.send(
    JSON.stringify({
      t: 'loop.set',
      projectId,
      loop: {
        id: existing?.id,
        sessionId: card.id,
        prompt: prompt ?? existing.prompt,
        minutes: minutes ?? existing.minutes,
        enabled: opts['--on'] ? true : opts['--off'] ? false : existing ? existing.enabled : true,
      },
    }),
  )
})
