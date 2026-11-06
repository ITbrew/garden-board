/**
 * Proves the board notices a socket that died without saying so, and comes back when it can.
 *
 * Reconnecting was driven entirely by `onclose`, and a half-open TCP connection never fires it: the
 * machine sleeps, or the server goes away without a clean close, and both ends go on reporting the
 * socket as OPEN forever. Sends succeed into nothing and nothing ever arrives back. From the
 * owner's side every card and every terminal stops at the same instant, permanently, while the page
 * still says it is connected. That is the whole-app freeze.
 *
 * Two things are checked here. The server answers a `pulse`, which is what gives the page a
 * heartbeat it can actually see (a protocol-level ping is answered by the browser below JavaScript
 * and never reaches the page). And a page whose server disappears says so on screen and reconnects
 * once it is back, rather than sitting there looking fine.
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import net from 'node:net'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: [`Pulse ${Date.now().toString().slice(-6)}`] })

// --- the heartbeat itself, over a plain socket -------------------------------------------------

const probe = new WebSocket(`ws://127.0.0.1:${board.port}/ws`)
let pulses = 0
probe.on('message', (raw) => {
  if (JSON.parse(String(raw)).t === 'pulse') pulses++
})
await new Promise((r) => probe.on('open', r))
probe.send(JSON.stringify({ t: 'pulse' }))
probe.send(JSON.stringify({ t: 'pulse' }))
await sleep(800)
check('the server answers a pulse', pulses === 2, `${pulses} answers to 2 pulses`)
probe.close()

// --- a socket that dies without saying so ------------------------------------------------------

/**
 * A plain TCP relay in front of the server, which can be told to stop passing traffic without
 * closing anything.
 *
 * This is the only way to produce the case that actually bites: both ends still hold an open
 * socket, neither gets a FIN, and nothing but a timeout can tell that the connection is dead. A
 * clean server shutdown does not test it, because that fires `onclose` and the old code handled
 * that fine.
 */
let blackhole = false
const pairs = []
const relay = net.createServer((client) => {
  const upstream = net.connect(board.port, '127.0.0.1')
  pairs.push(client, upstream)
  client.on('data', (d) => {
    if (!blackhole) upstream.write(d)
  })
  upstream.on('data', (d) => {
    if (!blackhole) client.write(d)
  })
  const quiet = () => {}
  client.on('error', quiet)
  upstream.on('error', quiet)
})
await new Promise((r) => relay.listen(0, '127.0.0.1', r))
const relayPort = relay.address().port

const proxied = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1800, height: 1000 },
})
const proxyPage = await proxied.newPage()
proxyPage.on('pageerror', (e) => console.log('[pageerror]', e.message))
await proxyPage.goto(`http://127.0.0.1:${relayPort}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

const proxyBanner = () =>
  proxyPage.evaluate(() => document.querySelector('.banner--offline')?.textContent?.trim() ?? '')

check('the proxied page connects normally', (await proxyBanner()) === '')

// From here the socket is alive at both ends and carries nothing. Nothing will close it.
blackhole = true
// Long enough for the watchdog's silence limit plus a tick, and nowhere near long enough for a TCP
// timeout to do the job instead.
await sleep(30_000)

const afterSilence = await proxyBanner()
check('a silent socket is noticed and reported', afterSilence.includes('Not connected'), afterSilence || '(no banner)')

// And it heals: put the traffic back and the existing backoff reconnect takes it from there.
blackhole = false
await sleep(8000)
check('and it reconnects once traffic flows again', (await proxyBanner()) === '', await proxyBanner())

await proxied.close()
for (const s of pairs) s.destroy()
relay.close()

// --- a window in the background is not a dead server -------------------------------------------

/*
 * The failure this exists to stop: Chrome throttles timers in a hidden window down to about once a
 * minute, so the page stops sending its heartbeat, nothing comes back, and the next time the timer
 * runs the clock shows far more silence than the limit allows. The first version of the watchdog
 * believed it, closed a healthy socket and put "Not connected to the Garden server" on screen. The
 * owner hit it on a server that was up and answering throughout.
 *
 * The board is deliberately left idle here. A busy one would be carrying terminal output and the
 * fault would hide behind it; a quiet one has nothing in flight but the heartbeat.
 */
const hidden = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 900 },
})
const hiddenPage = await hidden.newPage()
hiddenPage.on('pageerror', (e) => console.log('[pageerror]', e.message))

/*
 * Count sockets, do not sample the banner.
 *
 * The first version of this checked whether the offline banner was on screen and passed against the
 * broken build, because the reconnect is fast: the watchdog kills the socket, a new one is open
 * again inside a second, and the banner has come and gone before anything looks at it. What the
 * owner actually sees is that flicker repeating forever on a quiet board, so what has to be measured
 * is how many times the page threw its connection away, not whether it happened to be down when
 * asked.
 */
await hiddenPage.evaluateOnNewDocument(() => {
  window.__sockets = 0
  const Real = WebSocket
  window.WebSocket = function (...args) {
    window.__sockets++
    return new Real(...args)
  }
  window.WebSocket.prototype = Real.prototype
  Object.assign(window.WebSocket, Real)

  // The page's own clock, so a test can produce the gap a throttled timer leaves behind.
  const real = Date.now.bind(Date)
  let offset = 0
  Date.now = () => real() + offset
  window.__jump = (ms) => {
    offset += ms
  }
})

await hiddenPage.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

const hiddenBanner = () =>
  hiddenPage.evaluate(() => document.querySelector('.banner--offline')?.textContent?.trim() ?? '')
const socketCount = () => hiddenPage.evaluate(() => window.__sockets)
check('the page starts connected', (await hiddenBanner()) === '')
const socketsAtStart = await socketCount()

/*
 * The clock is moved rather than the window, because `Emulation.setPageVisibilityState` is not in
 * this Chrome. What a throttled timer actually looks like from inside the page is a tick arriving a
 * minute after the previous one instead of five seconds, and that is exactly what this produces: the
 * page's own `Date.now` jumps forward while the socket carries on normally underneath.
 *
 * This is the sharper test of the two anyway. Hiding the window would exercise the `document.hidden`
 * guard; jumping the clock exercises the one that has to hold when the browser throttles a window
 * that is still, as far as the page can tell, perfectly visible.
 */
// Three gaps, each far past the silence limit, which is what the old code measured and acted on.
for (let i = 0; i < 3; i++) {
  await hiddenPage.evaluate(() => window.__jump(60_000))
  await sleep(8000)
}
const socketsAfter = await socketCount()
const bannerAfter = await hiddenBanner()

check(
  'a throttled timer does not make the page throw its connection away',
  socketsAfter === socketsAtStart,
  `${socketsAfter - socketsAtStart} extra sockets after three minute-long gaps`,
)
check('and no offline banner is left on screen', bannerAfter === '', bannerAfter || '(no banner)')

// It really was still on the same socket rather than having quietly reconnected behind the banner.
const live = await hiddenPage.evaluate(() => document.querySelectorAll('.node').length)
check('and the board is still drawn', live > 0, `${live} cards`)

await hidden.close()

// --- and what the page does when the server goes away ------------------------------------------

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1800, height: 1000 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2000)

const bannerText = () => page.evaluate(() => document.querySelector('.banner--offline')?.textContent?.trim() ?? '')

check('no offline banner while the server is up', (await bannerText()) === '')

// The page is loaded and running off its own bundle now, so taking the server away leaves a live
// page with a dead socket, which is the situation being tested.
await board.stop()
await sleep(3000)

const banner = await bannerText()
check('the page says it is not connected', banner.includes('Not connected'), banner)
check('and says the cards are frozen rather than stopped', banner.includes('frozen'), banner)

await browser.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
