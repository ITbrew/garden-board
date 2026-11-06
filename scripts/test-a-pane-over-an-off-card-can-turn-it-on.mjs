/**
 * A terminal pane over a card that is off says so, and offers the way back on.
 *
 * The owner's report: "sometimes when i open terminal for a card theres no input field",
 * "specifically when trying to resume/awake an idle session". There is no input field to lose. The
 * terminal IS the input, and Garden disables its stdin when the card's process has ended, so a dead
 * pane looks exactly like a live one: same last screen, same cursor where it stopped, and the only
 * difference is that keystrokes go nowhere. The dock offered Turn off for a process that had already
 * ended and no way at all to start one.
 *
 * So this drives his path: open the pane while the card is running, end the process, and check that
 * the pane admits it and can revive it. Its own Garden, its own workspace, serving the BUILT app, so
 * run `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Alpha'] })
const card = board.cards[0]

// The card's own status, followed on the same socket, so the test never guesses from the screen
// whether a process is really running.
let status = 'unknown'
let pid = null
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if ((m.t === 'session.updated' || m.t === 'session.added') && m.session?.id === card.id) {
    status = m.session.status
    pid = m.session.pid
  }
})

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(4000)
check('the card is running to begin with', pid !== null, `status ${status}, pid ${pid ?? '-'}`)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

/** Open the pane the way he does, from the sidebar's list of running cards. */
const opened = await page.evaluate((t) => {
  const row = [...document.querySelectorAll('.row')].find(
    (r) => r.querySelector('.row-label')?.textContent?.trim() === t,
  )
  row?.click()
  return !!row
}, 'Alpha')
await sleep(2500)
check('its pane opens', opened && (await page.$('.dock-pane')) !== null)

/** What the pane says about this card right now. */
const pane = () =>
  page.evaluate(() => {
    const p = document.querySelector('.dock-pane')
    if (!p) return null
    return {
      off: !!p.querySelector('.dock-off'),
      buttons: [...p.querySelectorAll('.dock-head button')].map((b) => b.textContent.trim()),
      // xterm keeps the real focus target in a textarea; a disabled stdin leaves it there but
      // refuses the keystroke, so the visible state is the only honest thing to assert on.
      hasTerminal: !!p.querySelector('.xterm'),
      // The bar over the input row (canon 03 revision 12): there, and actually over the bottom of
      // the terminal rather than somewhere else in the pane.
      bar: p.querySelector('.dock-offbar')?.textContent.trim() ?? null,
      barOverBottom: (() => {
        const bar = p.querySelector('.dock-offbar')?.getBoundingClientRect()
        const host = p.querySelector('.term-host')?.getBoundingClientRect()
        return !!bar && !!host && bar.height > 0 && Math.abs(bar.bottom - host.bottom) < 2
      })(),
    }
  })

let seen = await pane()
check('a running card is not marked off', seen?.off === false, JSON.stringify(seen))
check('and the pane offers Turn off', seen?.buttons.includes('Turn off'), (seen?.buttons ?? []).join(', '))
check('and it has a terminal in it', seen?.hasTerminal === true)
check('and no off bar over its input', seen?.bar === null, seen?.bar ?? '')

// ---------------------------------------------------------------------------
// The process ends. This is the state he was in when the input stopped working.
// ---------------------------------------------------------------------------
board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(4000)
check('the process really ended', pid === null, `status ${status}, pid ${pid ?? '-'}`)

seen = await pane()
check('the pane now says the card is off', seen?.off === true, JSON.stringify(seen))
check('and offers Turn on instead of Turn off',
  seen?.buttons.includes('Turn on') && !seen?.buttons.includes('Turn off'),
  (seen?.buttons ?? []).join(', '))
check('the terminal is still there rather than blanked', seen?.hasTerminal === true)
check('a bar across the bottom says it is off', /is off/.test(seen?.bar ?? ''), seen?.bar ?? 'no bar')
check('and says typing goes nowhere', /typing here goes nowhere/.test(seen?.bar ?? ''))
check('and it sits over the bottom of the terminal, where the input row is', seen?.barOverBottom === true)
await page.screenshot({ path: join(process.env.SHOT_DIR ?? board.dir, 'off-pane.png') })
console.log('shot:', join(process.env.SHOT_DIR ?? board.dir, 'off-pane.png'))

// ---------------------------------------------------------------------------
// And the way back, from the pane, without going to find the card.
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  // The bar's own button this time; the header's is the same action and was proven before the bar.
  const b = [...document.querySelectorAll('.dock-pane .dock-offbar button')].find(
    (n) => n.textContent.trim() === 'Turn on',
  )
  b?.click()
})
await sleep(5000)
check('Turn on from the pane started it again', pid !== null, `status ${status}, pid ${pid ?? '-'}`)

seen = await pane()
check('and the pane stops saying off', seen?.off === false, JSON.stringify(seen))
check('and offers Turn off again', seen?.buttons.includes('Turn off'), (seen?.buttons ?? []).join(', '))
check('and the bar is gone', seen?.bar === null, seen?.bar ?? '')

check('no page errors', pageErrors.length === 0, pageErrors[0] ?? '')

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
