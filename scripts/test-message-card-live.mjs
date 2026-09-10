/**
 * Proves a real card, not a stand-in, can be reached through a message card and answer in it.
 *
 * `test-message-card.mjs` covers the mechanism and deliberately fakes the card's half: it appends to
 * the file the way a card would and checks the board notices. That leaves the question the owner
 * actually asked unanswered, which is whether a card can do it: whether it is told, whether it can
 * find the file, and whether it is allowed to write there.
 *
 * So this one starts a real Claude session and costs real tokens. It is held back from the suite for
 * that reason and named in the summary rather than hidden. Run it with:
 *
 *   node scripts/run-suite.mjs --paid
 *   node scripts/test-message-card-live.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// A word no part of this system would produce on its own, so finding it in the file cannot be
// anything but the card having written it.
const WORD = 'PINEAPPLE-7731'

const board = await openBoard()
const added = []
const channels = []
const profiles = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state' || m.t === 'profiles') profiles.push(...(m.profiles ?? []))
  if (m.t === 'session.added') added.push(m.session)
  if (m.t === 'channel.added' || m.t === 'channel.updated') channels.push(m.channel)
  if (m.t === 'error') console.log('   server said:', m.message)
})
/*
 * Asked for again, because `openBoard` has already had the first one.
 *
 * The state snapshot arrives once, in answer to the hello it sends while setting the board up, so a
 * listener attached afterwards never sees it and the account list looks empty. A second hello costs
 * nothing and is answered the same way.
 */
board.ws.send(JSON.stringify({ t: 'hello' }))
await sleep(1200)

/*
 * Bind the scratch project to an account before starting anything.
 *
 * This machine puts an account picker in front of the CLI, and it decides from the folder. A test's
 * project is a fresh temporary directory that no account map has ever heard of, so the picker stops
 * and asks, the CLI never starts, and everything after it fails for a reason that has nothing to do
 * with what is being tested. Garden already knows how to avoid this for real boards: binding a
 * profile is what makes it pass `CLAUDE_ACCOUNT` on the launch. The first run of this test spent
 * three minutes waiting for a reply from a session sitting on "Which account should this session
 * use?", with Garden's own notice typed into the prompt as an answer.
 */
const profile = profiles.find((p) => p.adapterId === 'claude')
if (profile) {
  board.ws.send(
    JSON.stringify({ t: 'project.setProfile', projectId: board.project.id, adapterId: 'claude', profileId: profile.id }),
  )
  await sleep(800)
}
check('the scratch board has an account bound, so nothing stops to ask', !!profile, profile?.accountEmail ?? '(none found)')

board.ws.send(
  JSON.stringify({ t: 'session.create', projectId: board.project.id, adapterId: 'claude', title: 'Live', start: true }),
)
await sleep(4000)
const card = added.find((s) => s.adapterId === 'claude')
check('a real Claude card is running', !!card && card.pid !== null, card ? `pid ${card.pid}` : '(none)')
if (!card) {
  await board.stop()
  process.exit(1)
}

board.ws.send(JSON.stringify({ t: 'channel.create', projectId: board.project.id, x: 40, y: 40 }))
await sleep(1000)
const channel = channels[0]
board.ws.send(
  JSON.stringify({ t: 'wire.create', projectId: board.project.id, sourceId: channel.id, targetId: card.id }),
)
await sleep(1500)
const notes = join(board.home, 'mail', card.id, 'NOTES.md')
check('wiring it made the file', existsSync(notes), notes)

/*
 * Waited for rather than slept through. The CLI has to be up and quiet before anything typed at it
 * is read, which is the same condition the mail wake-up applies, so this watches the terminal go
 * quiet instead of guessing at a number.
 */
const scroll = join(board.home, 'scrollback', `${card.id}.log`)
let quietFor = 0
for (let i = 0; i < 60 && quietFor < 3; i++) {
  const was = existsSync(scroll) ? readFileSync(scroll, 'utf8').length : 0
  await sleep(1000)
  const now = existsSync(scroll) ? readFileSync(scroll, 'utf8').length : 0
  quietFor = now === was && now > 0 ? quietFor + 1 : 0
}
check('the CLI came up and settled', quietFor >= 3, `${readFileSync(scroll, 'utf8').length} bytes drawn`)

console.log('\n  asking it, through the message card...')
board.ws.send(
  JSON.stringify({
    t: 'channel.send',
    channelId: channel.id,
    text:
      'Append a reply to this same file. Your reply must contain the word ' +
      `${WORD} on a line of its own, and nothing else needs to be in it. Do not run any other task.`,
  }),
)

/*
 * The word has to be found in a block the CARD wrote, not anywhere in the file.
 *
 * A first version tested `file.includes(WORD)` and passed instantly, because the word is in the
 * instruction the owner sent: the check matched the question. The file had no reply in it at all.
 * That is the second time in this session a check has passed on the wrong bytes, and both times the
 * detail line was what gave it away, so the detail here prints the headings it actually found.
 */
const replyFrom = (text) => {
  const blocks = text.split(/^##\s+/m).slice(1)
  return blocks.find((b) => !/^Owner[,\s]/.test(b) && b.includes(WORD)) ?? null
}

let answered = ''
let reply = null
for (let i = 0; i < 90; i++) {
  await sleep(2000)
  answered = existsSync(notes) ? readFileSync(notes, 'utf8') : ''
  reply = replyFrom(answered)
  if (reply) break
}

const headings = answered
  .split('\n')
  .filter((l) => l.startsWith('## '))
  .map((l) => l.replace(/^##\s*/, '').split(',')[0])

check(
  'the card found the file and answered in it',
  !!reply,
  reply ? `it appended a block of its own` : `after three minutes the file holds only: ${headings.join(', ') || 'nothing'}`,
)

console.log('\n--- what is in the file ---')
console.log(answered.trim().split('\n').slice(0, 30).map((l) => `  ${l}`).join('\n'))

if (!reply) {
  /*
   * When it did not answer, the terminal is the only place that says why: whether it was told at
   * all, whether it went looking, and whether something refused it.
   */
  const term = existsSync(scroll) ? readFileSync(scroll, 'utf8') : ''
  const plain = term
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>]*[a-zA-Z]/g, ' ')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/[ ]{2,}/g, ' ')
  console.log('\n--- the last of its terminal ---')
  console.log(plain.slice(-1400).split('\n').map((l) => `  ${l}`).join('\n'))
}

await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
