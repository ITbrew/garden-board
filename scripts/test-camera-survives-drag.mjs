/**
 * Dragging a card must not move the owner's camera.
 *
 * The failure this exists to catch, in the exact form it shipped in: the fit-view effect in
 * Canvas.tsx keyed itself on `${activeProjectId}:${auto}`, and `auto` is `shouldAutoPack`, which is
 * true only while EVERY card is still where the app put it. So the first drag of any card flipped
 * that flag false for the whole board, the key changed, and the effect ran a fresh `fitView`,
 * throwing away wherever the owner had panned to. He reported it as the camera resetting itself.
 *
 * Run this against the pre-fix Canvas.tsx and the second reading differs from the first. The point
 * of the test is that it is the SECOND time this bug shipped: the card count was already removed
 * from that same key, for the same reason, and the comment above it records that fix. A key made of
 * board state will keep growing new reasons to fit, so the guard belongs in a test rather than in a
 * comment asking the next person to remember.
 *
 * Its own Garden on its own port, never the owner's board. Needs `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({
  projectName: 'camera',
  cards: [{ title: 'Alpha' }, { title: 'Beta' }, { title: 'Gamma' }],
})

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--window-size=1600,1000', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
})

try {
  const page = await browser.newPage()
  await page.goto(board.UI, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.react-flow__viewport', { timeout: 20000 })
  // The arrival fit is on a 140ms timeout with a 200-220ms animation. Wait it out rather than
  // racing it, or the first reading is taken mid-flight and every comparison after it is noise.
  await sleep(2500)

  /** The camera itself, straight off the element ReactFlow transforms. */
  const cam = () =>
    page.$eval('.react-flow__viewport', (el) => el.style.transform || getComputedStyle(el).transform)

  /*
   * Pan somewhere deliberate first, so the assertion is about the owner's camera rather than about
   * two default views happening to match. Dragging the pane background is how he pans.
   */
  /*
   * Down and to the RIGHT, deliberately. Panning the other way slides the cards off the top left
   * and out of the window, and then the card drag below aims at negative page coordinates and
   * silently does nothing. The test still went green, because a drag that never happens cannot
   * move a camera either.
   */
  await page.mouse.move(700, 500)
  await page.mouse.down()
  await page.mouse.move(900, 650, { steps: 12 })
  await page.mouse.up()
  await sleep(800)

  const panned = await cam()
  check('panning the board moves the camera', panned !== '', `transform: ${panned}`)

  /*
   * Now drag a card. This is the flip: `manualPos` goes true on the server, `shouldAutoPack` goes
   * false for the whole board, and pre-fix the fit-view effect fired on the change.
   */
  const card = await page.$('.react-flow__node')
  if (!card) throw new Error('no card was drawn, so there was nothing to drag')
  /*
   * Where the card itself sits, so the drag can be proved to have happened.
   *
   * Without this the test is worthless and passes on the broken code: if the drag misses the
   * header, or lands on a resize handle, or ReactFlow ignores it, then nothing flips, nothing
   * resets, and two identical camera readings look exactly like a fix. That is not hypothetical.
   * It is what the first version of this test did.
   */
  const cardAt = () =>
    page.$eval('.react-flow__node', (el) => el.style.transform || getComputedStyle(el).transform)
  const cardBefore = await cardAt()
  const box = await card.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + 12)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 90, { steps: 12 })
  await page.mouse.up()
  // Longer than the 140ms timeout plus the 220ms animation, so a reset has time to happen and be
  // seen. A test that reads too early passes against the broken code.
  await sleep(2000)

  const cardAfter = await cardAt()
  check(
    'the drag actually moved the card',
    cardAfter !== cardBefore,
    cardAfter !== cardBefore ? '' : `card never moved from ${cardBefore}, so nothing below is proof`,
  )

  const afterDrag = await cam()
  check(
    'the camera survives a card drag',
    afterDrag === panned,
    afterDrag === panned ? '' : `was ${panned}, became ${afterDrag}`,
  )

  // A second drag, because the flag only flips once: the first drag is the one that used to cost
  // him the view, and a test that only ever drags once would pass on a fix that merely delayed it.
  const box2 = await card.boundingBox()
  await page.mouse.move(box2.x + box2.width / 2, box2.y + 12)
  await page.mouse.down()
  await page.mouse.move(box2.x + box2.width / 2 - 60, box2.y + 40, { steps: 10 })
  await page.mouse.up()
  await sleep(1500)

  const afterSecond = await cam()
  check(
    'and survives the next one',
    afterSecond === panned,
    afterSecond === panned ? '' : `was ${panned}, became ${afterSecond}`,
  )

  /*
   * A card appearing must not move the viewport either, and this is the owner's own second report:
   * the camera moves when a session finishes work. Finishing often means a dispatch, a dispatch
   * makes a subagent card, and the count moves. The comment beside the effect claims the count was
   * already taken out for this reason, so this is the assertion that says whether that is true of
   * the code or only of the comment.
   */
  const nodesBefore = (await page.$$('.react-flow__node')).length
  board.ws.send(
    JSON.stringify({
      t: 'session.create',
      projectId: board.project.id,
      adapterId: 'shell',
      title: 'Delta',
      start: false,
    }),
  )
  await sleep(2500)
  const nodesAfter = (await page.$$('.react-flow__node')).length
  check('the new card was actually drawn', nodesAfter > nodesBefore, `${nodesBefore} then ${nodesAfter}`)

  /*
   * Compared with the reading immediately before it rather than with the original pan, and that is
   * not a detail. Against a stale baseline, one earlier reset makes every later check fail too, and
   * a cascade reads exactly like four separate bugs. It is how the first run of this test appeared
   * to prove that a card appearing moves the camera, when the camera had simply not moved back
   * after the drag.
   */
  const afterCreate = await cam()
  check(
    'the camera survives a card appearing',
    afterCreate === afterSecond,
    afterCreate === afterSecond ? '' : `was ${afterSecond}, became ${afterCreate}`,
  )

  /*
   * And a stray Backspace must not take a card off the board. React Flow deletes on Backspace by
   * default and nothing sets `deleteKeyCode` here, so the owner hitting backspace once too often
   * with focus outside a terminal input is a real candidate for cards vanishing and the count
   * moving under him. This says whether that is a live hole or a false lead.
   */
  const target = await page.$('.react-flow__node')
  const tb = await target.boundingBox()
  await page.mouse.click(tb.x + tb.width / 2, tb.y + 8)
  await sleep(400)
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await sleep(1500)

  const nodesAfterKey = (await page.$$('.react-flow__node')).length
  check(
    'backspace does not remove a card',
    nodesAfterKey === nodesAfter,
    nodesAfterKey === nodesAfter ? '' : `${nodesAfter} cards became ${nodesAfterKey}`,
  )

  const afterKey = await cam()
  check(
    'and does not move the camera',
    afterKey === afterCreate,
    afterKey === afterCreate ? '' : `was ${afterCreate}, became ${afterKey}`,
  )
} finally {
  await browser.close()
  await board.stop()
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
