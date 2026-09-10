/**
 * Proves an image opens as its own card and is served by card id, not by path, so the renderer
 * cannot use the file endpoint to reach anything the server did not already resolve.
 *
 * On a board of its own, with an image it draws itself. It used to open a card on the owner's
 * board pointing at a screenshot in his checkout, and it could only run at all if he happened to
 * have run the capture script recently, since `docs/shots/` is not in the repository.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'
import { pngOfNoise } from './lib/png.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

/*
 * Noise rather than a flat colour, because one assertion below is that the served file is over a
 * kilobyte and a flat image deflates to almost nothing. Sixty-four pixels square of random bytes
 * lands comfortably above it and is still a real PNG that a decoder will accept.
 */
const shot = 'shot.png'
const dir = mkdtempSync(join(tmpdir(), 'garden-image-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch project for the image card test\n')
writeFileSync(join(dir, shot), pngOfNoise(64, 64))

const garden = await startInstance()
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
const st = { projects: [], docs: [] }
ws.on('message', (r) => {
  const m = JSON.parse(String(r))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, docs: m.docs })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'doc.added') st.docs.push(m.card)
})

await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(800)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const project = st.projects[0]
if (!project) { console.log('FAIL  could not add a project'); await garden.stop(); process.exit(1) }

ws.send(JSON.stringify({ t: 'doc.open', projectId: project.id, relPath: shot }))
await sleep(1000)

const card = st.docs.find((d) => d.relPath === shot)
check('the screenshot opened as a card', !!card)
check('it is marked as an image, not text', card?.kind === 'image', `kind=${card?.kind}`)

const res = await fetch(`http://127.0.0.1:${garden.port}/file/${card.id}`)
const buf = Buffer.from(await res.arrayBuffer())
check('the image is served by card id', res.ok && buf.length > 1000, `${buf.length} bytes`)
check('served with an image content type', (res.headers.get('content-type') ?? '').startsWith('image/'),
  res.headers.get('content-type') ?? '')
check('the bytes really are a PNG', buf.subarray(1, 4).toString() === 'PNG')

const bogus = await fetch(`http://127.0.0.1:${garden.port}/file/not-a-real-card-id`)
check('an unknown card id serves nothing', bogus.status === 404, `status ${bogus.status}`)

ws.send(JSON.stringify({ t: 'doc.close', cardId: card.id }))
await sleep(400)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
