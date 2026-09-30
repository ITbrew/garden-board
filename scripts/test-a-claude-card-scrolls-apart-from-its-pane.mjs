/**
 * A Claude card's terminal is its conversation, filling the card, scrolling on its own. Canon 02
 * revision 13.
 *
 * The owner, after revision 12 sent the card's wheel to the CLI: "when i resize the terminal, it
 * resizes the conversation size in the cards" and "the card only scrolls until the terminal pane
 * height", and then "i want to be able to scroll from card or from open panen terminal". Claude Code
 * repaints one screen the size of the dock pane, so the card now draws the conversation from the
 * transcript and takes only the live bottom lines from the screen. What is held here:
 *
 * - The card shows the conversation in the CLI's marks, newest at the bottom, more of it than the
 *   screen could ever hold.
 * - Under it, the live lines from the screen: the working line, the prompt box, the status line. And
 *   none of the screen's own copy of the conversation above them.
 * - The wheel scrolls the card back to the first thing said, over the conversation and over the live
 *   lines alike, and never reaches the program: the pane is not moved by the card.
 * - A shell card keeps its terminal.
 *
 * The program behind the Claude card is a fake `claude` put first on PATH for this instance only. It
 * asks for the mouse exactly as Claude Code does, draws a screen shaped like Claude Code's, and
 * writes whatever reaches it to a file. No CLI is started and nothing is spent. Its own Garden on its
 * own port, serving the BUILT app: run `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// --- the fake CLI, first on PATH before the instance starts, so only this instance sees it ---

const bin = mkdtempSync(join(tmpdir(), 'garden-fake-claude-'))
const heard = join(bin, 'heard.txt')
const RULE = '─'.repeat(60)
const FAKE = String.raw`
import { appendFileSync } from 'node:fs'
const out = (s) => process.stdout.write(s)
out('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[H')
const rows = process.stdout.rows || 24
const screen = []
for (let i = 0; i < rows - 8; i++) screen.push('● screen-only copy ' + i)
screen.push('', '✻ Fermenting… (3s · esc to interrupt)', '', '${RULE} Talker ─', '> ', '${RULE}', '  ⏵⏵ auto mode on (shift+tab to cycle)')
out(screen.join('\r\n'))
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on('data', (d) => appendFileSync(${JSON.stringify(heard)}, d.toString('latin1').replace(/\x1b/g, 'ESC') + '\n'))
// Repaints its top row now and then, as the real CLI's spinner and timer do, so the screen changes.
let tick = 0
setInterval(() => out('\x1b[s\x1b[1;1H● screen-only copy 0 ' + (tick++ % 10) + '\x1b[u'), 400)
`
writeFileSync(join(bin, 'fake-claude.mjs'), FAKE, 'utf8')
writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake-claude.mjs"\r\n`, 'utf8')
process.env.PATH = `${bin};${process.env.PATH}`

const { openBoard } = await import('./lib/board.mjs')
const board = await openBoard({
  projectName: 'claude-scroll',
  cards: [{ title: 'Talker', adapterId: 'claude' }, { title: 'Plain shell' }],
})
const [talker, shell] = board.cards

/*
 * Four hundred exchanges and a tool call, so paging to the start is proved rather than lucky. Same
 * shape as the conversation test's fixture, delivered the same way: a real `Stop` hook.
 */
const transcript = join(board.dir, 'fixture-transcript.jsonl')
const line = (i, role, content) =>
  JSON.stringify({ type: role, timestamp: new Date(Date.UTC(2026, 8, 29, 9, 0, i)).toISOString(), message: { role, content } }) + '\n'
let body = ''
for (let i = 1; i <= 400; i++) {
  body += line(i * 2, 'user', [{ type: 'text', text: i === 1 ? 'the very first question' : `question number ${i}` }])
  body += line(i * 2 + 1, 'assistant', [
    { type: 'text', text: i === 400 ? 'the most recent answer' : `answer number ${i}` },
    ...(i === 400 ? [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }] : []),
  ])
}
writeFileSync(transcript, body, 'utf8')

board.ws.send(JSON.stringify({ t: 'session.start', sessionId: talker.id }))
await sleep(5000)
// ConPTY holds the first input while it waits for an answer nobody gives; this Enter is spent on it.
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: talker.id, data: '\r' }))
await sleep(3000)
await fetch(`http://127.0.0.1:${board.port}/hook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    gardenSessionId: talker.id,
    receivedAt: Date.now(),
    event: { hook_event_name: 'Stop', session_id: 'fixture-session', transcript_path: transcript },
  }),
})
await sleep(1500)
const heardBefore = existsSync(heard) ? readFileSync(heard, 'utf8') : ''

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1800,1100', '--no-sandbox'],
  defaultViewport: { width: 1800, height: 1100 },
})
const pageErrors = []

try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(board.UI, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.mini', { timeout: 20000 })
  await sleep(4000)

  const read = () =>
    page.evaluate((t) => {
      const n = [...document.querySelectorAll('.react-flow__node')].find((x) => x.querySelector('.node-title')?.textContent?.trim() === t)
      const log = n?.querySelector('.claude-log')
      const live = n?.querySelector('.claude-live')
      const box = log?.getBoundingClientRect()
      const turns = log ? [...log.querySelectorAll('.claude-turn')] : []
      const lastVisible = turns.filter((r) => r.getBoundingClientRect().top < box.bottom).pop()
      return {
        hasLog: !!log,
        turns: turns.length,
        scrollTop: log?.scrollTop ?? -1,
        overflow: log ? log.scrollHeight - log.clientHeight : 0,
        logText: log?.innerText ?? '',
        liveText: live?.innerText ?? '',
        lastVisible: lastVisible?.innerText ?? '',
        log: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
        live: live ? (({ x, y, width, height }) => ({ x, y, w: width, h: height }))(live.getBoundingClientRect()) : null,
      }
    }, talker.title)

  let r = await read()
  if (process.env.SHOT) {
    const n = await page.evaluateHandle((t) => [...document.querySelectorAll('.react-flow__node')].find((x) => x.querySelector('.node-title')?.textContent?.trim() === t), talker.title)
    await n.asElement().screenshot({ path: process.env.SHOT })
    console.log(await page.evaluate((t) => { const n = [...document.querySelectorAll('.react-flow__node')].find((x) => x.querySelector('.node-title')?.textContent?.trim() === t); const q = (s) => n.querySelector(s)?.getBoundingClientRect().height; return { node: q('.mini-wrap') && n.getBoundingClientRect().height, wrap: q('.mini-wrap'), mini: q('.mini'), log: q('.claude-log'), live: q('.claude-live') } }, talker.title))
  }
  check('the Claude card draws its conversation in the terminal body', r.hasLog && r.log?.h > 0, JSON.stringify(r.log))
  check('and the live lines never crowd it out, even on a card at its first size', !!r.live && r.log.h >= r.live.h, `${r.log?.h} over ${r.live?.h}px`)
  check('newest at the bottom, in the CLI’s marks', /●\s*Bash\(npm run build\)/.test(r.lastVisible), JSON.stringify(r.lastVisible))
  check('with the answer before it and the question as a > line', r.logText.includes('the most recent answer') && /^>\s*question number 400/m.test(r.logText))
  check('more conversation than one screen, so there is something to scroll', r.overflow > 0 && r.turns >= 60, `${r.turns} turns, ${r.overflow}px over`)
  check('the live lines are under it: the working line', r.liveText.includes('Fermenting…'), JSON.stringify(r.liveText))
  check('the status line, and not the prompt box, which the card’s own input line stands for (revision 14)', r.liveText.includes('auto mode on') && !/^\s*>/m.test(r.liveText), JSON.stringify(r.liveText))
  check('and none of the screen’s own copy of the conversation', !r.liveText.includes('screen-only') && !r.logText.includes('screen-only'))

  // Grown, the card gives every added row to the conversation; the live lines stay the same.
  // What the owner types shows up while the turn runs, with no hook, no status change and no dock.
  // The CLI writes his line to the transcript a moment after Enter; the card has to notice by itself.
  appendFileSync(transcript, line(900, 'user', [{ type: 'text', text: 'a message typed just now' }]), 'utf8')
  let typed = false
  for (let i = 0; i < 12 && !typed; i++) {
    await sleep(500)
    typed = (await read()).logText.includes('a message typed just now')
  }
  check('a message typed into a running card shows on the card within a few seconds', typed)
  r = await read()

  const small = r
  board.ws.send(JSON.stringify({ t: 'session.setSize', sessionId: talker.id, size: 'large' }))
  await sleep(1500)
  r = await read()
  check('a bigger card fills its added height with conversation', r.log.h > small.log.h * 4 && r.live.h <= small.live.h * 2 + 1, `log ${small.log.h} -> ${r.log.h}, live ${small.live.h} -> ${r.live.h}`)
  if (process.env.SHOT) {
    const n = await page.evaluateHandle((t) => [...document.querySelectorAll('.react-flow__node')].find((x) => x.querySelector('.node-title')?.textContent?.trim() === t), talker.title)
    await n.asElement().screenshot({ path: process.env.SHOT.replace('.png', '-big.png') })
  }

  // The wheel over the conversation scrolls it up, and a lot of it reaches the start.
  const start = r.scrollTop
  await page.mouse.move(r.log.x + r.log.w / 2, r.log.y + r.log.h / 2)
  await page.mouse.wheel({ deltaY: -300 })
  await sleep(600)
  r = await read()
  check('the wheel over the card scrolls the conversation up', r.scrollTop < start, `${start} -> ${r.scrollTop}`)

  const mid = r.scrollTop
  await page.mouse.move(r.live.x + r.live.w / 2, r.live.y + r.live.h / 2)
  await page.mouse.wheel({ deltaY: -300 })
  await sleep(600)
  r = await read()
  check('and so does the wheel over the live lines', r.scrollTop < mid, `${mid} -> ${r.scrollTop}`)

  await page.mouse.move(r.log.x + r.log.w / 2, r.log.y + r.log.h / 2)
  for (let i = 0; i < 150 && !r.logText.includes('Start of this conversation.'); i++) {
    await page.mouse.wheel({ deltaY: -4000 })
    await sleep(250)
    if (i % 10 === 9) r = await read()
  }
  await sleep(800)
  r = await read()
  check('it pages back to the first thing said', r.logText.includes('the very first question') && r.logText.includes('Start of this conversation.'))

  await sleep(800)
  const heardAfter = existsSync(heard) ? readFileSync(heard, 'utf8') : ''
  const reports = heardAfter.slice(heardBefore.length)
  check('no wheel reached the program, so the pane is never moved by the card', !/ESC\[<6[45];/.test(reports), JSON.stringify(reports.slice(0, 120)))
  check('the fake CLI was the program behind the card', r.liveText.includes('auto mode on'))

  const shellKind = await page.evaluate((t) => {
    const n = [...document.querySelectorAll('.react-flow__node')].find((x) => x.querySelector('.node-title')?.textContent?.trim() === t)
    return n?.querySelector('.claude-log') ? 'conversation' : n?.querySelector('.mini') ? 'terminal' : 'neither'
  }, shell.title)
  check('a shell card keeps its terminal', shellKind === 'terminal', shellKind)

  // Turned off, and the page loaded fresh: the conversation is still there to read and scroll,
  // since it comes from the transcript on disk. Only the live lines go, having nothing behind them.
  board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: talker.id }))
  await sleep(3000)
  await page.reload({ waitUntil: 'networkidle2' })
  await sleep(4000)
  r = await read()
  check('a card that is off still shows its conversation', r.turns > 0 && r.logText.includes('the most recent answer'), `${r.turns} turns`)
  check('and no live lines, since nothing is running', !r.live)
  if (process.env.SHOT) {
    const n = await page.evaluateHandle((t) => [...document.querySelectorAll('.react-flow__node')].find((x) => x.querySelector('.node-title')?.textContent?.trim() === t), talker.title)
    await n.asElement().screenshot({ path: process.env.SHOT.replace('.png', '-off.png') })
  }
  const offTop = r.scrollTop
  await page.mouse.move(r.log.x + r.log.w / 2, r.log.y + r.log.h / 2)
  await page.mouse.wheel({ deltaY: -300 })
  await sleep(600)
  r = await read()
  check('and it scrolls', r.scrollTop < offTop, `${offTop} -> ${r.scrollTop}`)
} finally {
  await browser.close()
}

check('the page threw nothing', pageErrors.length === 0, pageErrors.join(' | '))
board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: talker.id }))
await sleep(500)
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
