/**
 * The goal ring on a real board: minimized first, opened with a click, each step expandable, one per
 * tab, and following the file as it changes. Canon 26, "The goal ring".
 *
 * Its own Garden, its own workspace, serving the BUILT app, so run `npm run build` first.
 * Pass a folder as the first argument to keep screenshots there.
 */
import puppeteer from 'puppeteer-core'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const shots = process.argv[2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const LIST = [
  '# TO DO',
  '',
  '## Now: Stable board',
  '',
  'Garden keeps responding while many cards work at once.',
  '',
  '- [x] Main thread @Orchestrator',
  '  - Why: Slow work leaves the server thread.',
  '  - End: The board keeps answering during a disk stall.',
  '- [x] Database @Orchestrator',
  '  - End: The database is under 200 MB.',
  '- [x] Launcher',
  '- [ ] Codex status',
  '  - Why: Codex cards should read as working while they work.',
  '- [ ] Heavy load @Orchestrator',
  '  - Start: Watch the freeze record through the next heavy build.',
  '  - End: No freeze over 5 s across 30 busy minutes.',
  '  - [x] Freeze record',
  '    - Why: Garden logs every freeze.',
  '    - End: Every freeze is logged with its length.',
  '  - [ ] Busy build #doing',
  '  - [ ] 30 clean minutes',
  '- [ ] Full tests',
  '',
].join('\n')

const board = await openBoard({
  projectName: 'goalring',
  cards: [{ title: 'Orchestrator', roleClass: 'orchestrator' }],
})
const todoPath = join(board.dir, 'TODO.md')

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', defaultViewport: { width: 1900, height: 1100 } })
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
const shot = async (name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

check('a tab with no list still shows a ring', !!(await page.$('.goal-ring__blip')))
check('and it says there is no goal yet', (await page.$eval('.goal-ring__blip-count', (n) => n.textContent)) === '+')
await shot('1-empty')
await page.evaluate(() => document.querySelector('.goal-ring__blip').click())
await sleep(300)
check('opening an empty ring wrote nothing', !existsSync(todoPath))
check('it offers to create the list', (await page.$eval('.goal-ring__panel--empty', (n) => n.textContent)).includes('Create TODO.md'))
await page.evaluate(() => document.querySelector('.goal-ring__create').click())
await sleep(1500)
check('one click creates the list', existsSync(todoPath) && readFileSync(todoPath, 'utf8').startsWith('# TO DO'))
check('with no card added to the board', (await page.$$('.node--doc')).length === 0)

// A card writes the goals with its own tools, and the ring follows with nobody opening anything.
writeFileSync(todoPath, LIST)
await sleep(5000)

const view = () => page.evaluate(() => {
  const open = document.querySelector('.goal-ring__open').getBoundingClientRect()
  const opened = [...document.querySelectorAll('.goal-ring__note:not(.goal-ring__note--hint)')]
  const note = opened.at(-1)
  const hint = document.querySelector('.goal-ring__note--hint')
  const box = note?.getBoundingClientRect()
  return {
    names: [...document.querySelectorAll('.goal-ring__name')].map((n) => n.textContent),
    nameBoxes: [...document.querySelectorAll('.goal-ring__name')].map((n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, h: r.height } }),
    leads: document.querySelectorAll('.goal-ring__lead').length,
    bars: document.querySelectorAll('.goal-ring__disc .goal-ring__bar:not(.goal-ring__fill)').length,
    frames: document.querySelectorAll('.goal-ring__disc .goal-ring__frame').length,
    count: document.querySelector('.goal-ring__count')?.textContent,
    section: note?.querySelector('h3')?.textContent ?? null,
    notes: opened.map((n) => n.querySelector('h3').textContent),
    sectionText: note?.textContent ?? '',
    noteBox: box ? { x: box.left, y: box.top, w: box.width, h: box.height } : null,
    hint: hint?.textContent ?? null,
    w: open.width, h: open.height, x: open.left, y: open.top,
  }
})
const STEPS = 6
const barMiddle = (index) => page.evaluate((index) => {
  // The middle of the arc itself: the middle of its bounding box is off the bar.
  const bar = document.querySelectorAll('.goal-ring__disc g.goal-ring__seg')[index].querySelector('.goal-ring__bar')
  const p = bar.getPointAtLength(bar.getTotalLength() / 2).matrixTransform(bar.getScreenCTM())
  return { x: p.x, y: p.y }
}, index)
const segCount = () => page.$$eval('.goal-ring__disc g.goal-ring__seg', (g) => g.length)
// The inner arcs are drawn first, ahead of the six outer ones.
const outerBarPoint = async (i) => barMiddle((await segCount()) - STEPS + i)
const innerBarPoint = (i) => barMiddle(i)
const middle = () => page.$eval('.goal-ring__center', (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
const press = async (p) => { await page.mouse.click(p.x, p.y); await sleep(250) }
const rest = async () => { await page.mouse.move(5, 5); await sleep(150) }
// The frame's edge, between its outline and the arcs: part of the ring, on no button.
const rim = (v) => ({ x: v.x + v.w / 2, y: v.y + v.h * 0.03 })

let v = await view()
check('it is a plain circle: no names written out', v.names.length === 0 && v.leads === 0, v.names.join())
check('no note open', v.section === null)
check('no sheet or card around it', !(await page.$('.goal-ring__panel')))
check('with no border around the rings', v.frames === 1 && (await page.$eval('.goal-ring__disc .goal-ring__frame', (n) => getComputedStyle(n).stroke)) === 'none')
check('both rings are drawn', v.bars === 9, String(v.bars))
check('the middle counts the goals', v.count === '3/6', v.count)
check('it is square, about twice a default card', Math.abs(v.w - 520) < 1 && Math.abs(v.h - 520) < 1, JSON.stringify([v.w, v.h]))
const corner = await page.evaluate((s) => {
  const hit = document.elementFromPoint(s.x + 6, s.y + 6)
  return !!hit?.closest('.goal-ring__disc')
}, v)
check('a press in the corner of its box reaches the board', !corner)
const buttons = await page.$$eval('.goal-ring__disc g.goal-ring__seg', (g) => g.filter((n) => n.getAttribute('role') === 'button' && n.tabIndex === 0).length)
const clock = await page.evaluate(() => {
  const segs = [...document.querySelectorAll('.goal-ring__disc g.goal-ring__seg')]
  const look = (g) => {
    const bar = g.querySelector('.goal-ring__bar:not(.goal-ring__fill)').getAttribute('class')
    const fill = g.querySelector('.goal-ring__fill')
    const start = g.querySelector('.goal-ring__bar').getPointAtLength(0)
    return { state: fill ? 'partly' : /is-done/.test(bar) ? 'done' : /is-doing/.test(bar) ? 'doing' : 'next', fill: fill?.getTotalLength() ?? 0, track: g.querySelector('.goal-ring__bar').getTotalLength(), x: start.x, y: start.y }
  }
  return { inner: segs.slice(0, 3).map(look), outer: segs.slice(3).map(look) }
})
check('the outer ring fills clockwise from 12, done first', clock.outer.map((o) => o.state).join() === 'done,done,done,partly,next,next', clock.outer.map((o) => o.state).join())
check('the inner ring does too', clock.inner.map((o) => o.state).join() === 'done,doing,next', clock.inner.map((o) => o.state).join())
const hand = clock.outer[3].fill / clock.outer[3].track
check('the outer arc has come as far as its sub-goals, like an hour hand', Math.abs(hand - 1 / 3) < 0.03, String(hand))
check('every arc is a button the keyboard can reach', buttons === 9, String(buttons))
await shot('2-plain')

// Hover gives the short version.
const heavy = await outerBarPoint(3)
await page.mouse.move(heavy.x, heavy.y)
await sleep(200)
v = await view()
check('hovering a goal hints its name, card and progress', /Heavy load/.test(v.hint ?? '') && /Orchestrator/.test(v.hint ?? '') && /1 of 3 sub-goals done/.test(v.hint ?? ''), v.hint ?? 'no hint')
check('and opens no note', v.section === null)
await shot('2-hint')
const subBar = await innerBarPoint(0)
await page.mouse.move(subBar.x, subBar.y)
await sleep(200)
v = await view()
check('hovering a sub-goal hints its exit', /Freeze record/.test(v.hint ?? '') && /Done when: Every freeze is logged/.test(v.hint ?? ''), v.hint ?? 'no hint')
await rest()
check('the hint goes when the pointer leaves', (await view()).hint === null)

// A press gives the whole of that arc, and only that arc.
const before = await view()
await press(heavy)
v = await view()
check('pressing a goal opens its note', v.section === 'Heavy load', v.section)
check('holding only that goal', !/Main thread|Database|Launcher|Codex status|Full tests/.test(v.sectionText), v.sectionText)
check('with its definition, exit and progress', v.sectionText.includes('Watch the freeze record') && v.sectionText.includes('Done when: No freeze over 5 s') && v.sectionText.includes('1 of 3 sub-goals done'), v.sectionText)
check('and no list of its sub-goals', !v.sectionText.includes('Busy build'), v.sectionText)
check('the circle does not change', v.w === before.w && v.h === before.h && v.x === before.x, JSON.stringify([v.w, v.h]))
check('the note is big but bounded', v.noteBox.w <= 301 && v.noteBox.h <= 301, JSON.stringify(v.noteBox))
const heavySide = heavy.x < v.x + v.w / 2 ? 'left' : 'right'
check('on its own side of the ring', heavySide === 'left' ? v.noteBox.x + v.noteBox.w <= v.x : v.noteBox.x >= v.x + v.w, JSON.stringify([heavySide, v.noteBox, v.x, v.w]))
check('and stands outside the circle', v.noteBox.x + v.noteBox.w <= v.x + v.w * 0.2 || v.noteBox.x >= v.x + v.w * 0.8, JSON.stringify([v.noteBox, v.x, v.w]))
const beside = await page.evaluate((s) => {
  const hit = document.elementFromPoint(s.x + s.w + 300, s.y + 100)
  return { ring: !!hit?.closest('.goal-ring__open'), cls: String(hit?.className?.baseVal ?? hit?.className ?? '') }
}, v)
check('and the board beside it still takes a click', !beside.ring && beside.cls.includes('react-flow'), beside.cls)
await shot('3-note')

await press(await innerBarPoint(0))
v = await view()
check('pressing a sub-goal moves the note to it', v.section === 'Freeze record', v.section)
check('and its goal stays open with it', v.notes.join() === 'Heavy load,Freeze record', v.notes.join())
const noteBoxes = await page.$$eval('.goal-ring__note', (n) => n.map((x) => { const r = x.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }))
check('the two notes do not cover each other', !(noteBoxes[0].x < noteBoxes[1].x + noteBoxes[1].w && noteBoxes[1].x < noteBoxes[0].x + noteBoxes[0].w && noteBoxes[0].y < noteBoxes[1].y + noteBoxes[1].h && noteBoxes[1].y < noteBoxes[0].y + noteBoxes[0].h), JSON.stringify(noteBoxes))
check('with its definition and exit', v.sectionText.includes('Garden logs every freeze') && v.sectionText.includes('Done when: Every freeze is logged'), v.sectionText)
await press(await innerBarPoint(1))
check('a sub-goal with no exit says so', (await view()).sectionText.includes('No exit written yet'))
await press(await innerBarPoint(1))
check('pressing the same sub-goal closes it and leaves its goal open', (await view()).notes.join() === 'Heavy load', (await view()).notes.join())
await press(await innerBarPoint(1))
check('(both notes open again)', (await view()).notes.length === 2, (await view()).notes.join())
await press(heavy)
check('pressing the goal then closes both', (await view()).notes.length === 0, (await view()).notes.join())

await press(await outerBarPoint(4))
v = await view()
check('pressing another goal opens its note', v.section === 'Codex status', v.section)
check('and only its own', v.sectionText.includes('should read as working') && !v.sectionText.includes('Watch the freeze'), v.sectionText)
await press(await outerBarPoint(4))
check('pressing the same goal closes it', (await view()).section === null)

// The middle shows every button at once. Codex status has no parts, so choose one that does.
await press(await outerBarPoint(3))
await press(await outerBarPoint(3))
await rest()
await press(await middle())
await rest()
v = await view()
check('the middle shows every goal and sub-goal by name', ['Main thread', 'Database', 'Launcher', 'Codex status', 'Heavy load', 'Full tests', 'Freeze record', 'Busy build', '30 clean minutes'].every((x) => v.names.includes(x)) && v.names.length === 9, v.names.join())
check('each on a fine line to its arc', v.leads === 9, String(v.leads))
check('and no details yet', v.section === null)
const overlaps = v.nameBoxes.some((a, i) => v.nameBoxes.some((b, j) => i < j && Math.abs(a.x - b.x) < 5 && Math.abs(a.y - b.y) < a.h))
check('no name sits on another', !overlaps, JSON.stringify(v.nameBoxes))
const crossing = await page.$$eval('.goal-ring__lead', (lines, c) => lines.filter((l) => {
  const [a, b] = l.getAttribute('points').split(' ').map((p) => p.split(',').map(Number))
  return (a[0] - c) * (b[0] - c) < 0 && Math.abs(a[0] - c) > 1
}).length, v.w / 2)
check('no line crosses the circle', crossing === 0, String(crossing))
check('all outside the circle', v.nameBoxes.every((b) => b.x >= v.x + v.w || b.x + 190 <= v.x + 1), JSON.stringify(v.nameBoxes))
await shot('4-all')
const namePoint = (label) => page.evaluate((label) => {
  const n = [...document.querySelectorAll('.goal-ring__name')].find((x) => x.textContent === label)
  const r = n.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}, label)
await press(await namePoint('Busy build'))
v = await view()
check('a name presses the same button as its arc', v.section === 'Busy build', v.section)
check('the names stay out while a note is open', v.names.length === 9, String(v.names.length))
check('and the note does not cover them', !v.nameBoxes.some((b) => b.x < v.noteBox.x + v.noteBox.w && b.x + 190 > v.noteBox.x && b.y < v.noteBox.y + v.noteBox.h && b.y + b.h > v.noteBox.y), JSON.stringify(v.noteBox))
await shot('5-all-note')
await press(await middle())
await rest()
v = await view()
check('the middle puts them all away, with the note', v.names.length === 0 && v.section === null, v.names.join())
await press(await middle())
await page.keyboard.press('Escape')
await sleep(200)
v = await view()
check('Escape does too', v.names.length === 0 && v.section === null)
await page.evaluate(() => [...document.querySelectorAll('.goal-ring__disc g.goal-ring__seg')].at(-1).focus())
await page.keyboard.press('Enter')
await sleep(200)
check('Enter presses an arc from the keyboard', (await view()).section !== null, (await view()).section)
await page.keyboard.press('Escape')
await sleep(200)
await page.evaluate(() => document.activeElement?.blur())
await rest()

// The orchestrator's half: the file changes and the ring follows without a click.
writeFileSync(todoPath, LIST.replace('- [ ] Codex status', '- [x] Codex status'))
await sleep(5000)
check('the ring follows the file', (await view()).count === '4/6', (await view()).count)

// Moving it.
const at = await view()
const dragBy = async (p, dx, dy) => {
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 6 })
  await page.mouse.up()
  await sleep(200)
}
await dragBy(rim(at), 200, 100)
const moved = await view()
check('dragging it moves it', Math.abs(moved.x - at.x - 200) < 2 && Math.abs(moved.y - at.y - 100) < 2, JSON.stringify([moved.x, moved.y]))
check('a drag opens nothing', moved.section === null)
await dragBy(await outerBarPoint(1), 40, 30)
check('a drag that starts on a bar opens nothing', (await view()).section === null)
await press(await outerBarPoint(1))
await rest()
const openAt = await view()
await dragBy(rim(openAt), 60, 40)
const openMoved = await view()
check('dragging it with a note open moves it too', Math.abs(openMoved.x - openAt.x - 60) < 2 && openMoved.section === 'Database', JSON.stringify([openMoved.x, openMoved.section]))
await press(rim(openMoved))
check('pressing the frame changes nothing', (await view()).section === 'Database')
check('the resize square is gone while a note is open', !(await page.$('.goal-ring__grip')))
await press(await outerBarPoint(1))
await rest()

// The square at 10:00, on hover.
const grip = () => page.$eval('.goal-ring__grip', (n) => {
  const r = n.getBoundingClientRect()
  const o = n.parentElement.getBoundingClientRect()
  return { shown: getComputedStyle(n).display !== 'none', x: r.left + r.width / 2, y: r.top + r.height / 2, side: r.width, ox: o.left, oy: o.top, ow: o.width, oh: o.height }
})
check('the resize square is hidden until hover', (await grip()).shown === false)
await page.mouse.move(rim(await view()).x, rim(await view()).y)
await sleep(200)
const g0 = await grip()
const fromCenter = { x: g0.x - g0.ox - g0.ow / 2, y: g0.y - g0.oy - g0.oh / 2 }
const clockAngle = (Math.atan2(fromCenter.x, -fromCenter.y) * 180) / Math.PI
check('on hover it shows at 10:00', g0.shown && Math.abs(clockAngle + 60) < 2, JSON.stringify({ clockAngle, g0 }))
const gripFromCenter = Math.hypot(fromCenter.x, fromCenter.y)
const ringEdge = g0.ow * (128 + 3.5) / 300
check('just outside the ring', gripFromCenter - g0.side * 0.71 > ringEdge && gripFromCenter < ringEdge + 40, JSON.stringify([gripFromCenter, ringEdge]))
if (shots) await page.screenshot({ path: join(shots, '8-grip.png'), clip: { x: Math.max(0, g0.x - 60), y: Math.max(0, g0.y - 60), width: 240, height: 200 } })
check('at a size that can be grabbed', Math.abs(g0.side - 16) < 1, String(g0.side))
await page.mouse.move(g0.x, g0.y)
await page.mouse.down()
await page.mouse.move(g0.x + 60, g0.y + 40, { steps: 6 })
await page.mouse.up()
await sleep(200)
const g1 = await grip()
check('dragging it inward shrinks the circle', g1.ow < g0.ow - 40, JSON.stringify([g0.ow, g1.ow]))
check('and it stays round', Math.abs(g1.ow - g1.oh) < 1, JSON.stringify([g1.ow, g1.oh]))
check('with the far corner held still', Math.abs(g1.ox + g1.ow - g0.ox - g0.ow) < 2 && Math.abs(g1.oy + g1.oh - g0.oy - g0.oh) < 2)
check('and it opens nothing', (await view()).section === null)
await shot('7-resized')
await rest()

// The count is however many goals there are, with no limit.
const MANY = 40
writeFileSync(todoPath, ['# TO DO', '', '## Now: Many', '', ...Array.from({ length: MANY }, (_, i) => `- [${i < 7 ? 'x' : ' '}] Goal ${i + 1}`), ''].join('\n'))
await sleep(5000)
const many = await page.evaluate(() => ({
  count: document.querySelector('.goal-ring__count')?.textContent,
  lengths: [...document.querySelectorAll('.goal-ring__disc g.goal-ring__seg .goal-ring__bar')].map((b) => b.getTotalLength()),
}))
check('the count has no limit', many.count === `7/${MANY}`, many.count)
check('and every goal still draws an arc with a gap', many.lengths.length >= MANY && many.lengths.slice(-MANY).every((l) => l > 5), String(many.lengths.length))
writeFileSync(todoPath, LIST)
await sleep(5000)

// Pinned on the board: it moves and zooms with the cards, and keeps its place on the board.
const boardView = async () => page.evaluate(() => {
  const ring = document.querySelector('.goal-ring__open').getBoundingClientRect()
  const node = document.querySelector('.react-flow__node').getBoundingClientRect()
  return { x: ring.left, y: ring.top, w: ring.width, nx: node.left, ny: node.top, nw: node.width }
})
const emptyPane = await page.evaluate(() => {
  for (let y = 900; y > 100; y -= 60) {
    for (let x = 1800; x > 100; x -= 60) {
      if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
    }
  }
  return null
})
const v0 = await boardView()
await page.mouse.move(emptyPane.x, emptyPane.y)
await page.mouse.down()
await page.mouse.move(emptyPane.x - 90, emptyPane.y - 60, { steps: 5 })
await page.mouse.up()
await sleep(300)
const v1 = await boardView()
check('panning the board carries it along', Math.abs(v1.x - v0.x - (v1.nx - v0.nx)) < 1 && Math.abs(v1.nx - v0.nx) > 50, JSON.stringify([v0, v1]))
await page.mouse.move(emptyPane.x - 90, emptyPane.y - 60)
await page.mouse.wheel({ deltaY: 400 })
await sleep(600)
const v2 = await boardView()
const cardScale = v2.nw / v1.nw
check('zooming the board scales it with the cards', cardScale < 0.95 && Math.abs(v2.w / v1.w - cardScale) < 0.02, JSON.stringify([cardScale, v2.w / v1.w]))
const nameSize = () => page.evaluate(() => {
  const n = document.querySelector('.goal-ring__name').getBoundingClientRect()
  const o = document.querySelector('.goal-ring__open').getBoundingClientRect()
  return { name: n.width, ring: o.width }
})
const middleAt = await page.$eval('.goal-ring__center', (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
await page.mouse.click(middleAt.x, middleAt.y)
await sleep(250)
const zoomedOut = await nameSize()
check('zoomed out, the names still read at their normal size on screen', zoomedOut.name > 185, JSON.stringify(zoomedOut))
await page.mouse.click(middleAt.x, middleAt.y)
await sleep(250)
await page.reload({ waitUntil: 'networkidle2' })
await sleep(3000)
const v3 = await boardView()
const gap = (v) => [(v.x - v.nx) / v.nw, (v.y - v.ny) / v.nw]
check('after a reload it is at the same place on the board',
  Math.abs(gap(v3)[0] - gap(v2)[0]) < 0.02 && Math.abs(gap(v3)[1] - gap(v2)[1]) < 0.02, JSON.stringify([gap(v2), gap(v3)]))
const overCard = await page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.startsWith('garden.goalRing.board.'))
  const node = document.querySelector('.react-flow__node').getBoundingClientRect()
  const ring = document.querySelector('.goal-ring__disc').getBoundingClientRect()
  const zoom = node.width / document.querySelector('.react-flow__node').offsetWidth
  const saved = JSON.parse(localStorage.getItem(key))
  saved.x += (node.left + 40 - ring.left) / zoom
  saved.y += (node.top + 40 - ring.top) / zoom
  localStorage.setItem(key, JSON.stringify(saved))
  return !!key
})
await page.reload({ waitUntil: 'networkidle2' })
await sleep(3000)
const onTop = await page.evaluate(() => {
  const r = document.querySelector('.goal-ring__disc').getBoundingClientRect()
  return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height * 0.03)?.closest('.goal-ring__disc')
})
check('over a card, it still takes the click', overCard && onTop)
await page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.startsWith('garden.goalRing.board.'))
  const saved = JSON.parse(localStorage.getItem(key))
  saved.size = 2000
  localStorage.setItem(key, JSON.stringify(saved))
})
await page.reload({ waitUntil: 'networkidle2' })
await sleep(3000)
await page.evaluate(() => document.querySelector('.goal-ring__center').click())
await sleep(250)
const bigRing = await page.evaluate(() => {
  const n = document.querySelector('.goal-ring__name').getBoundingClientRect()
  const o = document.querySelector('.goal-ring__open').getBoundingClientRect()
  return { name: n.width, ring: o.width }
})
check('a larger ring has larger names, in proportion', Math.abs(bigRing.name / bigRing.ring - 220 / 520) < 0.01, JSON.stringify(bigRing))

check('no page errors', pageErrors.length === 0, pageErrors[0] ?? '')
await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
