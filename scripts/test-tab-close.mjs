/**
 * Closing a tab: everything in it stops, and it leaves the row.
 *
 * Driven through a real browser because the parts that can break are all on that side: whether a
 * right-click on the tab opens Garden's own menu rather than Chrome's, whether the confirm step
 * actually gates it, and whether the tab goes. The consequences are then read from the stored rows,
 * which is where the truth about a killed process and a deleted board is.
 *
 * This is the most destructive button in the app, so the test spends most of its length on the case
 * where the owner changes his mind: right-clicking must not remove anything, and neither must
 * backing out at the second step.
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
const st = { projects: [], sessions: [], docs: [], wires: [] }
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs, wires: m.wires })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'project.removed') st.projects = st.projects.filter((p) => p.id !== m.projectId)
  /*
   * Added-or-updated, never blindly appended. Reopening a tab announces every card it is putting
   * back, and a reducer that pushes each one produces two of everything and a test that reports the
   * app duplicating cards it never duplicated.
   */
  else if (m.t === 'session.added' || m.t === 'session.updated')
    st.sessions = [...st.sessions.filter((s) => s.id !== m.session.id), m.session]
  else if (m.t === 'session.removed') st.sessions = st.sessions.filter((s) => s.id !== m.sessionId)
  else if (m.t === 'doc.added' || m.t === 'doc.updated')
    st.docs = [...st.docs.filter((d) => d.id !== m.card.id), m.card]
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
  else if (m.t === 'wire.added') st.wires.push(m.wire)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(400)

const make = async (label) => {
  const dir = mkdtempSync(join(tmpdir(), `garden-${label}-`))
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${label}\n`)
  ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
  await sleep(1400)
  return st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
}

/*
 * Two tabs, so the test can tell "the right one closed" from "everything vanished", and so the row
 * still has something in it afterwards.
 */
const keep = await make('keep')
const doomed = await make('doomed')
check('two tabs exist', !!keep && !!doomed)

// A live shell in the doomed tab, because stopping running work is the point of the button.
ws.send(JSON.stringify({ t: 'session.create', projectId: doomed.id, adapterId: 'shell', title: 'Runner' }))
await sleep(2500)
ws.send(JSON.stringify({ t: 'session.create', projectId: doomed.id, adapterId: 'shell', title: 'Second', start: false }))
await sleep(1200)
ws.send(JSON.stringify({ t: 'context.open', sessionId: st.sessions.find((s) => s.title === 'Runner').id }))
await sleep(1800)

const runner = st.sessions.find((s) => s.title === 'Runner')
check('a session in it is actually running', runner?.pid !== null, `pid ${runner?.pid}`)
check('and it has cards hanging off it', st.docs.filter((d) => d.projectId === doomed.id).length > 0)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 2200, height: 1300, deviceScaleFactor: 1 },
  args: ['--window-size=2200,1300', '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
// A native dialog would block every later command, so fail loudly rather than hang.
page.on('dialog', async (d) => {
  console.log('   a browser dialog appeared, which this flow must not use:', d.message())
  await d.dismiss()
})
await page.goto(`http://127.0.0.1:${garden.port}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

const tabAt = async (name) =>
  page.evaluate((n) => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent?.includes(n))
    if (!tab) return null
    const r = tab.getBoundingClientRect()
    return { x: r.left + 30, y: r.top + r.height / 2 }
  }, name)

const spot = await tabAt(doomed.name)
check('the tab is on the page', !!spot, spot ? '' : 'no tab with that name')

const menuItems = () =>
  page.evaluate(() => [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].map((b) => b.textContent?.trim()))

if (spot) {
  await page.mouse.click(spot.x, spot.y, { button: 'right' })
  await sleep(600)
  const first = await menuItems()
  check('right-clicking it opens a menu', first.length > 0, first.join(' | '))
  check('offering to close that tab by name', first.some((t) => t?.includes(doomed.name)), first.join(' | '))
  check('and saying what is running in it', first.some((t) => /running/i.test(t ?? '')), first.join(' | '))

  // Backing out at the first step.
  await page.keyboard.press('Escape')
  await sleep(400)
  check('escaping the menu removes nothing', st.projects.some((p) => p.id === doomed.id))

  // Now the confirm step, and back out of that too.
  await page.mouse.click(spot.x, spot.y, { button: 'right' })
  await sleep(500)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].find((x) => /^Close/.test(x.textContent ?? ''))
    b?.click()
  })
  await sleep(500)
  const second = await menuItems()
  check('choosing close asks again before doing it', second.some((t) => /^Yes/.test(t ?? '')), second.join(' | '))
  check('and offers a way out', second.some((t) => /Keep it/.test(t ?? '')), second.join(' | '))

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].find((x) => /Keep it/.test(x.textContent ?? ''))
    b?.click()
  })
  await sleep(700)
  check('keeping it removes nothing', st.projects.some((p) => p.id === doomed.id))
  check('and its sessions are untouched', st.sessions.filter((s) => s.projectId === doomed.id).length === 2)

  // And through to the end.
  await page.mouse.click(spot.x, spot.y, { button: 'right' })
  await sleep(500)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].find((x) => /^Close/.test(x.textContent ?? ''))
    b?.click()
  })
  await sleep(500)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].find((x) => /^Yes/.test(x.textContent ?? ''))
    b?.click()
  })
  await sleep(2000)

  check('the tab is gone from the row', !st.projects.some((p) => p.id === doomed.id))
  /*
   * Closing is not deleting. The owner asked for a tab he can put down and pick up later, so the
   * board is kept exactly as it was and only the processes end.
   */
  check('its sessions are stopped rather than removed',
    st.sessions.filter((s) => s.projectId === doomed.id).length === 2,
    `${st.sessions.filter((s) => s.projectId === doomed.id).length} cards still recorded`)
  check('and none of them still claims to be running',
    st.sessions.filter((s) => s.projectId === doomed.id).every((s) => s.pid === null))
  check('its cards are kept too', st.docs.filter((d) => d.projectId === doomed.id).length > 0)
  check('the other tab is untouched', st.projects.some((p) => p.id === keep.id))

  const left = await page.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => t.textContent?.trim()))
  check('and the row no longer shows it', !left.some((t) => t?.includes(doomed.name)), left.join(' | '))

  // And it comes back whole, which is the point of closing rather than deleting.
  const cardsBefore = st.docs.filter((d) => d.projectId === doomed.id).length
  ws.send(JSON.stringify({ t: 'project.reopen', projectId: doomed.id }))
  await sleep(1600)
  check('reopening puts the tab back', st.projects.some((p) => p.id === doomed.id))
  check('with its two cards', st.sessions.filter((s) => s.projectId === doomed.id).length === 2)
  check('and the cards hanging off them', st.docs.filter((d) => d.projectId === doomed.id).length === cardsBefore)

  const back = await page.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => t.textContent?.trim()))
  check('and the row shows it again', back.some((t) => t?.includes(doomed.name)), back.join(' | '))
}

await browser.close()
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
