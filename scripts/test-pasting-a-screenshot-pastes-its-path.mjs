/**
 * Ctrl+V with a screenshot on the clipboard pastes the saved image's path. Canon 03, "Pasting a
 * screenshot".
 *
 * The owner: "when i screen shot i can cntrl+v into a terminal and it pastes the path for the image".
 * What is held here:
 *
 * - Into a card's input line: the image is saved under the board's own `pastes` folder, byte for
 *   byte, and its path appears in the line, sent to nothing until Enter.
 * - Into an open dock terminal: the same, and the path is typed into the process.
 * - A clipboard with text on it is left alone, so text still pastes as text.
 *
 * The paste is a real ClipboardEvent carrying a real PNG, dispatched where Ctrl+V would land it.
 * Its own Garden on its own port and workspace, serving the BUILT app: run `npm run build` first.
 * Screenshots go to SHOT_DIR when it is set.
 */
import puppeteer from 'puppeteer-core'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// A real 2x2 PNG, so what is saved can be compared byte for byte.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=='

// A program that prints every byte it receives, so a stray ^V (0x16) is visible rather than
// swallowed by a shell's line editor.
const ECHO = `process.stdin.setRawMode(true); process.stdin.resume(); console.log('echo ready');
process.stdin.on('data', (d) => { const s = d.toString('latin1'); if (s.includes('\x03')) process.exit(0);
  console.log('GOT ' + [...s].map((c) => c.charCodeAt(0) < 32 ? '^' + String.fromCharCode(c.charCodeAt(0) + 64) : c).join('')) })`
const board = await openBoard({ projectName: 'paste', cards: [{ title: 'Paster' }], files: { 'echo.mjs': ECHO } })
const [card] = board.cards
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: card.id }))
await sleep(5000)
// ConPTY holds the first input while it waits for an answer nobody here gives; this Enter is spent on it.
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\r' }))
await sleep(800)

const scrollback = () =>
  new Promise((resolve) => {
    const on = (raw) => {
      const m = JSON.parse(String(raw))
      if (m.t !== 'session.scrollback' || m.sessionId !== card.id) return
      board.ws.off('message', on)
      resolve(m.data)
    }
    board.ws.on('message', on)
    board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: card.id }))
  })

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1600,1000', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
})
const pageErrors = []

/** Dispatch a paste carrying the PNG (and optionally text) on whatever `selector` finds. */
const paste = (page, selector, withText = null) =>
  page.evaluate(
    (sel, b64, text) => {
      const el = document.querySelector(sel)
      if (!el) return { found: false }
      el.focus()
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      if (text) dt.setData('text/plain', text)
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      el.dispatchEvent(ev)
      return { found: true, prevented: ev.defaultPrevented }
    },
    selector,
    PNG_B64,
    withText,
  )

try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(board.UI, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.react-flow__node', { timeout: 20000 })
  await sleep(2000)
  const inputSel = `.react-flow__node[data-id="${card.id}"] form.node-input input`

  // --- the card's input line ---
  const before = await scrollback()
  const r1 = await paste(page, inputSel)
  let value = ''
  for (let i = 0; i < 20 && !value.includes('paste-'); i++) {
    await sleep(250)
    value = await page.$eval(inputSel, (el) => el.value)
  }
  check('pasting a screenshot into a card’s line was taken as an image', r1.found && r1.prevented, JSON.stringify(r1))
  check('its path is in the line', /pastes[\\/]paste-[\w-]+\.png$/.test(value), JSON.stringify(value))
  const saved = value.replace(/^"|"$/g, '')
  check('under this board’s own pastes folder', saved.toLowerCase().startsWith(join(board.home, 'pastes').toLowerCase()), saved)
  check('and the file is the image, byte for byte', existsSync(saved) && readFileSync(saved).equals(Buffer.from(PNG_B64, 'base64')))
  await sleep(800)
  check('nothing was sent to the terminal before Enter', !(await scrollback()).slice(before.length).includes('paste-'))
  if (process.env.SHOT_DIR) await (await page.$(`.react-flow__node[data-id="${card.id}"]`)).screenshot({ path: join(process.env.SHOT_DIR, 'paste-card-line.png') })

  // --- text on the clipboard is left to paste as text ---
  const r2 = await paste(page, inputSel, 'plain words')
  check('a clipboard with text on it pastes as text, not as an image', r2.found && !r2.prevented, JSON.stringify(r2))

  // --- an open dock terminal ---
  const opened = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.rail-section .row')].find((b) => b.textContent?.includes('Paster'))
    row?.click()
    return !!row
  })
  await sleep(2500)
  const beforeDock = await scrollback()
  const r3 = await paste(page, '.dock-pane .xterm-helper-textarea')
  check('a terminal is open in the dock to paste into', opened && r3.found, JSON.stringify(r3))
  let typed = ''
  for (let i = 0; i < 20 && !typed.includes('paste-'); i++) {
    await sleep(300)
    typed = (await scrollback()).slice(beforeDock.length)
  }
  check('pasting a screenshot into the terminal types its path into the process', /pastes[\\/]paste-[\w-]+\.png/.test(typed), JSON.stringify(typed.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(0, 160)))
  if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, 'paste-dock.png') })

  // --- Ctrl+V itself, the key he presses, with a screenshot on the browser's clipboard ---
  board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\x03' }))
  await sleep(400)
  board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: 'node "' + join(board.dir, 'echo.mjs') + '"' + String.fromCharCode(13) }))
  for (let i = 0; i < 20 && !(await scrollback()).includes('echo ready'); i++) await sleep(300)
  await page.browserContext().overridePermissions(board.UI, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
  const onClipboard = await page.evaluate(async (b64) => {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
      return true
    } catch (e) {
      return String(e)
    }
  }, PNG_B64)
  check('a screenshot is on the browser’s clipboard for the test', onClipboard === true, String(onClipboard))
  await page.focus('.dock-pane .xterm-helper-textarea')
  const beforeKey = await scrollback()
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyV')
  await page.keyboard.up('Control')
  // The whole screen, not a slice after the old length: a running card's snapshot is its serialized
  // screen (canon 03 revision 17), which does not only grow. The GOT lines exist only after Ctrl+V.
  void beforeKey
  const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r?\n/g, '\n')
  let got = ''
  for (let i = 0; i < 20 && !/GOT .*paste-/.test(got); i++) {
    await sleep(300)
    got = plain(await scrollback()).split('\n').filter((l) => l.startsWith('GOT ')).join('\n')
  }
  check('Ctrl+V is not sent to the program as a ^V', !got.includes('GOT ^V'), JSON.stringify(got.slice(0, 160)))
  check('Ctrl+V with a screenshot types its path into the terminal', /GOT .*pastes[\\/]paste-[\w-]+\.png/.test(got), JSON.stringify(got.slice(0, 200)))
  board.ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\x03' }))
} finally {
  await browser.close()
}

check('the page threw nothing', pageErrors.length === 0, pageErrors.join(' | '))
board.ws.send(JSON.stringify({ t: 'session.stop', sessionId: card.id }))
await sleep(500)
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
