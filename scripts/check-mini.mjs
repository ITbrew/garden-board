/**
 * Checks the card miniature is a real terminal view rather than grey text: that it renders
 * coloured spans, that its lines stay inside the card, and that the wire is a curve rather than
 * a straight line through whatever is in the way.
 */
import puppeteer from 'puppeteer-core'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 3840, height: 1600, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle2' })
await sleep(2500)

const colours = await page.evaluate(() => {
  const set = new Set()
  document.querySelectorAll('.mini span').forEach((s) => {
    const c = getComputedStyle(s).color
    if (c) set.add(c)
  })
  return [...set]
})
console.log('distinct span colours in miniatures:', colours.length)
console.log('  ', colours.slice(0, 8).join(' | '))

const overflow = await page.evaluate(() => {
  const bad = []
  document.querySelectorAll('.node').forEach((card) => {
    const cr = card.getBoundingClientRect()
    card.querySelectorAll('.mini-row').forEach((row) => {
      const rr = row.getBoundingClientRect()
      if (rr.right > cr.right + 1 || rr.left < cr.left - 1 || rr.bottom > cr.bottom + 1) {
        bad.push({ card: card.querySelector('.node-title')?.textContent, right: Math.round(rr.right - cr.right) })
      }
    })
  })
  return bad
})
console.log('miniature rows escaping their card:', overflow.length, overflow.slice(0, 3))

const fit = await page.evaluate(() => {
  const out = []
  document.querySelectorAll('.mini').forEach((m) => {
    const grid = m.querySelector('.mini-grid')
    if (!grid) return
    const avail = m.clientHeight - 12
    out.push({ grid: Math.round(grid.getBoundingClientRect().height), avail: Math.round(avail) })
  })
  return out
})
const overflowing = fit.filter((f) => f.grid > f.avail)
console.log('miniatures whose rows overflow their pane:', overflowing.length, overflowing.slice(0, 3))

const edge = await page.evaluate(() => {
  const p = document.querySelector('.react-flow__edge-path')
  return p ? p.getAttribute('d') : null
})
console.log('wire path:', edge)
console.log('wire is a curve:', edge ? edge.includes('C') : false)

await browser.close()
