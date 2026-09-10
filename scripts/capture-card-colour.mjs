/**
 * Shots of a card's colour being the whole card, on a scratch board of its own.
 *
 * The claim under test is visual and there is no honest way to assert it in text: "the border takes
 * the colour on all four sides", "the header is tinted and the title is still readable", "two cards
 * can be told apart at a glance" are all things a reviewer has to look at. So this makes the two
 * states side by side and photographs them.
 *
 * Three cards rather than the two the order asks for. Two prove a coloured card differs from a
 * default one; the third, in a different hue, is what proves the tint is strong enough to tell two
 * COLOURED cards apart, which is the third acceptance item and cannot be seen with one of them.
 *
 * The cards are started for real, with `start: true`, and that is not incidental. `openBoard`'s own
 * seeding creates cards switched off, and an off card takes the `.is-off` path, which has its own
 * background and its own border. A shot of three off cards would show the quiet variant of this
 * change and say nothing about the ordinary one.
 *
 *   npm run build
 *   node scripts/capture-card-colour.mjs
 *
 * Its own port and its own GARDEN_HOME, per docs/canonical/14-how-tests-are-run.md. Nothing here
 * touches the live board or the owner's workspace.
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const WIDTH = 2600
const HEIGHT = 1300

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const board = await openBoard({ projectName: 'colour-shots' })

/** The two colours are two of the seven the card menu offers, taken from its own list. */
const CARDS = [
  { title: 'Default', colour: null },
  { title: 'Violet', colour: '#7c5cff' },
  { title: 'Teal', colour: '#2dd4bf' },
  /*
   * A working card, coloured, because the busy ring already reads the same `--role-color` the
   * border now takes. A ring travelling just inside a border of its own colour is the one way this
   * change could quietly take something away, and "nothing that currently shows a card's colour
   * stops showing it" is an acceptance item. It has to be looked at rather than reasoned about.
   */
  { title: 'Amber busy', colour: '#f59e0b', working: true },
]

for (const spec of CARDS) {
  board.ws.send(
    JSON.stringify({
      t: 'session.create',
      projectId: board.project.id,
      adapterId: 'shell',
      title: spec.title,
      start: true,
    }),
  )
  await sleep(1600)
}

/*
 * The colour is set through the same socket message the right-click menu sends, rather than by
 * writing a row. The menu and `setSessionColor` are not what changed here, so going around them
 * would be taking a shortcut past the only part of the path that is already known to work.
 */
for (const spec of CARDS) {
  if (!spec.colour) continue
  const card = board.state.sessions.find((s) => s.title === spec.title)
  if (!card) throw new Error(`the card "${spec.title}" was never created`)
  board.ws.send(JSON.stringify({ t: 'session.setColor', sessionId: card.id, color: spec.colour }))
  await sleep(400)
}
/*
 * A card is made genuinely `working` by posting the hook event the real CLI posts, at the same
 * `/hook` door, rather than by writing a status onto the row. A status set by hand proves nothing
 * about the path that sets it in life. `receivedAt` is required or the event row is refused on a
 * NOT NULL column.
 */
for (const spec of CARDS) {
  if (!spec.working) continue
  const card = board.state.sessions.find((s) => s.title === spec.title)
  await fetch(`http://127.0.0.1:${board.port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gardenSessionId: card.id,
      receivedAt: Date.now(),
      event: { hook_event_name: 'UserPromptSubmit', prompt: 'work on the loader' },
    }),
  })
  await sleep(400)
}
await sleep(1200)

/*
 * Only what this side can honestly see. `openBoard`'s socket reader does not follow
 * `session.updated`, so its copy of a card never learns the colour that was just set; printing it
 * from here would print "none" for a card that is coloured. What the colour actually became is read
 * out of the browser further down, which is the side that has to be right anyway.
 */
for (const spec of CARDS) {
  const card = board.state.sessions.find((s) => s.title === spec.title)
  console.log(`${spec.title}: pid ${card?.pid ?? 'none'}, asked for ${spec.colour ?? 'no colour'}`)
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: WIDTH, height: HEIGHT },
  args: [`--window-size=${WIDTH},${HEIGHT}`],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(board.UI, { waitUntil: 'networkidle2' })
// Long enough for the three terminals to have drawn something, since the point of the faint body
// tint is that it does not fight what the terminal prints.
await sleep(4000)

const shot = async (name, clip) => {
  const file = join(OUT, name)
  await page.screenshot(clip ? { path: file, clip } : { path: file })
  console.log(`shot: ${file}`)
  return file
}

await shot('30-card-colour-board.png')

/*
 * Close in on the three cards together, because the whole claim is a comparison and a full-board
 * shot at this width puts them small enough that a seven percent tint is arguable rather than
 * visible. One clip around all three, not one shot each: side by side is the evidence.
 */
const box = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.react-flow__node')]
  if (!nodes.length) return null
  const rects = nodes.map((n) => n.getBoundingClientRect())
  const x = Math.min(...rects.map((r) => r.left))
  const y = Math.min(...rects.map((r) => r.top))
  const right = Math.max(...rects.map((r) => r.right))
  const bottom = Math.max(...rects.map((r) => r.bottom))
  return { x, y, width: right - x, height: bottom - y, count: nodes.length }
})
console.log(`cards drawn on the canvas: ${box?.count ?? 0}`)

if (box && box.width > 0) {
  const pad = 60
  await shot('31-card-colour-close.png', {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: Math.min(WIDTH - Math.max(0, box.x - pad), box.width + pad * 2),
    height: Math.min(HEIGHT - Math.max(0, box.y - pad), box.height + pad * 2),
  })
} else {
  console.log('no close shot: no card had a box')
}

/*
 * What the browser actually computed, printed beside the picture.
 *
 * A screenshot shows that something changed and cannot say what the rule resolved to, and
 * `color-mix` is exactly the kind of thing that either works or silently drops the whole
 * declaration. Reading the computed values back is what turns "it looks tinted" into a number, and
 * it is also the check that a card with no colour set is untouched.
 */
const measured = await page.evaluate(() => {
  /*
   * The header contrast as a number, because "the title stays readable" is the acceptance item and
   * an eye on a screenshot cannot settle it. WCAG relative luminance, read off what the browser
   * actually computed rather than off the values written in the stylesheet, so a `color-mix` that
   * failed to parse shows up here as the untinted value instead of quietly passing.
   */
  const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  /*
   * Two forms come back and they are on different scales, which is a trap worth naming: a plain
   * colour computes to `rgb(17, 21, 36)` with channels 0-255, and a `color-mix` result computes to
   * `color(srgb 0.142 0.132 0.296)` with channels 0-1. Dividing both by 255 makes every mixed
   * colour read as almost black, and the contrast then comes out uniformly excellent for every
   * card, which is what the first run of this reported.
   */
  const luminance = (css) => {
    const probe = document.createElement('span')
    probe.style.color = css
    document.body.appendChild(probe)
    const computed = getComputedStyle(probe).color
    probe.remove()
    const nums = computed.match(/[\d.]+/g).map(Number)
    const parts = computed.startsWith('color(') ? nums.slice(0, 3) : nums.slice(0, 3).map((n) => n / 255)
    return 0.2126 * channel(parts[0]) + 0.7152 * channel(parts[1]) + 0.0722 * channel(parts[2])
  }
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
  }
  const out = {}
  for (const node of document.querySelectorAll('.react-flow__node')) {
    const card = node.querySelector('.node')
    const title = node.querySelector('.node-title')?.textContent?.trim() ?? '?'
    if (!card) continue
    const head = card.querySelector('.node-head')
    const cs = getComputedStyle(card)
    out[title] = {
      tinted: card.classList.contains('is-tinted'),
      busy: card.classList.contains('is-busy'),
      roleColor: cs.getPropertyValue('--role-color').trim(),
      borderTop: cs.borderTopColor,
      borderRight: cs.borderRightColor,
      borderBottom: cs.borderBottomColor,
      borderLeft: cs.borderLeftColor,
      cardBackground: cs.backgroundColor,
      headBackground: head ? getComputedStyle(head).backgroundColor : null,
      headText: head ? getComputedStyle(head).color : null,
      titleContrast: head
        ? contrast(getComputedStyle(head).backgroundColor, getComputedStyle(head).color)
        : null,
    }
  }
  return out
})
console.log(JSON.stringify(measured, null, 2))

console.log(errors.length ? `console errors: ${errors.join('; ')}` : 'no console errors')

await browser.close()
await board.stop()
