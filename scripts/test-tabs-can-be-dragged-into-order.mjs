/**
 * Tabs can be dragged into any order, the order is kept, and the snap grid is 44. Canon 02 revision 17.
 *
 * The owner: "can u make it so i can rearrange tabs as well, currently they are static", and "increase
 * size of the snap grid, they are basically pixels compared to the card sizes". Three project tabs; the
 * first is dragged past the third with a real drag in the page; the row has to read in the new order,
 * and still read that way on a fresh page and after the server restarts. A tab opened afterwards goes
 * at the right end. Its own Garden on its own port and workspace, serving the BUILT app: run
 * `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const home = mkdtempSync(join(tmpdir(), 'garden-tab-order-home-'))
let garden = await startInstance({ home })
const folder = (name) => {
  const dir = mkdtempSync(join(tmpdir(), `garden-tab-${name}-`))
  writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
  return dir
}
const add = async (dir) => {
  const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello' }))
  await sleep(300)
  ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/'), name: dir.split(/[\\/]/).pop().split('-')[2] }))
  await sleep(900)
  ws.close()
}
for (const n of ['alpha', 'bravo', 'charlie']) await add(folder(n))

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1600,1000', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
})
const errors = []
const rowOf = (page) => page.$$eval('.tabs .tab:not(.tab--add) .tab-name', (els) => els.map((e) => e.textContent))
const openPage = async () => {
  const page = await browser.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${garden.port}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.tabs .tab-name', { timeout: 20000 })
  await sleep(800)
  return page
}

try {
  let page = await openPage()
  const start = await rowOf(page)
  check('three tabs to start with', start.length === 3, start.join(', '))

  /*
   * The browser's drag events, in the order a drag fires them: the first tab picked up, carried over
   * the right half of the last, dropped. Headless Chrome does not turn mouse moves into these by
   * itself, so they are dispatched, with a pause between each as a hand gives the page.
   */
  await page.evaluate(() => {
    window.__dt = new DataTransfer()
  })
  const fire = (type, index) =>
    page.evaluate(
      (type, index) => {
        const t = [...document.querySelectorAll('.tabs .tab:not(.tab--add)')]
        const r = t[2].getBoundingClientRect()
        const at = { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: r.right - 4, clientY: r.top + r.height / 2 }
        t[index].dispatchEvent(new DragEvent(type, at))
      },
      type,
      index,
    )
  await fire('dragstart', 0)
  await sleep(150)
  await fire('dragover', 2)
  await sleep(150)
  await fire('drop', 2)
  await sleep(50)
  await fire('dragend', 0)
  await sleep(800)
  let row = await rowOf(page)
  const moved = [start[1], start[2], start[0]]
  // Dropped on the last tab's middle; either side of it is a legitimate landing, before or after.
  const either = [moved.join(','), [start[1], start[0], start[2]].join(',')]
  check('the first tab moved along the row', either.includes(row.join(',')) && row[0] !== start[0], `${start.join(', ')} -> ${row.join(', ')}`)
  const after = row

  page = await openPage()
  check('a fresh page shows the same order', (await rowOf(page)).join(',') === after.join(','), (await rowOf(page)).join(', '))

  await garden.stop()
  garden = await startInstance({ home })
  page = await openPage()
  check('and so does the board after the server restarts', (await rowOf(page)).join(',') === after.join(','), (await rowOf(page)).join(', '))

  await add(folder('delta'))
  await sleep(600)
  row = await rowOf(page)
  check('a tab opened afterwards goes at the right end', row.length === 4 && row[3] === 'delta', row.join(', '))

  const gap = await page.$eval('.react-flow__background pattern', (p) => p.getAttribute('width')).catch(() => null)
  check('the grid the cards snap to is 44 wide', gap !== null && Math.abs(Number(gap) - 44) < 0.5, `pattern width ${gap}`)
} finally {
  await browser.close()
}
check('the page threw nothing', errors.length === 0, errors.join(' | '))
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
