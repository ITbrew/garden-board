/**
 * Typing on a Claude card, walked the way the owner does it. Canon 02 revisions 13 and 14.
 *
 * What he reported, in order: "typing into cards doesnt show my message until after i open
 * terminal", "my input is populating into the conversation before i press enter instead of into the
 * 'type into this terminal' line", and "when i type in open terminal panel the input goes above the
 * input for the card". What is held here:
 *
 * - A card that is off takes the first line typed into it: the card starts, and that line reaches the
 *   CLI with nothing typed ahead of it to prime the terminal.
 * - What he types into the card's line stays in that line and reaches nothing until Enter.
 * - After Enter the message shows in the card's conversation while the turn runs, not only after it.
 * - The card has one input line: the CLI's prompt box is not drawn on the card, and text typed in the
 *   pane (sent straight to the process, as the dock does) shows in the card's own line.
 * - The CLI's dim suggestion in an empty prompt is not shown as a draft.
 *
 * The CLI is a fake `claude` first on PATH for this instance only. It behaves like Claude Code where
 * this depends on it: it sends SessionStart, UserPromptSubmit and Stop hooks to Garden, draws a prompt
 * box that echoes what is typed (with a dim suggestion when empty), and writes the transcript. No real
 * CLI is started and nothing is spent. Its own Garden on its own port, serving the BUILT app: run
 * `npm run build` first. Screenshots go to SHOT_DIR when it is set.
 */
import puppeteer from 'puppeteer-core'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}
const SHOTS = process.env.SHOT_DIR ?? null

const bin = mkdtempSync(join(tmpdir(), 'garden-fake-claude-'))
const heard = join(bin, 'heard.txt')
const transcript = join(bin, 'transcript.jsonl')
writeFileSync(transcript, '', 'utf8')

const fakeSource = (port) => String.raw`
import { appendFileSync } from 'node:fs'
const HEARD = ${JSON.stringify(heard)}
const TRANSCRIPT = ${JSON.stringify(transcript)}
const out = (s) => process.stdout.write(s)
const hook = (name) =>
  fetch(${JSON.stringify(`http://127.0.0.1:${port}/hook`)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gardenSessionId: process.env.GARDEN_SESSION_ID,
      receivedAt: Date.now(),
      event: { hook_event_name: name, session_id: 'fake-session', transcript_path: TRANSCRIPT },
    }),
  }).catch(() => {})
const say = (role, text) =>
  appendFileSync(TRANSCRIPT, JSON.stringify({ type: role, timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text }] } }) + '\n')

let buf = ''
let working = false
const RULE = '─'.repeat(60)
const draw = () => {
  const rows = process.stdout.rows || 24
  const lines = []
  for (let i = 0; i < rows - 7; i++) lines.push('● screen-only copy ' + i)
  lines.push(working ? '✻ Thinking… (2s · esc to interrupt)' : '')
  lines.push(RULE + ' Typist ─')
  lines.push(buf ? '> ' + buf : '> \x1b[2mTry "fix the lint errors"\x1b[22m')
  lines.push(RULE)
  lines.push('  ⏵⏵ auto mode on (shift+tab to cycle)')
  out('\x1b[H\x1b[2J' + lines.join('\r\n'))
}
out('\x1b[?1000h\x1b[?1006h')
draw()
hook('SessionStart')
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on('data', (d) => {
  const s = d.toString('utf8')
  appendFileSync(HEARD, JSON.stringify(s) + '\n')
  for (const ch of s.replace(/\x1b\[[?<>]?[0-9;]*[a-zA-Z~]/g, '')) {
    if (ch === '\r') {
      const text = buf.trim()
      buf = ''
      if (!text) continue
      say('user', text)
      hook('UserPromptSubmit')
      working = true
      setTimeout(() => {
        say('assistant', 'got: ' + text)
        working = false
        draw()
        hook('Stop')
      }, 2500)
    } else if (ch === '\x7f' || ch === '\b') buf = buf.slice(0, -1)
    else if (ch >= ' ') buf += ch
  }
  draw()
})
setInterval(() => working && draw(), 500)
`
writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake-claude.mjs"\r\n`, 'utf8')
process.env.PATH = `${bin};${process.env.PATH}`
// The server waits this long after SessionStart before typing a held line; a shorter settle keeps the
// test quick without changing what it checks.
process.env.GARDEN_CLI_SETTLE_MS = '1500'

const { openBoard } = await import('./lib/board.mjs')
const board = await openBoard({ projectName: 'claude-typing', cards: [{ title: 'Typist', adapterId: 'claude' }] })
const [card] = board.cards
// Written now, with this board's own port in it: `claude.cmd` only runs it when the card starts.
writeFileSync(join(bin, 'fake-claude.mjs'), fakeSource(board.port), 'utf8')
const heardText = () => (existsSync(heard) ? readFileSync(heard, 'utf8') : '')

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1600,1000', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
})
const pageErrors = []

try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(board.UI, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.react-flow__node', { timeout: 20000 })
  board.ws.send(JSON.stringify({ t: 'session.setSize', sessionId: card.id, size: 'large' }))
  await sleep(2500)

  const nodeSel = `.react-flow__node[data-id="${card.id}"]`
  const shot = async (name) => {
    if (!SHOTS) return
    const n = await page.$(nodeSel)
    await n.screenshot({ path: join(SHOTS, `typing-${name}.png`) })
  }
  const read = () =>
    page.evaluate((sel) => {
      const n = document.querySelector(sel)
      const input = n?.querySelector('form.node-input input')
      return {
        status: n?.querySelector('.status-label, .node-status')?.textContent?.trim() ?? '',
        value: input?.value ?? null,
        placeholder: input?.placeholder ?? null,
        mirror: !!input?.classList.contains('node-input__mirror'),
        inputs: n ? n.querySelectorAll('form.node-input input').length : 0,
        log: n?.querySelector('.claude-log')?.innerText ?? '',
        live: n?.querySelector('.claude-live')?.innerText ?? '',
      }
    }, nodeSel)
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms
    let r = await read()
    while (!fn(r) && Date.now() < end) {
      await sleep(300)
      r = await read()
    }
    return r
  }

  let r = await read()
  check('the card starts off, asking to be typed into', /start this session/.test(r.placeholder ?? ''), r.placeholder)
  await shot('1-off')

  // --- the first line, typed into a card that is off ---
  await page.click(`${nodeSel} form.node-input input`)
  await page.keyboard.type('first line from the card', { delay: 15 })
  r = await read()
  check('what he types stays in the card’s line', r.value === 'first line from the card', JSON.stringify(r.value))
  await shot('2-typed-off')
  await page.keyboard.press('Enter')

  r = await until((x) => x.log.includes('first line from the card'))
  const firstHeard = heardText()
  check('Enter on an off card starts it and the line reaches the CLI', firstHeard.includes('first line from the card'), JSON.stringify(firstHeard.slice(0, 200)))
  check('with nothing typed ahead of it', firstHeard.split('\n')[0]?.includes('first line') ?? false, JSON.stringify(firstHeard.split('\n')[0]))
  check('and the message shows in the card’s conversation', /first line from the card/.test(r.log))
  await shot('3-sent-first')
  r = await until((x) => x.log.includes('got: first line from the card'))
  check('followed by the answer when the turn ends', r.log.includes('got: first line from the card'))

  // --- typing into a running card: nothing leaves the line before Enter ---
  const before = heardText().length
  await page.click(`${nodeSel} form.node-input input`)
  await page.keyboard.type('second line, not sent yet', { delay: 15 })
  await sleep(1200)
  r = await read()
  check('typing into a running card’s line sends nothing before Enter', heardText().length === before, JSON.stringify(heardText().slice(before)))
  check('the text is in the card’s line', r.value === 'second line, not sent yet', JSON.stringify(r.value))
  check('and nowhere in the conversation or the live lines', !r.log.includes('second line') && !r.live.includes('second line'))
  await shot('4-typed-running')
  await page.keyboard.press('Enter')
  r = await until((x) => x.log.includes('second line, not sent yet') && !x.log.includes('got: second line'), 6000)
  check('after Enter it shows in the conversation while the turn is still running', r.log.includes('second line, not sent yet') && !r.log.includes('got: second line'))
  await shot('5-sent-running')
  await until((x) => x.log.includes('got: second line'))

  // --- one input line: the CLI's prompt box is not drawn, its draft is shown in the card's line ---
  await page.$eval(`${nodeSel} form.node-input input`, (el) => el.blur())
  r = await read()
  check('the card has one input line', r.inputs === 1, `${r.inputs} inputs`)
  check('the CLI’s prompt box is not drawn on the card', !/^\s*>/m.test(r.live) && !r.live.includes('─'.repeat(20)), JSON.stringify(r.live))
  check('its working and status lines are', r.live.includes('auto mode on'), JSON.stringify(r.live))
  check('the dim suggestion in an empty prompt is not taken for a draft', !(r.placeholder ?? '').includes('fix the lint') && !r.mirror, JSON.stringify(r.placeholder))

  // Typed in the pane: the dock sends keystrokes straight to the process, so this does the same.
  board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: 'typed in the pane' }))
  r = await until((x) => x.mirror)
  check('text typed in the pane shows in the card’s own line', r.mirror && r.placeholder === 'typed in the pane', JSON.stringify(r.placeholder))
  check('and not in a second box above it', !r.live.includes('typed in the pane'))
  await shot('6-pane-draft')
  board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\r' }))
  r = await until((x) => x.log.includes('typed in the pane') && !x.mirror)
  check('sent from the pane, it moves from the line to the conversation', r.log.includes('typed in the pane') && !r.mirror)
  await until((x) => x.log.includes('got: typed in the pane'))
  await shot('7-after-pane')
} finally {
  await browser.close()
}

check('the page threw nothing', pageErrors.length === 0, pageErrors.join(' | '))
board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(500)
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
