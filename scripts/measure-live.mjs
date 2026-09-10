/**
 * Measure the board the owner is actually looking at, and change nothing.
 *
 * Read only, deliberately and carefully. It loads the app in a headless browser, reads geometry out
 * of the DOM, and closes. It never clicks, never drags, never opens or folds a web. The one thing a
 * fresh client can do on its own is report a packed layout back, and that only happens when every
 * card on the board has no manual position; check that before running this, because two of my
 * scripts have already moved his cards.
 *
 * This exists because the same measurement on a scratch board comes out clean while he is still
 * looking at an overlap. A scratch board is not his board: his cards were placed by older code, at
 * sizes and offsets that no longer match, and only the real one can show that.
 */
import puppeteer from 'puppeteer-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = Number(process.env.GARDEN_PORT) || 5178
const PAD = 26
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 3840, height: 1600, deviceScaleFactor: 1 },
  args: ['--window-size=3840,1600', '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' })
await sleep(4000)

const shot = await page.evaluate(() => {
  const viewport = document.querySelector('.react-flow__viewport')
  if (!viewport) return { error: 'no canvas' }
  const t = new DOMMatrixReadOnly(getComputedStyle(viewport).transform)
  const scale = t.a || 1
  const nodes = []
  for (const el of document.querySelectorAll('.react-flow__node')) {
    const r = el.getBoundingClientRect()
    const type = ([...el.classList].find((c) => c.startsWith('react-flow__node-')) ?? '?').replace(
      'react-flow__node-',
      '',
    )
    // The whole footprint, furniture included: the arrows and their labels straddle the border and
    // are as much a part of what covers a neighbour as the card body is.
    let top = r.top
    let bottom = r.bottom
    for (const kid of el.querySelectorAll('.port-arrow, .port-label')) {
      const k = kid.getBoundingClientRect()
      if (k.width === 0) continue
      top = Math.min(top, k.top)
      bottom = Math.max(bottom, k.bottom)
    }
    nodes.push({
      type,
      text: (el.textContent ?? '').trim().slice(0, 34).replace(/\s+/g, ' '),
      x: (r.left - t.e) / scale,
      y: (top - t.f) / scale,
      w: r.width / scale,
      h: (bottom - top) / scale,
      body: (r.bottom - r.top) / scale,
    })
  }
  return { scale, nodes }
})

if (shot.error) {
  console.log(shot.error)
} else {
  console.log(`\n${shot.nodes.length} nodes drawn, canvas scale ${shot.scale.toFixed(3)}\n`)
  for (const n of [...shot.nodes].sort((a, b) => a.y - b.y)) {
    console.log(
      `  y ${String(Math.round(n.y)).padStart(6)} to ${String(Math.round(n.y + n.h)).padStart(6)}` +
        `  x ${String(Math.round(n.x)).padStart(6)} to ${String(Math.round(n.x + n.w)).padStart(6)}` +
        `  [${n.type}] ${n.text}`,
    )
  }

  const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h
  const furniture = (n) => n.type === 'webFrame' || n.type === 'columnHeader'
  const bad = []
  for (let i = 0; i < shot.nodes.length; i++) {
    for (let j = i + 1; j < shot.nodes.length; j++) {
      const a = shot.nodes[i]
      const b = shot.nodes[j]
      if (contains(a, b) || contains(b, a)) continue
      if (furniture(a) && furniture(b)) continue
      const gap = Math.max(
        Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)),
        Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)),
      )
      if (gap < PAD) bad.push({ gap: Math.round(gap), line: `[${a.type}] ${a.text}  <->  [${b.type}] ${b.text}` })
    }
  }
  console.log(`\n${bad.length} pair(s) closer than ${PAD}px on the live board`)
  for (const c of bad.sort((x, y) => x.gap - y.gap)) {
    console.log(`  ${c.gap < 0 ? `OVERLAPPING by ${-c.gap}px` : `${c.gap}px apart`}: ${c.line}`)
  }
}

await page.screenshot({ path: 'docs/shots/live-board.png' })
console.log('\nshot: docs/shots/live-board.png')
await browser.close()
