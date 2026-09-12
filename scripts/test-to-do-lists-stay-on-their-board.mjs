/**
 * Two projects, two TODO.md files, and nothing crossing between them.
 *
 * The owner: "make sure todo.md's are project specific as well. i dont watn garden/.5 tasks
 * overlapping". He has two boards whose cards are named the same, an Orchestrator on each, so the
 * failure this guards against is not hypothetical: a name is only unique inside a board, and an
 * `@Orchestrator` line means a different card depending on which file it is in.
 *
 * So both projects here get a card with the SAME title and a list of their own, and the test reads
 * each board in turn. Its own Garden, its own workspace. Nothing touches the live board.
 */
import puppeteer from 'puppeteer-core'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// The first board, with a card called Orchestrator and one item for it.
const board = await openBoard({
  projectName: 'todo-one',
  cards: [{ title: 'Orchestrator', roleClass: 'orchestrator' }],
  files: {
    'TODO.md': ['# TODO', '', '- [ ] ONE_ONLY replace the husk check @Orchestrator', ''].join('\n'),
  },
})
const first = board.cards[0]

// A second board on the same server, with a card of the same name and a list of its own.
const state = { projects: [], sessions: [] }
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'project.added') state.projects.push(m.project)
  if (m.t === 'session.added') state.sessions.push(m.session)
})
const dir2 = mkdtempSync(join(tmpdir(), 'garden-todo-two-'))
writeFileSync(join(dir2, 'CLAUDE.md'), '# scratch two\n')
writeFileSync(
  join(dir2, 'TODO.md'),
  ['# TODO', '', '- [ ] TWO_ONLY sweep the inbox @Orchestrator', '- [ ] TWO_ONLY second item @Orchestrator', ''].join('\n'),
)
board.ws.send(JSON.stringify({ t: 'project.add', path: dir2.replace(/\\/g, '/') }))
await sleep(1800)
const second = state.projects.find((p) => p.path.toLowerCase() === dir2.toLowerCase())
check('a second board exists', !!second, second?.name ?? 'none')

board.ws.send(
  JSON.stringify({
    t: 'session.create',
    projectId: second.id,
    adapterId: 'shell',
    title: 'Orchestrator',
    roleClass: 'orchestrator',
    start: false,
  }),
)
await sleep(1200)
const twin = state.sessions.find((s) => s.projectId === second.id)
check('with a card of the same name on it', twin?.title === 'Orchestrator', `${twin?.title} on ${second?.name}`)
check('and it is a different card', twin?.id !== first.id, `${twin?.id?.slice(0, 8)} vs ${first.id.slice(0, 8)}`)

for (const p of [board.project, second]) {
  board.ws.send(JSON.stringify({ t: 'doc.create', projectId: p.id, relPath: 'TODO.md', openIfExists: true }))
  await sleep(1200)
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1700, height: 1100 },
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

/** Switch the board to a project by clicking its tab, then read every to-do bar on screen. */
const openTab = async (name) => {
  const hit = await page.evaluate((want) => {
    const tab = [...document.querySelectorAll('.tab, .projtab, .tabs button')].find((n) =>
      (n.textContent || '').includes(want),
    )
    if (!tab) return false
    tab.click()
    return true
  }, name)
  await sleep(2500)
  return hit
}
const barsOnScreen = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node')]
      .filter((n) => n.querySelector('.todobar'))
      .map((n) => ({
        id: n.getAttribute('data-id') ?? '',
        text: (n.querySelector('.todobar')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        titles: [...n.querySelectorAll('.todobar__item')].map((b) => b.getAttribute('title') ?? ''),
      })),
  )

check('the first board is open', await openTab(board.project.name), board.project.name)
let seen = await barsOnScreen()
let all = seen.map((b) => `${b.text} ${b.titles.join(' ')}`).join(' | ')
check('board one shows its own item', all.includes('ONE_ONLY'), all || 'no bars')
check('and none of board two', !all.includes('TWO_ONLY'), all || 'no bars')
check(
  'the bar belongs to board one card',
  seen.some((b) => b.id === `todobar:${first.id}`),
  seen.map((b) => b.id).join(', '),
)

check('the second board opens', await openTab(second.name), second.name)
seen = await barsOnScreen()
all = seen.map((b) => `${b.text} ${b.titles.join(' ')}`).join(' | ')
check('board two shows its own items', all.includes('TWO_ONLY'), all || 'no bars')
check('and none of board one', !all.includes('ONE_ONLY'), all || 'no bars')
check(
  'its bar belongs to the twin card, not the first',
  seen.some((b) => b.id === `todobar:${twin.id}`) && !seen.some((b) => b.id === `todobar:${first.id}`),
  seen.map((b) => b.id).join(', '),
)

// A tick on the second board must land in the second board's file and leave the first alone.
await page.evaluate((nodeId) => {
  document.querySelector(`.react-flow__node[data-id="${nodeId}"] .todobar__item`)?.click()
}, `todobar:${twin.id}`)
await sleep(2500)
const oneFile = readFileSync(join(board.dir, 'TODO.md'), 'utf8')
const twoFile = readFileSync(join(dir2, 'TODO.md'), 'utf8')
check('the tick landed in board two TODO.md', /- \[x\] TWO_ONLY/.test(twoFile), twoFile.replace(/\n/g, ' / '))
check('and board one TODO.md is untouched', /- \[ \] ONE_ONLY/.test(oneFile), oneFile.replace(/\n/g, ' / '))

check('no page errors', pageErrors.length === 0, pageErrors[0] ?? '')

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
