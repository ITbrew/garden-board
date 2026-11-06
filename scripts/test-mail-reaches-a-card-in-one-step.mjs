/**
 * Mail is fast: the card is typed at when its prompt box is up, and the notice carries the message.
 * Canon 06 revision 10.
 *
 * The owner timed a round trip at 58 seconds and asked "not sure why theres a fixed 3 second period
 * or why its 5 steps instead of 3". What is held here:
 *
 * - A short message sent with `--text` in one command arrives, and the send takes well under the
 *   second the shim used to wait on an idle stdin.
 * - A card that was off is typed at once SessionStart has been seen AND its prompt box is drawn:
 *   not before the box (a line typed into a CLI still drawing is lost), and not three seconds later.
 * - The line typed carries the message text, so the card does not need a step to read INBOX.md; it
 *   says the words are another card's, and it holds no newline or escape sequence.
 * - A message too long to type goes back to the notice that points at INBOX.md.
 *
 * The CLI is a fake `claude` first on PATH for this instance only: it posts SessionStart at once,
 * draws its prompt box 800 ms later, and posts UserPromptSubmit and Stop around each Enter. Its own
 * Garden on its own port and workspace; nothing real is started.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const bin = mkdtempSync(join(tmpdir(), 'garden-fake-claude-'))
const heard = join(bin, 'heard.jsonl')
const drawn = join(bin, 'drawn.txt')
const started = join(bin, 'started.txt')

const fakeSource = (port) => String.raw`
import { appendFileSync, writeFileSync } from 'node:fs'
const out = (s) => process.stdout.write(s)
const hook = (name) =>
  fetch(${JSON.stringify(`http://127.0.0.1:${port}/hook`)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: process.env.GARDEN_SESSION_ID, receivedAt: Date.now(), event: { hook_event_name: name, session_id: 'fake' } }),
  }).catch(() => {})
let buf = ''
let box = false
const RULE = '─'.repeat(60)
const draw = () => {
  const lines = ['● resumed conversation', '']
  if (box) lines.push(RULE, buf ? '> ' + buf.slice(-50) : '> ', RULE, '  ⏵⏵ bypass permissions on')
  else lines.push('loading…')
  out('\x1b[H\x1b[2J' + lines.join('\r\n'))
}
draw()
hook('SessionStart').then(() => writeFileSync(${JSON.stringify(started)}, String(Date.now())))
setTimeout(() => {
  box = true
  draw()
  writeFileSync(${JSON.stringify(drawn)}, String(Date.now()))
}, 800)
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on('data', (d) => {
  const s = d.toString('utf8')
  appendFileSync(${JSON.stringify(heard)}, JSON.stringify({ at: Date.now(), s }) + '\n')
  for (const ch of s) {
    if (ch === '\r') {
      if (!buf.trim()) continue
      buf = ''
      hook('UserPromptSubmit')
      setTimeout(() => { draw(); hook('Stop') }, 300)
    } else if (ch >= ' ') buf += ch
  }
  draw()
})
`
writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake-claude.mjs"\r\n`, 'utf8')
process.env.PATH = `${bin};${process.env.PATH}`

const { openBoard } = await import('./lib/board.mjs')
const board = await openBoard({
  projectName: 'mail-one-step',
  cards: [
    { title: 'Sender', roleClass: 'manager' },
    { title: 'Reader', roleClass: 'worker', reportsTo: 0, adapterId: 'claude' },
  ],
})
writeFileSync(join(bin, 'fake-claude.mjs'), fakeSource(board.port), 'utf8')
const [sender, reader] = board.cards
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
const lines = () => readIf(heard).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const typed = () => lines().map((l) => l.s).join('')

const tokens = new Map()
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.token') tokens.set(m.sessionId, m.token)
})
board.ws.send(JSON.stringify({ t: 'session.token', sessionId: sender.id }))
for (let i = 0; i < 20 && !tokens.has(sender.id); i++) await sleep(100)
const shim = readIf(join(board.home, 'mail', sender.id, 'PEERS.md')).match(/node "([^"]+garden-send\.mjs)"/)?.[1]
check('the sender is taught the shim', !!shim)
check('and the one-step form for a short message', /--text '<your message>'/.test(readIf(join(board.home, 'mail', sender.id, 'PEERS.md'))))

/** Run the shim the way a card does, with a stdin pipe that stays open and idle, as a tool's does. */
const send = (args) =>
  new Promise((done) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [shim, '--to', 'Reader', '--kind', 'question', ...args], {
      env: { ...process.env, GARDEN_SESSION_ID: sender.id, GARDEN_SESSION_TOKEN: tokens.get(sender.id) ?? '', GARDEN_PORT: String(board.port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (out += b))
    child.on('close', (code) => done({ ok: code === 0, out: out.trim(), ms: Date.now() - t0 }))
  })

// --- a short message, in one command, to a card that is off ---
const BODY = 'Garden check: PING from Sender. Reply PONG, then stop.'
const r = await send(['--text', BODY])
check('the one-command send succeeds', r.ok, r.out)
check('and does not sit a second on an idle stdin', r.ms < 900, `${r.ms} ms`)

const end = Date.now() + 30000
while (!typed().includes('PING from Sender') && Date.now() < end) await sleep(100)
const first = lines()[0]
const at = { started: Number(readIf(started)), drawn: Number(readIf(drawn)), typed: first?.at ?? 0 }
check('the card was started and typed at', !!first, JSON.stringify(at))
check('the notice carries the message itself', typed().includes(BODY), JSON.stringify(typed().slice(0, 300)))
check('and says it is from another card, not the owner', /from another card, not from the owner/.test(typed()))
check('nothing was typed before the prompt box was drawn', at.typed >= at.drawn, `${at.typed - at.drawn} ms after the box`)
check(
  'and it did not wait three seconds after SessionStart',
  at.typed > 0 && at.typed - at.started < 2800,
  `${at.typed - at.started} ms after SessionStart`,
)

// Wait for the turn to end and the unread count to clear.
await sleep(2500)

// --- a message with newlines and an escape sequence, from a file ---
const odd = join(bin, 'odd.md')
writeFileSync(odd, 'line one\nline two \x1b[2J end\r\n\ttabbed', 'utf8')
const before = typed().length
const r2 = await send(['--file', odd])
check('a file send succeeds', r2.ok, r2.out)
const end2 = Date.now() + 15000
while (!typed().slice(before).includes('tabbed') && Date.now() < end2) await sleep(100)
const notice2 = typed().slice(before).replace(/\r$/, '')
check('a multi-line message arrives flattened onto one line', /line one line two end tabbed/.test(notice2), JSON.stringify(notice2.slice(-120)))
check('with no newline or escape inside the typed text', !/[\n\x1b\t]/.test(notice2.replace(/\r+$/, '')) && !notice2.replace(/\r+$/, '').includes('\r'))

await sleep(2500)

// --- a message too long to type points at the inbox instead ---
const long = join(bin, 'long.md')
writeFileSync(long, 'LONGMESSAGE ' + 'word '.repeat(400), 'utf8')
const before3 = typed().length
const r3 = await send(['--file', long])
check('a long file send succeeds', r3.ok, r3.out)
const end3 = Date.now() + 15000
while (!/INBOX\.md now/.test(typed().slice(before3)) && Date.now() < end3) await sleep(100)
const notice3 = typed().slice(before3)
check('a message too long to type gets the notice that points at INBOX.md', /Read your INBOX\.md now/.test(notice3), JSON.stringify(notice3.slice(0, 120)))
check('without the message in it', !notice3.includes('LONGMESSAGE'))
check('and the inbox has all three', ['PING from Sender', 'tabbed', 'LONGMESSAGE'].every((w) => readIf(join(board.home, 'mail', reader.id, 'INBOX.md')).includes(w)))

board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: reader.id }))
await sleep(500)
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
