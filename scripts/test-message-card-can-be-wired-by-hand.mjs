/**
 * Proves a message card can be wired to a card by dragging, which is the only way it ever gets bound.
 *
 * The card was shipped with its connection points invisible. They were copied from the derived
 * column headers, where hiding them is right because nothing is ever wired to one by hand, and on a
 * message card that is exactly backwards: drawing the wire is the whole of how it binds, and its own
 * empty state tells the owner to draw one. His words: "theres no connecting point for the message
 * card to link to the role cards."
 *
 * Every other test of this feature sent `wire.create` down the socket, which is why none of them
 * noticed. This one drags with a mouse, because the thing that was missing only exists on screen.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Orchestrator'] })
const card = board.cards[0]
const channels = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'channel.added' || m.t === 'channel.updated') channels.push(m.channel)
  if (m.t === 'wire.added') console.log('   wire.added:', m.wire.sourceId.slice(0, 8), '->', m.wire.targetId.slice(0, 8))
  if (m.t === 'error') console.log('   error:', m.message)
})

// Placed clear of the card, so the drag below crosses open board rather than starting on top of it.
board.ws.send(JSON.stringify({ t: 'channel.create', projectId: board.project.id, x: 700, y: 80 }))
await sleep(1200)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1700, height: 1100 },
})
const page = await browser.newPage()
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

/*
 * Where a handle is on screen, asked for by side AND by direction.
 *
 * Both are needed. Each side of these cards carries two handles stacked on the same spot, one that
 * a wire leaves from and one that it arrives at, so picking by side alone gets whichever is first
 * in the markup. A first run of this test dragged from the target and nothing happened, which looks
 * exactly like the connection points being broken and is really the drag having no source to start
 * from. The same is true of the session cards, so it is the board's behaviour rather than this
 * card's.
 */
const pinAt = (nodeId, side, role) =>
  page.evaluate(
    (id, s, r) => {
      const node = document.querySelector(`.react-flow__node[data-id="${id}"]`)
      if (!node) return null
      const pin = node.querySelector(`.react-flow__handle-${s}.${r}.node-pin`)
      if (!pin) return null
      const b = pin.getBoundingClientRect()
      if (b.width === 0 || b.height === 0) return null
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }
    },
    nodeId,
    side,
    role,
  )

const channelPin = await pinAt(channels[0].id, 'left', 'source')
check(
  'the message card has a connection point you can see and hit',
  !!channelPin && channelPin.w >= 6 && channelPin.h >= 6,
  channelPin ? `${Math.round(channelPin.w)}x${Math.round(channelPin.h)} px at ${Math.round(channelPin.x)},${Math.round(channelPin.y)}` : 'there is nothing there',
)

const cardPin = await pinAt(card.id, 'right', 'target')
check('and the session card has one to reach', !!cardPin)

if (channelPin && cardPin) {
  // Dragged, not sent. The point is that a person with a mouse can do this.
  await page.mouse.move(channelPin.x, channelPin.y)
  await page.mouse.down()
  await page.mouse.move(cardPin.x, cardPin.y, { steps: 25 })
  await page.mouse.up()
  await sleep(1500)
  await sleep(2500)
}

const bound = channels[channels.length - 1]
check(
  'dragging between the two binds them',
  bound?.sessionId === card.id,
  bound?.sessionId ? `bound to ${bound.sessionId.slice(0, 8)}` : 'still bound to nobody',
)
/*
 * Drawn, not merely stored. The set that decides which wires get drawn was built from the packed
 * cards alone, so a wire to a message card was filtered out of it: bound, renamed, and joined to
 * the card by nothing visible. Counting the edges is the only way that shows up.
 */
check(
  'and the wire between them is actually drawn',
  (await page.evaluate(() => document.querySelectorAll('.react-flow__edge').length)) >= 1,
  `${await page.evaluate(() => document.querySelectorAll('.react-flow__edge').length)} edges on the canvas`,
)
check(
  'and the card now names who it is talking to',
  await page.evaluate(() => document.querySelector('.channel-title')?.textContent ?? ''),
  await page.evaluate(() => document.querySelector('.channel-title')?.textContent ?? '(no title)'),
)

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
