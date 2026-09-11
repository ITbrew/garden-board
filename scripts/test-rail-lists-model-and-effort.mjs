/**
 * The rail says what each card is running as, in two lists that partition the board.
 *
 * The owner asked for both halves at once: "i want garden running now list to show the model that
 * card is currently running in and effort level. also create list of offline cards for the project.
 * so left bar would show running now list, underneath it offline list. both sections show the
 * current model/effort level for easier reference".
 *
 * What would go red before the change:
 *
 *   - there is no Offline heading, and no second list under Running now.
 *   - a rail row is one line, so no row names a model or an effort at all.
 *
 * Two halves, because they fail differently. The first is the wording, which is a pure function and
 * is checked here without a browser, exactly and cheaply: a choice must not read as an observation
 * and a stopped card must not claim to be running one. The second is the lists, which needs the real
 * DOM, and is checked by starting one card and leaving another off and reading which list each
 * lands in.
 *
 * Runs against a board of its own, on its own port, with its own workspace. The one card it starts
 * is a shell, so nothing here spends tokens.
 */
import puppeteer from 'puppeteer-core'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard } from './lib/board.mjs'

/*
 * The source rather than a build. `@garden/shared` publishes `./src/index.ts` and emits only
 * declarations, so there is no JavaScript to import and Node strips the types on the way in. This
 * therefore reads the same file the app compiles rather than a copy that could be stale.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { modelAndEffort } = await import(
  `file://${join(ROOT, 'packages', 'shared', 'src', 'index.ts').replace(/\\/g, '/')}`
)

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// --- the wording, which is the part that can lie ---

/** A card with nothing said about it, which every field below then overrides. */
const card = (over) => ({
  kind: 'session',
  pid: 1234,
  status: 'idle',
  exitedAt: null,
  model: null,
  modelChoice: null,
  effort: null,
  effortChoice: null,
  ...over,
})

/*
 * Bare, at the owner's instruction, twice: "remove the words 'running' from 'running opus-5'
 * 'running high effort'", then "do the same for 'last'". A row names the model and the effort and
 * says nothing about whether a process is behind them, which is what the status dot beside it and
 * the heading above it are for.
 */
const running = modelAndEffort(card({ model: 'claude-opus-5', effort: 'high' }))
check('a running card names its model bare', running.model === 'opus-5', running.model)
check('and its effort with no prefix either', running.effort === 'high effort', running.effort)

/*
 * A stopped card reads exactly the same, which is the point of removing both prefixes: no row makes
 * a claim about liveness in either direction, so none of them can be wrong about it.
 */
const stopped = modelAndEffort(card({ pid: null, status: 'stopped', model: 'claude-opus-5', effort: 'high' }))
check('a stopped card names the same thing with no prefix',
  stopped.model === 'opus-5' && stopped.effort === 'high effort',
  `${stopped.model} · ${stopped.effort}`)

const chosen = modelAndEffort(card({ pid: null, status: 'stopped', modelChoice: 'sonnet-5', effortChoice: 'medium' }))
check('a card that has only been chosen for reads as the choice',
  chosen.model === 'sonnet-5' && chosen.effort === 'medium',
  `${chosen.model} · ${chosen.effort}`)

const pending = modelAndEffort(card({ model: 'claude-opus-5', modelChoice: 'sonnet-5', effort: 'high', effortChoice: 'low' }))
check('a choice the running process has not taken up is pending',
  pending.model === 'sonnet-5 pending' && pending.effort === 'low pending',
  `${pending.model} · ${pending.effort}`)

const silent = modelAndEffort(card({}))
check('and a card with neither says default rather than naming one',
  silent.model === 'default model' && silent.effort === 'default effort',
  `${silent.model} · ${silent.effort}`)

// --- the two lists, on a real board ---

const board = await openBoard({
  projectName: 'rail',
  cards: [{ title: 'Awake' }, { title: 'Asleep' }, { title: 'Never started' }],
})

const [awake, asleep] = board.cards
board.ws.send(JSON.stringify({ t: 'session.setRole', sessionId: asleep.id, modelChoice: 'opus-5', effortChoice: 'high' }))
await sleep(400)
board.ws.send(JSON.stringify({ t: 'session.start', sessionId: awake.id }))
await sleep(2500)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1600, height: 1200, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.stack || String(e)))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

/** Each rail section by its heading, with the rows under it as the text of each line. */
const sections = await page.evaluate(() =>
  [...document.querySelectorAll('.rail-section')].map((sec) => ({
    title: sec.querySelector('.rail-title')?.textContent?.trim() ?? '',
    rows: [...sec.querySelectorAll('li .row--card')].map((row) => ({
      label: row.querySelector('.row-label')?.textContent?.trim() ?? '',
      sub: row.querySelector('.row-sub')?.textContent?.trim() ?? '',
    })),
  })),
)

const live = sections.find((s) => s.title === 'Running now')
const offline = sections.find((s) => s.title === 'Offline')

check('there is an Offline section', !!offline, sections.map((s) => s.title).join(' | '))
check('and it is directly under Running now',
  !!live && !!offline && sections.indexOf(offline) === sections.indexOf(live) + 1,
  sections.map((s) => s.title).join(' | '))

const liveTitles = (live?.rows ?? []).map((r) => r.label)
const offlineTitles = (offline?.rows ?? []).map((r) => r.label)
check('the card that was started is in Running now', liveTitles.includes('Awake'), liveTitles.join(', '))
check('and the two that were not are Offline',
  offlineTitles.includes('Asleep') && offlineTitles.includes('Never started'),
  offlineTitles.join(', '))
/*
 * The pair. Both lists read the same `pid`, so a card appearing in both would mean they had started
 * deciding separately, which is how the board and the server once disagreed about what was drawn.
 */
check('and no card is in both lists',
  liveTitles.every((t) => !offlineTitles.includes(t)),
  `${liveTitles.join(', ')} / ${offlineTitles.join(', ')}`)

const everyRowSaysSomething = [...(live?.rows ?? []), ...(offline?.rows ?? [])]
check('every row in both lists names a model and an effort',
  everyRowSaysSomething.length >= 3 && everyRowSaysSomething.every((r) => /\S · \S/.test(r.sub)),
  everyRowSaysSomething.map((r) => `${r.label}: ${r.sub}`).join(' | '))

const asleepRow = (offline?.rows ?? []).find((r) => r.label === 'Asleep')
check('an offline card shows the choice it will start on',
  asleepRow?.sub === 'opus-5 · high',
  asleepRow?.sub ?? 'no row')

const neverRow = (offline?.rows ?? []).find((r) => r.label === 'Never started')
check('and one that was never told says default rather than guessing',
  neverRow?.sub === 'default model · default effort',
  neverRow?.sub ?? 'no row')

/*
 * The ceiling panel's yes or no control has to fit the word it is showing.
 *
 * It was given the same 52px width as the number inputs beside it, which forgot that a select draws
 * its own dropdown arrow inside that box. The arrow took the right-hand third and the word was
 * clipped: "the word 'yes' is cut off for Subagents allowe section".
 *
 * Measured rather than looked at, because a clipped word photographs as a shorter word and reads as
 * deliberate.
 *
 * The text is drawn into a canvas with the control's own computed font and compared against the
 * content box, which is the box minus its padding. That is the right comparison now that the caret
 * is drawn in the right-hand padding rather than by the browser inside the content: whatever the
 * caret costs is already subtracted, so any room left over is room the word actually gets.
 */
const choiceFit = await page.evaluate(() => {
  const sel = document.querySelector('.rail-limit-row__choice')
  if (!sel) return null
  const style = getComputedStyle(sel)
  const ctx = document.createElement('canvas').getContext('2d')
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`
  const text = sel.options[sel.selectedIndex]?.text ?? ''
  return {
    text,
    textWidth: ctx.measureText(text).width,
    inner:
      sel.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0'),
  }
})
check('the yes or no control has room for its word and its caret',
  !!choiceFit && choiceFit.inner - choiceFit.textWidth >= 3,
  choiceFit
    ? `"${choiceFit.text}" needs ${choiceFit.textWidth.toFixed(1)}px, the box has ${choiceFit.inner.toFixed(1)}px`
    : 'no choice control found')

/*
 * And it is the same box as the ones beside it: "make 'yes' drop down size in line with the other
 * buttons, doesnt look right". The first fix for the clipping widened it, which stopped the clipping
 * and broke the column, so this holds both halves at once. Measured to the pixel, because a column
 * being a few pixels out is exactly the kind of thing that reads as wrong without being nameable.
 */
const column = await page.evaluate(() => {
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const sel = document.querySelector('.rail-limit-row__choice')
  const inputs = [...document.querySelectorAll('.rail-limit-row input')]
  return sel && inputs.length ? { choice: box(sel), inputs: inputs.map(box) } : null
})
check('the yes or no control is the same box as the numbers beside it',
  !!column &&
    column.inputs.every((i) => i.w === column.choice.w && i.left === column.choice.left && i.right === column.choice.right),
  column
    ? `choice ${column.choice.w}px at ${column.choice.left}, inputs ${column.inputs.map((i) => `${i.w}px at ${i.left}`).join(', ')}`
    : 'nothing to measure')

check('no page errors', pageErrors.length === 0, pageErrors[0] ?? '')

await browser.close()
await board.stop()
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
