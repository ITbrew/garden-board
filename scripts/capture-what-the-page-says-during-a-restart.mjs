/**
 * What the board actually says between the press and coming back, sampled rather than argued about.
 *
 * A measurement, not a test: nothing here passes or fails. It exists because the question "the page
 * says nothing useful while the server is away" cannot be answered by reading the components. There
 * are two banners in `App.tsx` with different lifetimes, one of them carries a sentence the server
 * sends before it dies, and the only honest way to say what is on screen and for how long is to look
 * every tenth of a second and print the timeline.
 *
 * Its own Garden, its own port, its own workspace, and it serves the BUILT app. Never the live
 * board.
 *
 *   npm run build
 *   node scripts/capture-what-the-page-says-during-a-restart.mjs
 */
import puppeteer from 'puppeteer-core'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SAMPLE_MS = 100
const WATCH_MS = 25_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const board = await openBoard({ projectName: 'restartsays', cards: [{ title: 'Alpha' }] })
const PORT = board.port

const killByPort = async () => {
  const ps = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$p = (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if ($p) { Stop-Process -Id $p -Force }`,
    ],
    { stdio: 'ignore' },
  )
  await new Promise((r) => ps.on('close', r))
}

const listening = () =>
  new Promise((done) => {
    const probe = connect({ port: PORT, host: '127.0.0.1' })
    probe.setTimeout(200)
    probe.on('connect', () => {
      probe.destroy()
      done(true)
    })
    probe.on('timeout', () => {
      probe.destroy()
      done(false)
    })
    probe.on('error', () => done(false))
  })

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: board.cards[0].id }))
await sleep(3000)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
page.on('dialog', async (d) => {
  await d.accept()
})
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' })
await sleep(2500)

/** Everything the page is currently saying about the connection, in one read. */
const saying = () =>
  page
    .evaluate(() => ({
      chip: document.querySelector('.conn')?.textContent?.trim() ?? '(no chip)',
      offline: document.querySelector('.banner--offline')?.textContent?.trim() ?? '',
      error: document.querySelector('.banner--error')?.textContent?.trim() ?? '',
      cards: document.querySelectorAll('.node').length,
    }))
    .catch(() => ({ chip: '(page busy)', offline: '', error: '', cards: -1 }))

console.log('before the press:', JSON.stringify(await saying()))

await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Restart server')
  btn?.click()
})

const t0 = Date.now()
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5)
let last = ''
let downFrom = null
let downTo = null

while (Date.now() - t0 < WATCH_MS) {
  const now = await saying()
  const listens = await listening()
  if (!listens && downFrom === null) downFrom = Date.now()
  if (listens && downFrom !== null && downTo === null) downTo = Date.now()
  const line = `chip="${now.chip}" cards=${now.cards} offline="${now.offline}" error="${now.error}" port=${listens ? 'up' : 'down'}`
  // Only when something changes, so the timeline reads as events rather than as two hundred rows.
  if (line !== last) {
    console.log(`${at()}s  ${line}`)
    last = line
  }
  await sleep(SAMPLE_MS)
}

if (downFrom) {
  const backAt = downTo ?? Date.now()
  console.log(
    `\nthe port was closed for ${((backAt - downFrom) / 1000).toFixed(1)}s, ` +
      `from ${((downFrom - t0) / 1000).toFixed(1)}s to ${((backAt - t0) / 1000).toFixed(1)}s after the press`,
  )
}

await browser.close()
await killByPort()
