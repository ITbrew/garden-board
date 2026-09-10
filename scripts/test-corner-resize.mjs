/**
 * Resizing a card from a corner, without needing aim.
 *
 * The handles were nine pixels square and only appeared once a card had been selected, so taking a
 * card by its diagonal was a two-step operation ending in a small target. This measures the target
 * the pointer actually gets, then drags a corner and reads the result out of the stored row.
 *
 * A drag that changes both width and height at once is the whole point: an edge handle moves one of
 * them, and the owner asked for the corner because he wants both.
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const garden = await startInstance()
const st = { projects: [], sessions: [] }
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(400)

const dir = mkdtempSync(join(tmpdir(), 'garden-resize-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Corner', start: false }))
await sleep(900)
const card = st.sessions.find((s) => s.title === 'Corner')
/*
 * Put it somewhere by hand first.
 *
 * A board where nothing has been moved is tiled automatically, and that tiling reports the
 * positions it chose back to the server. Measuring "did the card move while being resized" against
 * a stored position that the canvas was never using would be measuring the auto-tiler.
 */
ws.send(JSON.stringify({ t: 'session.move', sessionId: card.id, x: 400, y: 300 }))
await sleep(900)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 2200, height: 1300, deviceScaleFactor: 1 },
  args: ['--window-size=2200,1300', '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
await page.goto(`http://127.0.0.1:${garden.port}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

const node = await page.evaluate((id) => {
  const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}, card.id)
check('the card is on the page', !!node)

/*
 * The card starts at the top of its own wrapper.
 *
 * Giving the corner handles a relative position, so their enlarged target would anchor to them,
 * took four of them out of absolute positioning and stacked them above the card, pushing it
 * fifty-six pixels down and leaving an empty band across the top of every session on the board.
 */
const topGap = await page.evaluate((id) => {
  const wrap = document.querySelector(`.react-flow__node[data-id="${id}"]`)
  const card = wrap?.querySelector('.node')
  if (!wrap || !card) return null
  return Math.round(card.getBoundingClientRect().top - wrap.getBoundingClientRect().top)
}, card.id)
check('nothing is stacked above the card', topGap === 0, `card starts ${topGap}px down its wrapper`)

/*
 * And the handles must not cover the card's own controls. The top right corner is where the expand
 * button lives, and a target three times the drawn square was landing on top of it.
 */
const clash = await page.evaluate((id) => {
  const wrap = document.querySelector(`.react-flow__node[data-id="${id}"]`)
  const btn = wrap?.querySelector('.node-head button, .node-head .twisty')
  const h = wrap?.querySelector('.react-flow__resize-control.handle.top.right')
  if (!btn || !h) return null
  const b = btn.getBoundingClientRect()
  const r = h.getBoundingClientRect()
  const reach = 10
  const overlaps =
    r.left - reach < b.right && r.right + reach > b.left && r.top - reach < b.bottom && r.bottom + reach > b.top
  return { overlaps, btn: Math.round(b.left), handle: Math.round(r.left) }
}, card.id)
check('the corner handle does not cover the header buttons', clash ? !clash.overlaps : true,
  clash ? `button at x${clash.btn}, handle at x${clash.handle}` : 'no header button found')

// Hovering the card is what brings the handles out; before that nothing takes a click.
await page.mouse.move(node.left + 60, node.top + 30)
await sleep(400)

const target = await page.evaluate(() => {
  const h = document.querySelector('.react-flow__resize-control.handle.bottom.right')
  if (!h) return null
  const r = h.getBoundingClientRect()
  const after = getComputedStyle(h, '::after')
  const grow = Math.abs(parseFloat(after.getPropertyValue('inset') || after.top || '0')) || 0
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    drawn: Math.round(r.width),
    reach: Math.round(r.width + grow * 2),
    cursor: getComputedStyle(h).cursor,
    visible: getComputedStyle(h).opacity,
  }
})
check('a bottom-right corner handle exists', !!target)
check('and it is showing while the pointer is on the card', target?.visible === '1', `opacity ${target?.visible}`)
check('it says it will resize diagonally', target?.cursor === 'nwse-resize', target?.cursor ?? '')
check('and its target is bigger than the square it draws', (target?.reach ?? 0) >= 30,
  `draws ${target?.drawn}px, catches ${target?.reach}px`)

// Grab it a good way off centre, which is the case that used to miss entirely.
const before = st.sessions.find((s) => s.id === card.id)
await page.mouse.move(target.x + 7, target.y + 7)
await page.mouse.down()
for (let i = 1; i <= 10; i++) await page.mouse.move(target.x + 7 + i * 22, target.y + 7 + i * 14, { steps: 2 })
await page.mouse.up()
await sleep(1400)

// Drawn size as well as stored, so a drag that worked but never reached the server is told apart
// from one that never happened.
const drawnAfter = await page.evaluate((id) => {
  const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
  const r = el?.getBoundingClientRect()
  return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null
}, card.id)
console.log(`   drawn after the drag: ${drawnAfter?.w}x${drawnAfter?.h}`)

const after = st.sessions.find((s) => s.id === card.id)
check('dragging the corner made it wider', after.width > before.width + 60, `${before.width} to ${after.width}`)
check('and taller in the same drag', after.height > before.height + 40, `${before.height} to ${after.height}`)
check('and the card did not move while being resized',
  Math.abs(after.x - before.x) < 2 && Math.abs(after.y - before.y) < 2,
  `${Math.round(before.x)},${Math.round(before.y)} to ${Math.round(after.x)},${Math.round(after.y)}`)

await page.screenshot({ path: 'docs/shots/corner-resize.png' })
await browser.close()
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
