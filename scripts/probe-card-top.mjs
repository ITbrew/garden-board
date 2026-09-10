/**
 * What is taking up space at the top of a session card.
 *
 * The owner reports an empty band there since the resizer moved out of the card. Guessing at CSS is
 * how the last four of these went wrong, so this lists every child of the node wrapper with its own
 * box and how it is positioned, and says exactly how far down the card itself starts.
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const garden = await startInstance()
const st = { projects: [], sessions: [] }
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(400)

const dir = mkdtempSync(join(tmpdir(), 'garden-probe-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: 'Probe', start: false }))
await sleep(900)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1800, height: 1100, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
await page.goto(`http://127.0.0.1:${garden.port}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

const report = await page.evaluate(() => {
  const node = document.querySelector('.react-flow__node')
  if (!node) return 'no card on the page'
  const nr = node.getBoundingClientRect()
  const lines = [`wrapper ${Math.round(nr.width)}x${Math.round(nr.height)}`]
  for (const child of node.children) {
    const r = child.getBoundingClientRect()
    const cs = getComputedStyle(child)
    lines.push(
      `  child ${String(child.className).slice(0, 46)} :: ${Math.round(r.width)}x${Math.round(r.height)}` +
        ` at y+${Math.round(r.top - nr.top)}  position=${cs.position}`,
    )
  }
  const card = node.querySelector('.node')
  if (card) {
    const cr = card.getBoundingClientRect()
    lines.push(`  the card itself starts ${Math.round(cr.top - nr.top)}px below the wrapper top`)
    for (const kid of card.children) {
      const r = kid.getBoundingClientRect()
      const cs = getComputedStyle(kid)
      lines.push(
        `    ${String(kid.className).slice(0, 44)} :: ${Math.round(r.width)}x${Math.round(r.height)}` +
          ` at y+${Math.round(r.top - cr.top)} position=${cs.position} height=${cs.height}`,
      )
    }
  }
  return lines.join('\n')
})
console.log(report)

await page.screenshot({ path: 'docs/shots/card-top-probe.png', clip: { x: 0, y: 0, width: 1400, height: 700 } })
await browser.close()
ws.close()
await garden.stop()
