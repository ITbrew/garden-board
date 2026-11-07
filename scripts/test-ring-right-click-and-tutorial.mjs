/**
 * The rings tutorial shows once and spotlights the Loops section, and the ring's right-click menu
 * starts, pauses and disables its loop. A disabled tab still does mail. Canon 23, 25.
 * Its own Garden and workspace, shell cards, the BUILT app, so run `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const shots = process.argv[2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (ok, ms = 8000) => {
  for (let waited = 0; waited < ms && !ok(); waited += 100) await sleep(100)
}
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const LIST = '# TO DO\n\n## Now: Test\n\n- [x] First\n  - End: one.\n- [ ] Second\n  - [ ] Part\n    - Why: Part meaning.\n    - End: part end.\n'
const board = await openBoard({
  cards: [{ title: 'Boss', roleClass: 'orchestrator' }, { title: 'Helper', roleClass: 'worker', reportsTo: 0 }],
  files: { 'TODO.md': LIST },
})
const [boss, helper] = board.cards
const projectId = board.project.id
let loops = []
const tokens = new Map()
const refusals = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'loops' && m.projectId === projectId) loops = m.loops
  if (m.t === 'session.token') tokens.set(m.sessionId, m.token)
  if (m.t === 'error') refusals.push(m.message)
})
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1700, height: 1000 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

// The tutorial.
const tourTitle = () => page.$eval('.rings-tour h2', (n) => n.textContent).catch(() => null)
const pressTour = (name) => page.evaluate((name) => {
  const b = [...document.querySelectorAll('.rings-tour button')].find((n) => n.textContent === name)
  b?.click()
  return !!b
}, name)
const spotted = (sel) => page.$eval(sel, (n) => n.classList.contains('tour-spot')).catch(() => false)
check('the tutorial opens on the ring', (await tourTitle()) === 'This is your goal ring', await tourTitle())
check('with the ring highlighted', await spotted('.goal-ring__disc'))
check('saying what the ring is', /goals and sub-goals/.test(await page.$eval('.rings-tour p', (n) => n.textContent)))
const wired = (sel) => page.evaluate((sel) => {
  // The line must start on the thing, and end on the panel.
  const pts = document.querySelector('.rings-tour__wire polyline')?.getAttribute('points')?.split(' ').map((p) => p.split(',').map(Number))
  const t = document.querySelector(sel)?.getBoundingClientRect()
  const b = document.querySelector('.rings-tour')?.getBoundingClientRect()
  if (!pts || !t || !b) return false
  const [x, y] = pts[0]
  const [ex, ey] = pts[pts.length - 1]
  return x >= t.left - 2 && x <= t.right + 2 && y >= t.top - 2 && y <= t.bottom + 2 && ex >= b.left - 2 && ex <= b.right + 2 && ey >= b.top && ey <= b.bottom
}, sel)
check('with a line from the ring to the step', await wired('.goal-ring__disc'))
if (shots) await page.screenshot({ path: join(shots, 'tour-1.png') })
await pressTour('Next')
await sleep(400)
check('step 2 lights one goal arc', (await page.$$('.goal-ring__seg[data-ring="goal"].tour-spot')).length === 1)
check('with the line starting at that arc', await wired('.goal-ring__seg[data-ring="goal"].tour-spot'))
if (shots) await page.screenshot({ path: join(shots, 'tour-2.png') })
await pressTour('Next')
await sleep(500)
check('it reaches the loops', (await tourTitle()) === 'Loops keep it moving', await tourTitle())
check('with the Loops section highlighted', await spotted('.rail-section.rail-loops'))
check('and the ring no longer', !(await spotted('.goal-ring__disc')))
check('with the line starting at it', await wired('.rail-section.rail-loops'))
check('saying what is active', /No loop active/.test(await page.$eval('.rings-tour__state', (n) => n.textContent)))
if (shots) await page.screenshot({ path: join(shots, 'tour-loops.png') })
await pressTour('Next')
await sleep(400)
check('step 4 asks for a right-click', (await tourTitle()) === 'Now right-click the ring', await tourTitle())
const tourButtons = () => page.$$eval('.rings-tour button', (ns) => ns.map((n) => n.textContent))
check('and cannot be passed without one', !(await tourButtons()).includes('Next') && !(await tourButtons()).includes('Done'), JSON.stringify(await tourButtons()))
if (shots) await page.screenshot({ path: join(shots, 'tour-4a.png') })
{
  const box = await page.$eval('.goal-ring__disc', (n) => {
    const r = n.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.14 }
  })
  await page.mouse.click(box.x, box.y, { button: 'right' })
}
await sleep(500)
check('right-clicking moves it on', (await tourTitle()) === 'You control the loop here', await tourTitle())
const lit = await page.$$eval('.ctxmenu__item.tour-spot .ctxmenu__label', (ns) => ns.map((n) => n.textContent))
check('with Start, Pause and Disable highlighted', lit.join() === 'Start,Pause,Disable', lit.join())
check('and the line on the menu', await wired('.ctxmenu'))
if (shots) await page.screenshot({ path: join(shots, 'tour-4b.png') })
await pressTour('Done')
await sleep(300)
check('Done closes it', (await tourTitle()) === null)
check('with nothing left highlighted', (await page.$$('.tour-spot')).length === 0)
await page.reload({ waitUntil: 'networkidle2' })
await sleep(2500)
check('and it does not come back', (await tourTitle()) === null)

// The menu.
const ringPoint = () => page.$eval('.goal-ring__disc', (n) => {
  const r = n.getBoundingClientRect()
  const bar = n.querySelector('.goal-ring__seg')
  const b = bar ? bar.getBoundingClientRect() : r
  return { x: r.left + r.width / 2, y: r.top + r.height * 0.14, bx: b.left, by: b.top }
})
const openMenu = async () => {
  const p = await ringPoint()
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await sleep(300)
}
const menuItems = () => page.evaluate(() => [...document.querySelectorAll('.ctxmenu__item')].map((n) => ({ text: n.querySelector('.ctxmenu__label')?.textContent.trim(), off: n.classList.contains('is-disabled') })))
const pick = async (name) => {
  const ok = await page.evaluate((name) => {
    const b = [...document.querySelectorAll('.ctxmenu__item')].find((n) => n.querySelector('.ctxmenu__label')?.textContent.trim() === name)
    b?.click()
    return !!b
  }, name)
  await sleep(700)
  return ok
}
await openMenu()
const items = await menuItems()
check('right-clicking the ring offers Start, Pause and Disable', ['Start', 'Pause', 'Disable'].every((w) => items.some((i) => i.text.startsWith(w))), JSON.stringify(items))
check('only Start can be pressed with no loop running', !items.find((i) => i.text.startsWith('Start'))?.off && items.find((i) => i.text.startsWith('Pause'))?.off, JSON.stringify(items))
if (shots) await page.screenshot({ path: join(shots, 'ring-menu.png') })
await pick('Start')
await until(() => loops[0]?.enabled === true)
check('Start writes and runs a ring loop on the orchestrator', loops[0]?.enabled === true && loops[0]?.followsRing === true && loops[0]?.sessionId === boss.id, JSON.stringify(loops[0]))

await sleep(800)
await openMenu()
await pick('Pause')
await until(() => loops[0]?.enabled === false)
check('Pause holds it', loops[0]?.enabled === false && loops[0]?.stoppedBy === 'owner', JSON.stringify(loops[0]))
await sleep(300)
check('and the ring shows it is held', !!(await page.$('.goal-ring__open.is-held')))
await sleep(22000)
check('a paused loop stays paused with goals left', loops[0]?.enabled === false)

await openMenu()
await pick('Disable')
await until(() => loops[0]?.stoppedBy === 'disabled')
await sleep(500)
check('Disable turns it off for the tab', loops[0]?.enabled === false && loops[0]?.stoppedBy === 'disabled', JSON.stringify(loops[0]))
await sleep(22000)
check('a disabled loop stays off', loops[0]?.enabled === false)

// A disabled tab still does mail, and a card cannot start the loop again.
board.ws.send(JSON.stringify({ t: 'session.token', sessionId: helper.id }))
board.ws.send(JSON.stringify({ t: 'session.token', sessionId: boss.id }))
for (let i = 0; i < 20 && tokens.size < 2; i++) await sleep(200)
const res = await fetch(`http://127.0.0.1:${board.port}/mail`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.get(helper.id)}` },
  body: JSON.stringify({ from: helper.id, to: boss.id, kind: 'work', taskId: 'disabled-mail', text: 'STILL_MAIL' }),
})
check('a card can still send mail', res.status === 200, String(res.status))
await sleep(600)
check('and it arrives', readFileSync(join(board.home, 'mail', boss.id, 'INBOX.md'), 'utf8').includes('STILL_MAIL'))

const { WebSocket } = await import('ws')
const asCard = new WebSocket(`ws://127.0.0.1:${board.port}/ws`, { headers: { authorization: `Bearer ${tokens.get(boss.id)}` } })
const said = []
asCard.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'error') said.push(m.message)
})
await new Promise((r) => asCard.on('open', r))
asCard.send(JSON.stringify({ t: 'hello', token: tokens.get(boss.id) }))
await sleep(500)
asCard.send(JSON.stringify({ t: 'loop.set', projectId, loop: { id: loops[0].id, sessionId: boss.id, prompt: loops[0].prompt, minutes: loops[0].minutes, enabled: true } }))
await sleep(800)
check('a card cannot start a disabled loop', loops[0]?.enabled === false && said.some((s) => /disabled/i.test(s)), JSON.stringify(said))
asCard.send(JSON.stringify({ t: 'ring.control', projectId, op: 'start' }))
await sleep(600)
check('nor press the menu for the owner', loops[0]?.enabled === false)
asCard.close()

await openMenu()
await pick('Start')
await until(() => loops[0]?.enabled === true)
check('the owner can start it again', loops[0]?.enabled === true && loops[0]?.stoppedBy === null, JSON.stringify(loops[0]))
// Hovering a sub-goal says whose it is.
const innerPoint = await page.evaluate(() => {
  const g = [...document.querySelectorAll('.goal-ring__seg')].find((n) => !n.dataset.ring)
  const hit = g.querySelector('.goal-ring__hit')
  const at = hit.getPointAtLength(hit.getTotalLength() / 4).matrixTransform(hit.getScreenCTM())
  return { x: at.x, y: at.y }
})
await page.mouse.move(innerPoint.x, innerPoint.y)
await sleep(400)
const hover = await page.$eval('.goal-ring__note--hint', (n) => [...n.children].map((c) => c.textContent.trim())).catch(() => [])
check('hovering a sub-goal shows its goal, then its title, then its definition', hover[0] === 'Second' && hover[1] === 'Part' && hover[2] === 'Part meaning.' && hover[3] === 'Done when: part end.', JSON.stringify(hover))
if (shots) await page.screenshot({ path: join(shots, 'part-hover.png') })
check('no page errors', errors.length === 0, errors[0] ?? '')

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
