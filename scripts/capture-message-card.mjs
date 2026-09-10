/**
 * Shots of the message card in the three states it actually has, for a blind pass.
 *
 * A card whose whole job is to be readable cannot be signed off by the person who wrote its markup.
 * These go to somebody who has not seen the code, with neutral questions.
 *
 * Its own Garden, its own port, its own workspace, like every harness here.
 *
 *   npm run build
 *   node scripts/capture-message-card.mjs
 */
import puppeteer from 'puppeteer-core'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.SHOT_DIR || join(ROOT, 'docs', 'shots', 'message-card')
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const board = await openBoard({ cards: ['Orchestrator'] })
const card = board.cards[0]

const channels = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'channel.added' || m.t === 'channel.updated') channels.push(m.channel)
})

board.ws.send(JSON.stringify({ t: 'channel.create', projectId: board.project.id, x: 520, y: 60 }))
await sleep(1000)
const channel = channels[0]

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1700, height: 1100, deviceScaleFactor: 1 },
  args: ['--window-size=1700,1100', '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

const taken = []
/*
 * The card or nothing, and never the page instead.
 *
 * A first version fell back to photographing the whole window when it could not find the card, and
 * the card was never on the canvas at all: a dependency array left it out, so the node existed on
 * the server and was never drawn. Three shots of a session card went to a reviewer under three
 * filenames promising three states of a message card, and the only reason it was caught is that the
 * reviewer said all three were the same picture and none of them was what the names claimed.
 *
 * That is the harness lying about the app, which is worse than no harness. It fails here instead.
 */
const shot = async (name, what) => {
  await sleep(1200)
  const el = await page.$('.channel')
  if (!el) throw new Error(`no message card on the board to photograph for "${name}". Nothing was captured.`)
  await el.screenshot({ path: join(OUT, `${name}.png`) })
  taken.push({ name, what })
  console.log('shot:', join(OUT, `${name}.png`))
}

await shot('01-not-yet-wired', 'A message card that has been put on the board and not yet wired to anything.')

board.ws.send(
  JSON.stringify({ t: 'wire.create', projectId: board.project.id, sourceId: channel.id, targetId: card.id }),
)
await sleep(1500)
await shot('02-wired-and-empty', 'Wired to a card, with nothing said in it yet.')

const notes = join(board.home, 'mail', card.id, 'NOTES.md')
board.ws.send(
  JSON.stringify({
    t: 'channel.send',
    channelId: channel.id,
    text: "Don't start the roots job yet. I want to see how the board's own notes read first, and I'd rather you didn't hire anyone for it.",
  }),
)
await sleep(1200)
/*
 * Stamped from the clock rather than written in by hand.
 *
 * A hardcoded time put the card's reply hours after the owner's first line and hours BEFORE his
 * second, so the shot showed a conversation whose timestamps contradicted its own order. A blind
 * reviewer read that as a defect and was right to, because the picture said so. It was the fixture
 * inventing a time the rest of the shot did not agree with.
 */
appendFileSync(
  notes,
  `\n## Orchestrator, ${new Date().toLocaleString('en-GB', { hour12: false })}\n\n` +
    'Held. I have not hired anyone and nothing is started.\n\n' +
    'One thing worth saying now rather than later: the roots job touches the same file the Tactics ' +
    'Board card is editing, so whoever picks it up will be waiting on that card either way.\n',
  'utf8',
)
await sleep(2000)
board.ws.send(
  JSON.stringify({ t: 'channel.send', channelId: channel.id, text: 'Good. Leave it with me overnight.' }),
)
await sleep(1500)
await shot('03-a-conversation', 'The same card after three exchanges: two from the owner, one from the card.')

writeFileSync(
  join(OUT, 'INDEX.md'),
  ['# What each shot is', '', ...taken.map((t) => `- \`${t.name}.png\`  ${t.what}`), ''].join('\n'),
  'utf8',
)
console.log(errors.length ? `\nconsole errors:\n${errors.slice(0, 8).join('\n')}` : '\nno console errors')

await browser.close()
await board.stop()
