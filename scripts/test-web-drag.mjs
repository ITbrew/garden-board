/**
 * Picking up a roots or history block and putting it somewhere.
 *
 * The owner asked for this for a stated reason: automatic placement can be wrong, and when it is he
 * wants to move the thing rather than wait for the placement to be fixed. Individual file cards
 * could already be dragged, which lets a block be taken apart one card at a time and is not the
 * same as moving it.
 *
 * Driven through a real browser, because the parts that break here are not in the server: whether
 * the frame is reachable by the pointer at all (its body is deliberately transparent to clicks so
 * the cards inside stay usable), and whether the drag reaches the socket rather than panning the
 * canvas. Then the result is read from the stored rows, which is where the truth is.
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
const st = { projects: [], sessions: [], docs: [] }
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.updated') st.docs = st.docs.map((d) => (d.id === m.card.id ? m.card : d))
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(400)

const dir = mkdtempSync(join(tmpdir(), 'garden-drag-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
for (const n of ['alpha', 'beta', 'gamma']) {
  writeFileSync(join(dir, '.claude', 'skills', `${n}.md`), `# ${n}\n`)
}
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1500)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())

ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Coder', start: false }))
await sleep(800)
const coder = st.sessions.find((s) => s.title === 'Coder')
ws.send(JSON.stringify({ t: 'context.open', sessionId: coder.id }))
await sleep(2000)

const rootsOf = () => st.docs.filter((d) => d.ownerId === coder.id && d.web === 'context')
check('the roots web is open', rootsOf().length > 0, `${rootsOf().length} cards`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 2400, height: 1400, deviceScaleFactor: 1 },
  args: ['--window-size=2400,1400', '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
await page.goto(`http://127.0.0.1:${garden.port}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

const head = await page.evaluate(() => {
  const el = document.querySelector('.webframe__head')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
})
check('the block has a handle the pointer can reach', !!head, head ? `${Math.round(head.w)}x${Math.round(head.h)}` : 'no header found')

if (head) {
  const before = rootsOf().map((d) => ({ id: d.id, x: d.x, y: d.y }))
  const shape = (list) => {
    const l = Math.min(...list.map((d) => d.x))
    const t = Math.min(...list.map((d) => d.y))
    return list.map((d) => `${d.id}:${Math.round(d.x - l)},${Math.round(d.y - t)}`).sort().join('|')
  }

  // A real drag: press on the title bar, move in steps so the canvas sees a drag, release.
  await page.mouse.move(head.x, head.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(head.x + i * 40, head.y + i * 15)
  await page.mouse.up()
  await sleep(1600)

  const after = rootsOf().map((d) => ({ id: d.id, x: d.x, y: d.y }))
  const moved = after.every((a) => {
    const b = before.find((x) => x.id === a.id)
    return b && (Math.abs(a.x - b.x) > 20 || Math.abs(a.y - b.y) > 20)
  })
  check('dragging the block moves every card in it', moved,
    `first card ${Math.round(before[0].x)},${Math.round(before[0].y)} to ${Math.round(after.find((a) => a.id === before[0].id).x)},${Math.round(after.find((a) => a.id === before[0].id).y)}`)
  check('and the block keeps its shape', shape(before) === shape(after))

  const dx = after.find((a) => a.id === before[0].id).x - before[0].x
  const dy = after.find((a) => a.id === before[0].id).y - before[0].y
  check('every card travelled the same distance', after.every((a) => {
    const b = before.find((x) => x.id === a.id)
    return Math.abs(a.x - b.x - dx) < 1.5 && Math.abs(a.y - b.y - dy) < 1.5
  }), `${Math.round(dx)},${Math.round(dy)}`)

  // And it stays put: a manual move that gets silently undone is worse than not having it.
  await sleep(1200)
  const settled = rootsOf().find((d) => d.id === before[0].id)
  check('and the block stays where it was put', Math.abs(settled.x - (before[0].x + dx)) < 1.5,
    `${Math.round(settled.x)} against ${Math.round(before[0].x + dx)}`)

  // One card on its own still drags, which is the other half of what he asked for.
  const one = rootsOf()[0]
  const box = await page.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + 12 }
  }, one.id)
  if (box) {
    await page.mouse.move(box.x, box.y)
    await page.mouse.down()
    for (let i = 1; i <= 6; i++) await page.mouse.move(box.x, box.y + i * 30)
    await page.mouse.up()
    await sleep(1400)
    const now = rootsOf().find((d) => d.id === one.id)
    check('a single file card still drags on its own', Math.abs(now.y - one.y) > 20,
      `${Math.round(one.y)} to ${Math.round(now.y)}`)
  } else {
    check('a single file card still drags on its own', false, 'card not found on the page')
  }
}

mkdirSync('docs/shots', { recursive: true })
await page.screenshot({ path: 'docs/shots/web-dragged.png' })
await browser.close()
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
