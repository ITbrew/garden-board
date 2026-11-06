/**
 * Opening a pane does not answer the questions in a card's history.
 *
 * xterm answers a colour query (OSC 11) by sending bytes back as input. A pane that opens replays the
 * card's saved bytes, so every query the program ever asked was answered again and the answer reached
 * the live process as keystrokes: in a real Codex card, `]10;rgb:...\]11;rgb:...\` sat in the input
 * box ahead of what the owner typed. Canon 03 revision 13.
 *
 * No CLI is started and nothing is spent. A PowerShell card prints the query itself, and PowerShell
 * does not consume the answer, so an answer that arrives shows up as text on its prompt line, which
 * is exactly what the owner saw in Codex. Its own Garden, its own workspace, the BUILT app.
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ cards: ['Asker'], projectName: 'oldquestions' })
const card = board.cards[0]
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(5000)

// The question, asked while no pane is open, so nothing answers it now and it sits in the history.
const ask = 'Write-Host -NoNewline "$([char]27)]11;?$([char]7)"; Write-Host "asked"\r'
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: ask }))
await sleep(2500)

/*
 * The question has to be in the history, or there is nothing for a replay to answer and this test
 * passes whatever the code does. Asked of the server exactly as a pane asks for it.
 */
const snapshot = await new Promise((resolve) => {
  const on = (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'session.scrollback' && m.sessionId === card.id) {
      board.ws.off('message', on)
      resolve(m.data ?? '')
    }
  }
  board.ws.on('message', on)
  board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
})
// A running card's snapshot is its serialized screen (canon 03 revision 17), which carries no
// questions at all; a stopped card's is still the raw bytes on disk, which do. Either way the pane
// must not answer, and that is what the rest of this checks.
check(
  "the card's history either carries the question or no longer carries questions at all",
  snapshot.includes('\u001b]11;?') || snapshot.includes('asked'),
  JSON.stringify(snapshot.slice(-160)),
)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 1500, height: 1000 },
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
/*
 * Every keystroke message the page sends, recorded at the socket. The prompt line alone cannot be the
 * evidence: PowerShell's line editor reads the answer's leading escape as a key and can swallow the
 * rest, so an answer that was sent may leave nothing on screen. What left the page is the fact.
 */
await page.evaluateOnNewDocument(() => {
  window.__inputs = []
  const send = WebSocket.prototype.send
  WebSocket.prototype.send = function (data) {
    try {
      const m = JSON.parse(data)
      if (m.t === 'session.input') window.__inputs.push(m.data)
    } catch {}
    return send.call(this, data)
  }
})
const inputsSent = () => page.evaluate(() => window.__inputs.splice(0))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

/** The prompt line: the last row of the pane that begins with PowerShell's prompt. */
const promptLine = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll('.term-host .xterm-rows > div')].map((r) => r.textContent.replace(/\s+$/, ''))
    return rows.filter((r) => r.startsWith('PS ')).at(-1) ?? ''
  })

await page.evaluate(() => {
  const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.row-label')?.textContent?.trim() === 'Asker')
  row?.click()
})
await sleep(4000)
const afterOpen = await promptLine()
check('the pane opened on the card', afterOpen.startsWith('PS '), afterOpen)
// Anything after the prompt's `>` arrived as input. PowerShell eats the answer's opening escape, so
// what shows is its tail (`\` or `rgb:...`), never the whole reply; any text there is the fault.
const typed = (line) => /^PS .*?>\s*\S/.test(line)
check('and nothing was typed into it by the replay', !typed(afterOpen), afterOpen)
const sentOnOpen = await inputsSent()
check('opening the pane sent the process nothing', sentOnOpen.length === 0, JSON.stringify(sentOnOpen))

// Cleared, then the same question asked NOW, with the pane open: that one is answered, as it should be.
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\x03' }))
await sleep(800)
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: ask }))
await sleep(3000)
const afterLive = await promptLine()
const sentLive = await inputsSent()
check('the live question was answered from the page', sentLive.some((d) => d.includes('11;rgb:')), JSON.stringify(sentLive))
check('a question asked while the pane is open is still answered', typed(afterLive), afterLive)

check('the page threw nothing', pageErrors.length === 0, pageErrors.join(' | '))
await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
