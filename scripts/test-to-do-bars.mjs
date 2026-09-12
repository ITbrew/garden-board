/**
 * The to-do list, end to end: one file, a bar above each card, and a tick that reaches the file.
 *
 * Canon 26 is the shape and this is the proof of the parts that could quietly not work. A card's
 * personal list is a VIEW of `TODO.md` rather than a copy, so what matters is not that a chip
 * appears: it is that ticking a chip on a card's bar changes the one file on disk, and that an item
 * addressed to another card never shows up on the wrong bar.
 *
 * The card is made the way the owner makes it, through "Create To Do Card" in the board's own
 * right-click menu, because that is the path he asked for twice and the one nothing else exercises.
 *
 * Its own Garden, its own workspace, serving the BUILT app, so run `npm run build` first.
 */
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// One item for the orchestrator, two for the worker of which one is already done, and one addressed
// to nobody, which belongs to the project and to no card's bar.
const TODO = [
  '# TODO',
  '',
  '- [ ] Replace the husk check in session.start @Orchestrator',
  '- [x] Bump the three package.json files @Worker one',
  '- [ ] Sweep the inbox @Worker one',
  '- [ ] Decide whether the rail keeps two lists',
  '',
].join('\n')

const board = await openBoard({
  projectName: 'todobars',
  cards: [
    { title: 'Orchestrator', roleClass: 'orchestrator' },
    { title: 'Worker one', roleClass: 'worker' },
  ],
  files: { 'TODO.md': TODO },
})
const [orchestrator, workerOne] = board.cards
const todoPath = join(board.dir, 'TODO.md')

const loops = []
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'loops') loops.splice(0, loops.length, ...m.loops)
})

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1900, height: 1300 },
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

// ---------------------------------------------------------------------------
// Created from the board's own menu, on a project whose TODO.md already exists.
// ---------------------------------------------------------------------------
check('no bar before there is a To Do card', !(await page.$('.todobar')))
await page.mouse.click(1500, 1000, { button: 'right' })
await sleep(600)
const clicked = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].find((n) =>
    (n.textContent || '').trim().startsWith('Create To Do Card'),
  )
  if (!b) return false
  b.click()
  return true
})
check('Create To Do Card is in the board menu', clicked)
await sleep(2500)

const barOf = (id) =>
  page.evaluate((nodeId) => {
    const n = document.querySelector(`.react-flow__node[data-id="${nodeId}"] .todobar`)
    if (!n) return null
    return {
      count: n.querySelector('.todobar__count')?.textContent?.trim() ?? '',
      items: [...n.querySelectorAll('.todobar__item')].map((b) => b.textContent.trim()),
      fill: n.querySelector('.todobar__fill')?.getAttribute('style') ?? '',
      loop: !!n.querySelector('.todobar__loop'),
      top: Math.round(n.getBoundingClientRect().top),
      left: Math.round(n.getBoundingClientRect().left),
      width: Math.round(n.getBoundingClientRect().width),
    }
  }, id)

const topOf = (id) =>
  page.evaluate((nodeId) => {
    const n = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
    if (!n) return null
    const r = n.getBoundingClientRect()
    return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) }
  }, id)

const main = await barOf('todobar:main')
check('the To Do card has a progress bar', !!main, main ? `${main.count} filled ${main.fill}` : 'no bar')
check('and it counts the whole list', main?.count === '1/4', String(main?.count))

const orch = await barOf(`todobar:${orchestrator.id}`)
const worker = await barOf(`todobar:${workerOne.id}`)
check('the orchestrator has a bar of its own', orch?.count === '0/1', String(orch?.count))
check('and the worker has a different one', worker?.count === '1/2', String(worker?.count))
check(
  'a card sees only the items addressed to it',
  orch?.items.join(' ').includes('husk') &&
    !orch?.items.join(' ').includes('inbox') &&
    !orch?.items.join(' ').includes('rail keeps two lists'),
  (orch?.items ?? []).join(' | '),
)
check('and the tag itself is not drawn as part of the item', !(orch?.items.join(' ') ?? '').includes('@'), (orch?.items ?? []).join(' | '))

// ---------------------------------------------------------------------------
// Above the card, at the card's own width, which is the placement he asked for.
// ---------------------------------------------------------------------------
const cardBox = await topOf(orchestrator.id)
check('the bar sits above its card', !!cardBox && !!orch && orch.top < cardBox.top, `bar ${orch?.top}, card ${cardBox?.top}`)
check('and is the same width as it', !!cardBox && !!orch && Math.abs(orch.width - cardBox.width) <= 2, `bar ${orch?.width}, card ${cardBox?.width}`)

// ---------------------------------------------------------------------------
// A tick reaches the file, which is what makes the list one list.
// ---------------------------------------------------------------------------
await page.evaluate((nodeId) => {
  document.querySelector(`.react-flow__node[data-id="${nodeId}"] .todobar__item`)?.click()
}, `todobar:${orchestrator.id}`)
await sleep(2500)
const onDisk = readFileSync(todoPath, 'utf8')
check('ticking a chip wrote to TODO.md', /- \[x\] Replace the husk check/.test(onDisk),
  onDisk.split('\n').find((l) => l.includes('husk')) ?? '')
check('and left every other line alone',
  onDisk.includes('- [ ] Sweep the inbox @Worker one') && onDisk.includes('# TODO'),
  onDisk.replace(/\n/g, ' / '))

const after = await barOf(`todobar:${orchestrator.id}`)
check('the bar caught up with the file', after?.count === '1/1', String(after?.count))

// ---------------------------------------------------------------------------
// The loop, which is an ordinary loop row so the rail owns it from then on.
// ---------------------------------------------------------------------------
check('a card with items and no loop is offered one', worker?.loop === true, String(worker?.loop))
await page.evaluate((nodeId) => {
  document.querySelector(`.react-flow__node[data-id="${nodeId}"] .todobar__loop`)?.click()
}, `todobar:${workerOne.id}`)
await sleep(2000)
const made = loops.find((l) => l.sessionId === workerOne.id)
check('pressing Loop made a real loop row', !!made, made ? `${made.minutes} min, enabled ${made.enabled}` : 'none')
check('its prompt points the card at its own items and says how to stop',
  !!made && made.prompt.includes('@Worker one') && made.prompt.includes('--off --card "Worker one"'),
  made?.prompt ?? '')
check('and it shows up in the rail Loops section',
  await page.evaluate(() => [...document.querySelectorAll('.rail-loop__card')].some((n) => n.textContent.trim() === 'Worker one')))

check('no page errors', pageErrors.length === 0, pageErrors[0] ?? '')

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
