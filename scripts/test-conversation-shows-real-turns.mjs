/**
 * A card with a real transcript draws the real conversation, not just an empty state.
 *
 * `test-card-conversation-view.mjs` proves the toggle works, the choice is stored and the pane
 * follows the card. What it does not prove is the thing the feature is for, because its card never
 * ran anything, so every assertion in it is satisfied by the message that says there is nothing to
 * show. A view that is only ever tested empty is a view nobody has checked.
 *
 * So this hands a card an actual Claude Code transcript and reads the words back off the screen.
 * The file is a COPY of one of the owner's own, taken read-only into the test's own temp directory,
 * for two reasons. A synthetic file would only prove Garden agrees with my idea of the format, which
 * is the mistake worth avoiding here; and pointing the test at the original would put his real
 * conversation one bug away from being written to.
 *
 * The transcript reaches the card the way a real one does, through a hook event posted to `/hook`,
 * so `Ingest` learns the path by the same route it always does. Nothing is faked below that line.
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { copyFileSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

/** The most recently written transcript on this machine, whichever project it belongs to. */
function newestTranscript() {
  const root = join(homedir(), '.claude', 'projects')
  let best = null
  for (const dir of readdirSync(root)) {
    let files
    try {
      files = readdirSync(join(root, dir))
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(root, dir, f)
      const st = statSync(p)
      if (st.size < 20_000) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs, size: st.size }
    }
  }
  return best
}

const source = newestTranscript()
check('there is a real transcript on this machine to read', !!source, source ? `${Math.round(source.size / 1024)} KB` : 'none found')
if (!source) process.exit(1)

const garden = await startInstance()
const dir = mkdtempSync(join(tmpdir(), 'garden-realchat-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

// The copy. Everything after this reads the copy and never the original.
const transcript = join(dir, 'conversation.jsonl')
copyFileSync(source.path, transcript)

const state = { projects: [], sessions: [] }
const chats = []
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(state, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') state.projects.push(m.project)
  else if (m.t === 'session.added') state.sessions.push(m.session)
  else if (m.t === 'session.updated') {
    const i = state.sessions.findIndex((s) => s.id === m.session.id)
    if (i >= 0) state.sessions[i] = m.session
  } else if (m.t === 'agent.chat') chats.push(m)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1500)
const project = state.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
check('the scratch project was added', !!project)
if (!project) {
  await garden.stop()
  process.exit(1)
}

const title = `Real ${Date.now().toString().slice(-6)}`
ws.send(
  JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'claude', title, start: false }),
)
await sleep(1500)
const card = state.sessions.find((s) => s.title === title)
check('the card was created', !!card)
if (!card) {
  await garden.stop()
  process.exit(1)
}

// The same route a real hook takes, so `Ingest` learns the path rather than being handed it.
await fetch(`http://127.0.0.1:${garden.port}/hook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    gardenSessionId: card.id,
    receivedAt: Date.now(),
    event: {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'test-claude-session',
      transcript_path: transcript,
      prompt_id: 'p1',
    },
  }),
})
await sleep(1500)

const learned = state.sessions.find((s) => s.id === card.id)
check(
  'the card learned its transcript path from the hook',
  learned?.transcriptPath === transcript,
  learned?.transcriptPath ?? 'null',
)

// --- what the server reads out of it ---

ws.send(JSON.stringify({ t: 'agent.chat', sessionId: card.id }))
await sleep(2500)
const answer = chats[chats.length - 1]
check('the server answered with turns', !!answer && answer.turns.length > 0, `${answer?.turns?.length ?? 0} turns`)
if (answer?.turns?.length) {
  const roles = new Set(answer.turns.map((t) => t.role))
  check(
    'and they are a conversation, not one side of one',
    roles.has('asked') && (roles.has('said') || roles.has('did')),
    [...roles].join(', '),
  )
  const withText = answer.turns.filter((t) => (t.text ?? '').trim().length > 0).length
  check('and they carry text', withText === answer.turns.length, `${withText} of ${answer.turns.length} have text`)

  /*
   * A shortened turn says so, and says it at a place a reader can live with.
   *
   * A blind reviewer reading a card of real turns quoted `console.log(J...` back and called it
   * broken, then quoted `2>&1 ...` and called it merely truncated. The difference is entirely where
   * the cut lands. The same reviewer's other point was that there was no way to reach the rest of a
   * shortened line, which is what `full` is for.
   */
  const shortened = answer.turns.filter((t) => t.text.endsWith('…'))
  check('some turns were long enough to be shortened', shortened.length > 0, `${shortened.length} of ${answer.turns.length}`)
  const missingFull = shortened.filter((t) => !t.full)
  check(
    'every shortened turn carries the whole thing as well',
    missingFull.length === 0,
    `${missingFull.length} shortened turns with nothing behind them`,
  )
  const flat = (s) => s.replace(/\s+/g, ' ').trim()
  const wrongPrefix = shortened.filter((t) => t.full && !flat(t.full).startsWith(t.text.slice(0, -1)))
  check(
    'and what is shown is really the start of what is behind it',
    wrongPrefix.length === 0,
    wrongPrefix.length ? wrongPrefix[0].text.slice(-40) : 'every shortened turn is a prefix of its full text',
  )

  /*
   * Where the cut lands. A command like `node -e "…"` is one unbroken token after its first few
   * characters, so demanding a space would be demanding something that does not exist in the line.
   * What can be demanded is that the cut falls on a seam: a space, or the punctuation such a line is
   * actually jointed at. Anything else is the mid-token cut a reviewer read as a rendering fault.
   */
  const SEAMS = new Set([' ', ',', ';', ':', '=', ')', '/', '\\', '|', '&', '.', "'", '"', '}', ']'])
  const midToken = shortened.filter((t) => {
    const prefix = t.text.slice(0, -1)
    if (!prefix || !t.full) return false
    const whole = flat(t.full)
    // The window the cut had to choose from, and whether it held a usable seam at all. A command
    // with no seam in its second half has nowhere good to break, and a hard cut there is honest.
    const window = whole.slice(0, prefix.length + 40)
    let seam = -1
    for (let i = window.length - 1; i >= 0; i--) {
      if (SEAMS.has(window[i])) {
        seam = i
        break
      }
    }
    if (seam < prefix.length / 2) return false
    // There was a seam available, so the last character kept must be one.
    return !SEAMS.has(prefix.charAt(prefix.length - 1)) && whole.charAt(prefix.length) !== ' '
  })
  check(
    'and none of them was cut in the middle of a token',
    midToken.length === 0,
    midToken.length ? `${midToken.length} bad, e.g. ${midToken[0].text.slice(-40)}` : 'every cut lands on a seam',
  )
  const untruncated = answer.turns.filter((t) => !t.text.endsWith('…') && t.full)
  check(
    'a turn that was not shortened offers nothing extra',
    untruncated.length === 0,
    `${untruncated.length} whole turns carrying a redundant copy`,
  )
}

// --- and what a card actually draws ---

const browser = await puppeteer.launch({
  executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  headless: 'new',
  defaultViewport: { width: 2400, height: 1300 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`http://127.0.0.1:${garden.port}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

const pressed = await page.evaluate((t) => {
  const node = [...document.querySelectorAll('.node')].find(
    (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
  )
  if (!node) return false
  const btn = [...node.querySelectorAll('button')].find((b) => /Show the conversation/.test(b.title || ''))
  if (!btn) return false
  btn.click()
  return true
}, title)
check('the card offers the conversation', pressed)
await sleep(2500)

const drawn = await page.evaluate((t) => {
  const node = [...document.querySelectorAll('.node')].find(
    (n) => n.querySelector('.node-title')?.textContent?.trim() === t,
  )
  const pane = node?.querySelector('.agent-summary')
  if (!pane) return null
  const rows = [...pane.querySelectorAll('.agent-summary__row')]
  return {
    rows: rows.length,
    labels: [...new Set(rows.map((r) => r.querySelector('.agent-summary__label')?.textContent?.trim() ?? ''))],
    text: pane.innerText.trim(),
  }
}, title)

/*
 * With SHOT_DIR set, leave a picture behind for a blind pass.
 *
 * A conversation full of real turns is a visible surface and its failures are visual ones: where a
 * line breaks, whether one turn can be told from the next, whether the text is big enough to read.
 * None of that is checkable from here, so this makes the image for whoever can check it, and writes
 * it wherever it is asked to rather than into the repo, since what is on screen is a real
 * conversation.
 */
if (process.env.SHOT_DIR) {
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Bigger/.test(b.title || ''))?.click())
  await sleep(1500)
  const shot = join(process.env.SHOT_DIR, 'conversation-full.png')
  await page.screenshot({ path: shot })
  console.log('shot:', shot)
}

check('the card drew a conversation pane', !!drawn, drawn ? `${drawn.rows} rows` : 'no pane')
if (drawn) {
  check('with more than one turn in it', drawn.rows > 1, `${drawn.rows} rows`)
  check(
    'labelled as asked and answered',
    drawn.labels.includes('Asked') && (drawn.labels.includes('Said') || drawn.labels.includes('Did')),
    drawn.labels.join(', '),
  )
  check(
    'and showing real words rather than the empty state',
    drawn.text.length > 200 && !drawn.text.startsWith('No transcript path yet'),
    `${drawn.text.length} chars, starts: ${drawn.text.slice(0, 70).replace(/\s+/g, ' ')}`,
  )
}

await browser.close()
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
