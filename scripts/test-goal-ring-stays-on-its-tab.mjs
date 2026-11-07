/**
 * Each tab's ring reads that tab's own list, with no card on the board, and creating a list never
 * overwrites one. Canon 26, "One list per board". The owner: "make sure todo.md's are project specific
 * as well". Its own Garden and workspace; the live board is never touched.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ projectName: 'ring-one', files: { 'TODO.md': '- [ ] ONE_ONLY\n' } })
const projects = []
const texts = new Map()
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'project.added') projects.push(m.project)
  if (m.t === 'goal.text') texts.set(m.projectId, m.text)
})
const send = (m) => board.ws.send(JSON.stringify(m))
const addProject = async (dir) => {
  writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
  send({ t: 'project.add', path: dir.replace(/\\/g, '/') })
  await sleep(1800)
  return projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
}
const read = async (id) => {
  texts.delete(id)
  send({ t: 'goal.read', projectId: id })
  await sleep(500)
  return texts.get(id)
}

const dirTwo = mkdtempSync(join(tmpdir(), 'garden-ring-two-'))
writeFileSync(join(dirTwo, 'TODO.md'), '- [ ] TWO_ONLY\n')
const two = await addProject(dirTwo)
const one = board.project

check('the first tab reads its own list, with no card', (await read(one.id))?.includes('ONE_ONLY'))
check('the second tab reads its own', (await read(two.id))?.includes('TWO_ONLY'))
check('and neither sees the other', !(texts.get(two.id) ?? '').includes('ONE_ONLY'))

send({ t: 'goal.create', projectId: one.id })
await sleep(600)
check('creating a list never overwrites one', readFileSync(join(board.dir, 'TODO.md'), 'utf8') === '- [ ] ONE_ONLY\n')

const dirThree = mkdtempSync(join(tmpdir(), 'garden-ring-three-'))
const three = await addProject(dirThree)
check('a tab with no list reads as none', (await read(three.id)) === null)
send({ t: 'goal.create', projectId: three.id })
await sleep(600)
check('creating one writes it at the project root', existsSync(join(dirThree, 'TODO.md')))
check('and the tab reads it', (await read(three.id))?.startsWith('# TO DO'))

// A project whose list lives deeper, which only a document card on the board can point at.
const dirFour = mkdtempSync(join(tmpdir(), 'garden-ring-four-'))
mkdirSync(join(dirFour, 'docs', 'ledger'), { recursive: true })
writeFileSync(join(dirFour, 'docs', 'ledger', 'TODO.md'), '- [ ] DEEP_ONLY\n')
const four = await addProject(dirFour)
send({ t: 'doc.create', projectId: four.id, relPath: 'docs/ledger/TODO.md', openIfExists: true })
await sleep(800)
check('a list held on a document card elsewhere in the project is found', (await read(four.id))?.includes('DEEP_ONLY'))

await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
