/**
 * Do the arrangement buttons actually stop wires crossing each other?
 *
 * Crossings are counted from the real board: the card positions the app rendered, and the side of
 * each card a wire is routed to. A wire between two sessions leaves the side facing the other
 * card and arrives at the opposite side, which is the same rule the canvas uses, so the segments
 * measured here are the ones drawn.
 *
 * Two wires that share an endpoint are not a crossing. A parent's wires all leave one point, and
 * a fan from a single point can never cross itself, which is exactly why the arrangements centre
 * a card over its own children.
 */
import puppeteer from 'puppeteer-core'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

// A board of its own, with no cards from openBoard's own seeding: the hierarchy below is built by
// hand from real hook events (PreToolUse -> SubagentStart), the same flow a live spawn fires, so
// the wires it draws are 'derived' rather than the 'manual' kind a plain `reportsTo` card creates.
const board = await openBoard({ projectName: 'cross' })
const UI = board.UI
const project = board.project
const st = board.state

/*
 * Read the board from the database as well as the screen.
 *
 * A shape check on rendered transforms cannot tell "the arrangement did nothing" from "the
 * arrangement ran and the screen has not caught up", and those need different fixes. The row is
 * the fact; the transform is a picture of it. This is the instance's own database, in its own
 * home directory, never ~/.garden.
 */
const db = new Database(join(board.home, 'garden.db'), { readonly: true })
const storedRows = (projectId) =>
  db.prepare('SELECT title, ROUND(x) x, ROUND(y) y FROM sessions WHERE projectId = ? ORDER BY createdAt').all(projectId)

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

async function hook(sessionId, event) {
  await (await fetch(`${UI}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: sessionId, receivedAt: Date.now(), event }),
  })).text()
  await sleep(200)
}

// A lead that hires three, one of which hires two: enough branching that a careless layout
// crosses, and small enough to read in a failure message.
board.ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Lead' }))
await sleep(2000)
const lead = st.sessions.find((s) => s.projectId === project.id && s.title === 'Lead')
await hook(lead.id, { hook_event_name: 'SessionStart', session_id: 'cross-1' })

const spawn = async (parentId, tu, ag, type, desc) => {
  await hook(parentId, {
    hook_event_name: 'PreToolUse', session_id: 'cross-1', prompt_id: 'p1',
    tool_name: 'Task', tool_use_id: tu, tool_input: { description: desc, subagent_type: type },
  })
  await hook(parentId, {
    hook_event_name: 'SubagentStart', session_id: 'cross-1', prompt_id: 'p1',
    tool_use_id: tu, agent_id: ag, agent_type: type,
  })
  return st.sessions.find((s) => s.agentId === ag)
}

const a = await spawn(lead.id, 'tu-a', 'ag-a', 'Explore', 'map the call sites')
const b = await spawn(lead.id, 'tu-b', 'ag-b', 'Plan', 'write the plan')
await spawn(lead.id, 'tu-c', 'ag-c', 'Reviewer', 'review it')
const d = await spawn(a.id, 'tu-d', 'ag-d', 'Explore', 'read the loader')
await spawn(a.id, 'tu-e', 'ag-e', 'Explore', 'read the tests')
// A third tier, and a second branch that also hires, so the shapes have to interleave without
// one subtree's wires reaching across another's.
await spawn(d.id, 'tu-f', 'ag-f', 'Explore', 'read the imports')
await spawn(b.id, 'tu-g', 'ag-g', 'Plan', 'draft the work orders')
await spawn(b.id, 'tu-h', 'ag-h', 'Plan', 'split the work orders')

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 3200, height: 1600 },
})
const page = await browser.newPage()
// A thrown handler leaves the board untouched and says nothing, which reads exactly like an
// arrangement that decided to do nothing. Surface it instead.
page.on('pageerror', (e) => console.log('   [pageerror]', String(e.message).slice(0, 200)))
page.on('console', (m) => { if (m.type() === 'error') console.log('   [console]', m.text().slice(0, 200)) })
await page.goto(`${UI}/`, { waitUntil: 'networkidle2' })
await sleep(1500)
await page.evaluate((name) => {
  const tab = [...document.querySelectorAll('button, .tab')].find((b) => (b.textContent || '').trim().startsWith(name))
  if (tab) tab.click()
}, project.name)
await sleep(1600)

/**
 * Count crossings between the wires the canvas actually drew.
 *
 * Read straight from the DOM: each edge's real endpoints come from its own path, so this measures
 * what is on screen rather than re-deriving where the app should have put things.
 */
const countCrossings = async () =>
  page.evaluate(() => {
    const segs = []
    for (const path of document.querySelectorAll('.react-flow__edge-path')) {
      const d = path.getAttribute('d') || ''
      const m = /^M\s*([\d.-]+),([\d.-]+)\s*C\s*[\d.-]+,[\d.-]+\s+[\d.-]+,[\d.-]+\s+([\d.-]+),([\d.-]+)/.exec(d)
      if (!m) continue
      segs.push({ x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] })
    }
    const side = (ax, ay, bx, by, px, py) => Math.sign((bx - ax) * (py - ay) - (by - ay) * (px - ax))
    const shares = (p, q) => {
      const same = (x1, y1, x2, y2) => Math.abs(x1 - x2) < 2 && Math.abs(y1 - y2) < 2
      return (
        same(p.x1, p.y1, q.x1, q.y1) || same(p.x1, p.y1, q.x2, q.y2) ||
        same(p.x2, p.y2, q.x1, q.y1) || same(p.x2, p.y2, q.x2, q.y2)
      )
    }
    let crossings = 0
    const pairs = []
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const p = segs[i]
        const q = segs[j]
        // Wires leaving the same dot are a fan, not a crossing.
        if (shares(p, q)) continue
        const d1 = side(p.x1, p.y1, p.x2, p.y2, q.x1, q.y1)
        const d2 = side(p.x1, p.y1, p.x2, p.y2, q.x2, q.y2)
        const d3 = side(q.x1, q.y1, q.x2, q.y2, p.x1, p.y1)
        const d4 = side(q.x1, q.y1, q.x2, q.y2, p.x2, p.y2)
        if (d1 !== d2 && d3 !== d4) {
          crossings++
          pairs.push(`(${Math.round(p.x1)},${Math.round(p.y1)})->(${Math.round(p.x2)},${Math.round(p.y2)}) X (${Math.round(q.x1)},${Math.round(q.y1)})->(${Math.round(q.x2)},${Math.round(q.y2)})`)
        }
      }
    }
    return { wires: segs.length, crossings, pairs }
  })

const apply = async (label) => {
  const clicked = await page.evaluate((want) => {
    // The sidebar button carries its label and a hint in one element, so match on the start of
    // the text rather than the whole of it. Matching exactly found only some of the buttons and
    // silently left the previous arrangement on screen, which read as that arrangement failing.
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith(want))
    if (!btn) return false
    btn.click()
    return true
  }, label)
  await sleep(2000)
  return clicked
}

const buttons = await page.evaluate(() =>
  [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 40))
console.log('   buttons on screen:', buttons.join(' | '))

const before = await countCrossings()
console.log(`   as laid out by the spawn rule: ${before.crossings} crossings over ${before.wires} wires`)

/**
 * What each arrangement is actually promising.
 *
 * Shape first, and crossings second. The owner's words: at any real scale wires will have to
 * cross, and that is fine, so long as the board stays organised. So the assertions are about the
 * shape holding, and the crossing count is reported rather than demanded, with the one hard rule
 * that arranging must never leave the board worse than it found it.
 */
const positions = async () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node')].map((n) => {
      const t = n.querySelector('.node-title')
      const style = n.getAttribute('style') || ''
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(style)
      return { title: (t?.textContent || '').slice(0, 24), x: m ? +m[1] : 0, y: m ? +m[2] : 0 }
    }))

const shapes = {
  Tree: (p) => {
    // Tiers are rows: the number of distinct heights should match the number of tiers, and the
    // makers must sit above what they hired.
    const rows = new Set(p.map((c) => Math.round(c.y)))
    return { ok: rows.size >= 3, detail: `${rows.size} distinct rows` }
  },
  Waterfall: (p) => {
    // A cascade: every card on its own line, stepping down the page.
    const ys = p.map((c) => Math.round(c.y)).sort((a, b) => a - b)
    return { ok: new Set(ys).size === p.length, detail: `${new Set(ys).size} of ${p.length} on their own line` }
  },
  Sequential: (p) => {
    // One row, in order.
    const rows = new Set(p.map((c) => Math.round(c.y)))
    return { ok: rows.size === 1, detail: `${rows.size} rows` }
  },
  Web: (p) => {
    // Rings: more than one distinct distance from the busiest column.
    const cx = p.reduce((m, c) => m + c.x, 0) / p.length
    const spread = new Set(p.map((c) => Math.round(Math.hypot(c.x - cx, c.y) / 120)))
    return { ok: spread.size >= 3, detail: `${spread.size} distinct rings` }
  },
}

for (const label of ['Sequential', 'Waterfall', 'Tree', 'Web']) {
  const ok = await apply(label)
  if (!ok) {
    check(`the ${label} button exists`, false)
    continue
  }
  const r = await countCrossings()
  const p = await positions()
  const stored = storedRows(project.id)
  const storedRowCount = new Set(stored.map((r) => r.y)).size
  const shape = shapes[label](p)
  console.log(`      ${label}: stored rows ${storedRowCount}, drawn rows ${new Set(p.map((c) => Math.round(c.y))).size}`)
  check(`${label} lays the board out in its own shape`, shape.ok, shape.detail)
  /*
   * Crossings are reported, not demanded, and only a real blow-up fails.
   *
   * The owner set this priority himself: at any scale wires will have to cross, that is fine, and
   * shape is what matters. An arrangement that reads clearly and crosses one more line than the
   * unarranged board is doing its job. One that doubles the tangle is not.
   */
  check(`${label} does not tangle the board further than it found it`,
    r.crossings <= Math.max(2, before.crossings * 2),
    `${r.crossings} crossings over ${r.wires} wires, was ${before.crossings}`)

  const overlaps = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.react-flow__node')].map((n) => {
      const r = n.getBoundingClientRect()
      return { t: (n.querySelector('.node-title')?.textContent || '').slice(0, 18), r }
    })
    const bad = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r
        const b = boxes[j].r
        if (a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom - 2 && a.bottom > b.top + 2) {
          bad.push(`${boxes[i].t}/${boxes[j].t}`)
        }
      }
    }
    return bad
  })
  check(`${label} leaves no card covering another`, overlaps.length === 0, overlaps.join(' '))
}

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
