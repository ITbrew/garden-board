/**
 * Opening a file in the "files it runs from" web must actually show that file, including ones
 * outside the project such as the user-level CLAUDE.md. A card that says "loading" for ever, or
 * shows the wrong file, is worse than not offering it.
 */
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const title = `OpenTest ${Date.now().toString().slice(-5)}`
const board = await openBoard({ cards: [title], projectName: 'web-open-file' })
const UI = board.UI
const project = board.project
const session = board.cards[0]

// `doc.content` is not one of the message types openBoard's own listener tracks, so a second
// listener on the same socket collects it.
const content = {}
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'doc.content') content[m.cardId] = m
})

board.ws.send(JSON.stringify({ t: 'context.open', sessionId: session.id }))
await sleep(2500)
const web = board.state.docs.filter((d) => d.ownerId === session.id)
check('the web opened', web.length >= 3, `${web.length} files`)

// Read every text card in the web and compare against the file on disk.
const texts = web.filter((d) => d.kind === 'text')
for (const card of texts) {
  board.ws.send(JSON.stringify({ t: 'doc.read', cardId: card.id }))
  await sleep(400)
}
await sleep(900)

let matched = 0
let empty = 0
for (const card of texts) {
  const got = content[card.id]
  if (!got || got.error) continue
  const onDisk = card.external
    ? readFileSync(card.relPath, 'utf8')
    : readFileSync(`${project.path}\\${card.relPath.replace(/\//g, '\\')}`, 'utf8')
  if (!got.content.trim()) empty++
  else if (onDisk.slice(0, 200).trim() === got.content.slice(0, 200).trim()) matched++
}
check('every file in the web returned its real contents', matched === texts.length,
  `${matched} of ${texts.length} matched, ${empty} empty`)

const external = texts.find((d) => d.external)
check('a file outside the project opened too', !external || !!content[external.id]?.content,
  external?.relPath ?? 'none in this web')

// And it must actually render in the card, not just arrive over the socket.
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  defaultViewport: { width: 3200, height: 1600 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(`${UI}/`, { waitUntil: 'networkidle2' })
await sleep(3000)

const first = texts[0]
board.ws.send(JSON.stringify({ t: 'doc.setCollapsed', cardId: first.id, collapsed: false }))
await sleep(2000)

const shown = await page.evaluate((t) => {
  const node = [...document.querySelectorAll('.react-flow__node')].find(
    (n) => n.querySelector('.node-title')?.textContent === t,
  )
  const body = node?.querySelector('.doc-body')
  return body ? body.textContent.trim().slice(0, 80) : null
}, first.title)
check('expanding a card in the web shows the file', !!shown && shown !== 'loading', shown ?? 'nothing rendered')

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
