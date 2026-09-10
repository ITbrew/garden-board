/**
 * The context web opens everything in labelled columns, with a floating header above each.
 *
 * The header is derived from where the cards actually are, so this checks it sits above its
 * column and counts it correctly, rather than checking that some text exists somewhere.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const title = `HdrTest ${Date.now().toString().slice(-5)}`
const board = await openBoard({ cards: [title], projectName: 'colheads' })
const UI = board.UI
const st = board.state
const session = board.cards[0]
check('created a session', !!session, title)

// openBoard's own listener never subtracts a doc, only ever adds one, since none of its other
// callers fold a web away again. This test does, so a second listener on the same socket keeps
// `st.docs` honest after a `context.close`.
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
})

board.ws.send(JSON.stringify({ t: 'context.open', sessionId: session.id }))
await sleep(2600)
const web = st.docs.filter((d) => d.ownerId === session.id)
check('the dot opened everything', web.length >= 3, `${web.length} files`)

const groups = new Map()
for (const d of web) groups.set(d.group, (groups.get(d.group) ?? 0) + 1)
check('every card knows its column', [...groups.keys()].every(Boolean), [...groups.keys()].join(', '))

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 3200, height: 1600 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${UI}/`, { waitUntil: 'networkidle2' })
await sleep(3200)

const nodeCount = await page.$$eval('.react-flow__node', (n) => n.length)
console.log('   react-flow nodes rendered:', nodeCount, '| doc cards expected:', web.length)

const heads = await page.evaluate(() =>
  [...document.querySelectorAll('.colhead')].map((h) => {
    const r = h.getBoundingClientRect()
    return {
      label: h.querySelector('.colhead-label')?.textContent ?? '',
      count: Number(h.querySelector('.colhead-count')?.textContent ?? '0'),
      x: Math.round(r.x),
      y: Math.round(r.y),
    }
  }),
)
console.log('   headers:', heads.map((h) => `${h.label}(${h.count})`).join('  '))
const mine = heads
check('one header per column', mine.length === groups.size, `${mine.length} headers for ${groups.size} columns`)

const byLabel = new Map(mine.map((h) => [h.label, h.count]))
/*
 * Mirrors Canvas.tsx's own GROUP_LABEL. A scratch project has no research, agents or guards, but
 * its owner always has a real ~/.claude/skills directory, so a fresh web reliably includes a
 * skills column, and "skills" without a mapping here used to read as an unlabelled column even
 * though the app was labelling it "Skills" correctly the whole time.
 */
const expected = {
  instructions: 'Instructions',
  memory: 'Its own notes',
  research: 'Research',
  settings: 'Settings',
  skills: 'Skills',
  agents: 'Agent definitions',
  hooks: 'Its own hooks',
  guards: 'Hooks and guards',
}
const labelled = [...groups.keys()].every((g) => byLabel.has(expected[g] ?? g))
check('every column of this web is labelled', labelled, [...byLabel.keys()].join(', '))
check('the counts match the cards', [...groups.entries()].every(([g, n]) => byLabel.get(expected[g] ?? g) === n),
  [...groups.entries()].map(([g, n]) => `${g}=${n}`).join(' '))

// Each header must sit above the topmost card of its own column.
const cardTops = await page.evaluate(() =>
  [...document.querySelectorAll('.react-flow__node')]
    .filter((n) => n.querySelector('.node--doc'))
    .map((n) => {
      const r = n.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y) }
    }),
)
const above = mine.every((h) => {
  const column = cardTops.filter((c) => Math.abs(c.x - h.x) < 60)
  return column.length === 0 || h.y < Math.min(...column.map((c) => c.y))
})
check('each header sits above its column', above)

await browser.close()
board.ws.send(JSON.stringify({ t: 'context.close', sessionId: session.id }))
await sleep(900)
check('folding away clears the web', st.docs.filter((d) => d.ownerId === session.id).length === 0)

await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
