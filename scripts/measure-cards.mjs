/**
 * What the board actually draws, measured against what it stored.
 *
 * The owner reports cards sitting on top of each other. Every stored rectangle says they do not,
 * and both of those can be true at once: a card is positioned from its stored x, y, width and
 * height, and then drawn at whatever height its contents come out to. If the drawn box is taller
 * than the stored one, the collision pass has been solving the wrong rectangle all along, and it
 * will keep passing while he keeps seeing the overlap.
 *
 * So this reads both. Stored geometry over the socket, drawn geometry out of the DOM, both for the
 * same cards at the same moment, and it reports the difference and every pair that touches on
 * screen. Reading coordinates is not grading pixels: no judgement about how it looks is made here,
 * and none should be.
 *
 * Runs against its own server and its own scratch board, so nothing it opens or moves is his.
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PAD = 26
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  // Without this, every card a closed web deleted stayed in the tally and was counted as a
  // rectangle still on the board, which reported eighteen collisions between things that were no
  // longer there.
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(400)

const dir = mkdtempSync(join(tmpdir(), 'garden-measure-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n\nInstructions this session runs from.\n')
mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
for (const n of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
  writeFileSync(join(dir, '.claude', 'skills', `${n}.md`), `# ${n}\n\nA file this session runs from.\n`)
}
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1500)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())

const make = async (title, reportsTo) => {
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, reportsTo, start: false }))
  await sleep(700)
  return st.sessions.find((s) => s.title === title)
}
const lead = await make('Lead', null)
const coder = await make('Coder', lead.id)
await make('Writer', lead.id)

/*
 * Open, fold away, open again before measuring.
 *
 * The owner reports the overlap coming back on the second open, so the state worth measuring is
 * the one after a round trip, not the one straight after the first open.
 */
const cycles = Number(process.env.CYCLES ?? 2)
for (let i = 0; i < cycles; i++) {
  ws.send(JSON.stringify({ t: 'context.open', sessionId: coder.id }))
  ws.send(JSON.stringify({ t: 'history.open', sessionId: coder.id }))
  await sleep(2200)
  if (i === cycles - 1) break
  ws.send(JSON.stringify({ t: 'context.close', sessionId: coder.id }))
  ws.send(JSON.stringify({ t: 'history.close', sessionId: coder.id }))
  await sleep(1400)
}
/*
 * Then grow the card, which is the case the owner reported: roots opened against one bottom edge
 * and a card that is a different size by the time he looks at it.
 */
ws.send(JSON.stringify({ t: 'session.setBox', sessionId: coder.id, width: 760, height: 600 }))
await sleep(1600)
console.log(`measured after ${cycles} open/close round trip(s), with the card then grown to 760x600`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 3840, height: 1600, deviceScaleFactor: 1 },
  args: ['--window-size=3840,1600', '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('   page error:', String(e).slice(0, 200)))
await page.goto(`http://127.0.0.1:${garden.port}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

/*
 * Drawn geometry, taken in flow coordinates rather than screen pixels.
 *
 * React Flow scales and pans the whole canvas, so a screen rectangle says as much about where the
 * viewport happens to be as about the card. Dividing back out by the transform's scale gives the
 * same units the stored rows are in, which is what makes the two comparable at all.
 */
const drawn = await page.evaluate(() => {
  const viewport = document.querySelector('.react-flow__viewport')
  if (!viewport) return { error: 'no canvas on the page' }
  const t = new DOMMatrixReadOnly(getComputedStyle(viewport).transform)
  const scale = t.a || 1
  const out = []
  for (const el of document.querySelectorAll('.react-flow__node')) {
    const r = el.getBoundingClientRect()
    out.push({
      id: el.getAttribute('data-id'),
      // Back into the same coordinates the stored rows use, so the two can be compared directly.
      x: (r.left - t.e) / scale,
      y: (r.top - t.f) / scale,
      // What kind of thing React Flow thinks this is, and what it says, so a node that maps to no
      // stored card can still be named in the output rather than counted and forgotten.
      type: [...el.classList].find((c) => c.startsWith('react-flow__node-')) ?? '?',
      text: (el.textContent ?? '').trim().slice(0, 40),
      w: r.width / scale,
      h: r.height / scale,
    })
  }
  /*
   * How far the two web arrows hang past the card's own border.
   *
   * They are the controls for opening each web, so the clear space around a card has to be measured
   * from the arrow rather than from the border, or the owner is asked to click something with
   * thirteen pixels of room around it.
   */
  let arrowReach = 0
  let reachWho = ''
  for (const card of document.querySelectorAll('.react-flow__node')) {
    const c = card.getBoundingClientRect()
    for (const el of card.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const over = Math.max((c.top - r.top) / scale, (r.bottom - c.bottom) / scale)
      if (over > arrowReach) {
        arrowReach = over
        reachWho = el.className?.toString?.().slice(0, 40) ?? '?'
      }
    }
  }
  return { scale, nodes: out, arrowReach, reachWho }
})

if (drawn.error) {
  console.log(drawn.error)
} else {
  const stored = new Map()
  for (const s of st.sessions.filter((x) => x.projectId === project.id)) {
    stored.set(s.id, { name: s.title, kind: 'session', x: s.x, y: s.y, w: s.width, h: s.collapsed ? 38 : s.height })
  }
  for (const d of st.docs.filter((x) => x.projectId === project.id)) {
    const kind = d.web === 'history' ? 'history' : d.web === 'context' ? 'roots' : 'doc'
    stored.set(d.id, { name: d.title, kind, x: d.x, y: d.y, w: d.width, h: d.collapsed ? 38 : d.height })
  }

  console.log(`\ncanvas scale ${drawn.scale.toFixed(3)}, ${drawn.nodes.length} nodes drawn, ${stored.size} cards stored`)
  console.log(`the furthest anything reaches past a card border: ${drawn.arrowReach.toFixed(1)}px (${drawn.reachWho})\n`)
  console.log('stored vs drawn, where they differ by more than 2px:')
  const real = new Map()
  let differing = 0
  for (const node of drawn.nodes) {
    const s = stored.get(node.id)
    if (!s) continue
    real.set(node.id, { ...s, w: node.w, h: node.h })
    const dw = node.w - s.w
    const dh = node.h - s.h
    if (Math.abs(dw) > 2 || Math.abs(dh) > 2) {
      differing++
      console.log(
        `  [${s.kind}] ${s.name}: stored ${Math.round(s.w)}x${Math.round(s.h)}, ` +
          `drawn ${Math.round(node.w)}x${Math.round(node.h)}  (${dw >= 0 ? '+' : ''}${Math.round(dw)}, ${dh >= 0 ? '+' : ''}${Math.round(dh)})`,
      )
    }
  }
  if (differing === 0) console.log('  none: every card is drawn at the size it was stored at')

  console.log('\nevery drawn node, in board coordinates:')
  for (const node of drawn.nodes.sort((a, b) => a.y - b.y)) {
    const s = stored.get(node.id)
    const who = s ? `[${s.kind}] ${s.name}` : `[NOT A CARD] ${node.type} "${node.text}"`
    console.log(
      `  y ${String(Math.round(node.y)).padStart(6)} to ${String(Math.round(node.y + node.h)).padStart(6)}` +
        `   x ${String(Math.round(node.x)).padStart(6)} to ${String(Math.round(node.x + node.w)).padStart(6)}   ${who}`,
    )
  }

  /*
   * The question the owner is actually asking: does anything drawn touch anything else drawn. Every
   * node, not only the ones that came from a stored row, because a frame or a column header covering
   * a card is exactly as much of an overlap to look at as two cards covering each other.
   */
  const named = drawn.nodes.map((n) => {
    const s = stored.get(n.id)
    return { ...n, label: s ? `[${s.kind}] ${s.name}` : `[${n.type.replace('react-flow__node-', '')}] ${n.text}` }
  })
  /*
   * A frame around its own cards is not a collision, it is a frame, and neither is a column label
   * sitting over the column it names. Only things that are supposed to stand apart count.
   */
  const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h
  const furniture = (n) => n.type.includes('webFrame') || n.type.includes('columnHeader')

  const clashes = []
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const a = named[i]
      const b = named[j]
      if (contains(a, b) || contains(b, a)) continue
      if (furniture(a) && furniture(b)) continue
      if ((furniture(a) || furniture(b)) && Math.abs(a.y - b.y) < 60 && Math.abs(a.x - b.x) < 60) continue
      const gap = Math.max(
        Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)),
        Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)),
      )
      if (gap < PAD) clashes.push({ gap: Math.round(gap), line: `${a.label}  <->  ${b.label}` })
    }
  }
  console.log(`\nby everything actually drawn: ${clashes.length} pair(s) closer than ${PAD}px`)
  for (const c of clashes.sort((a, b) => a.gap - b.gap).slice(0, 25)) {
    console.log(`  ${c.gap < 0 ? `overlapping ${-c.gap}px` : `${c.gap}px apart`}: ${c.line}`)
  }

  const pairs = (boxes, label) => {
    const list = [...boxes.values()]
    const bad = []
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        const gap = Math.max(
          Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)),
          Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)),
        )
        if (gap < PAD) bad.push(`  ${Math.round(gap)}px: [${a.kind}] ${a.name} <-> [${b.kind}] ${b.name}`)
      }
    }
    console.log(`\n${label}: ${bad.length} pair(s) closer than ${PAD}px`)
    for (const line of bad.slice(0, 20)) console.log(line)
  }
  pairs(stored, 'by stored size')
  pairs(real, 'by drawn size')
}

mkdirSync(join(process.cwd(), 'docs', 'shots'), { recursive: true })
await page.screenshot({ path: join(process.cwd(), 'docs', 'shots', 'webs-open.png') })
// Framed on the card that owns the open web, since the question is about the space between them.
await page.evaluate(() => {
  const el = [...document.querySelectorAll('.react-flow__node')].find((n) => n.textContent?.includes('Coder'))
  el?.scrollIntoView({ block: 'center', inline: 'center' })
})
await sleep(600)
/*
 * Framed on the grown card and the block hanging off it. The first attempt clipped a fixed
 * rectangle and a blind reviewer got mostly empty canvas with the subject cut off two sides, so
 * this measures where the card actually is and frames around that.
 */
const frame = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.react-flow__node')].find((n) => n.textContent?.includes('Coder'))
  const web = document.querySelector('.react-flow__node-webFrame')
  if (!card) return null
  const a = card.getBoundingClientRect()
  const b = web?.getBoundingClientRect() ?? a
  return {
    x: Math.max(0, Math.min(a.left, b.left) - 60),
    y: Math.max(0, Math.min(a.top, b.top) - 60),
    width: Math.min(2600, Math.max(a.right, b.right) - Math.min(a.left, b.left) + 120),
    height: Math.min(1500, Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) + 120),
  }
})
await page.screenshot({
  path: join(process.cwd(), 'docs', 'shots', 'card-and-its-roots.png'),
  ...(frame ? { clip: frame } : {}),
})
console.log('\nshots: docs/shots/webs-open.png, docs/shots/card-and-its-roots.png')

await browser.close()
ws.close()
await garden.stop()
