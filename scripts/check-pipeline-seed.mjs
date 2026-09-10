/**
 * What the server itself says about the seeded card, asked over the wire.
 *
 * Deliberately `pipeline.get` over the WebSocket rather than importing derivePipeline from
 * server/dist: dist is stale whenever the board is running under tsx watch, and the question here
 * is what the running server would actually send a client, not what a rebuilt copy would compute.
 *
 *   node scripts/check-pipeline-seed.mjs
 */
import WebSocket from 'ws'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STAMP = join(ROOT, 'docs', 'shots', '.pipeline-seed.json')
const PORT = Number(process.env.GARDEN_PORT) || 5178

if (!existsSync(STAMP)) {
  console.log('no seed stamp; run: node scripts/seed-pipeline-runs.mjs')
  process.exit(1)
}
const seed = JSON.parse(readFileSync(STAMP, 'utf8'))

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
const reply = new Promise((resolve) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'pipeline' && m.sessionId === seed.sessionId) resolve(m)
    if (m.t === 'error') console.log('server refused:', m.message, m.forT ?? '')
  })
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await new Promise((r) => setTimeout(r, 500))
ws.send(JSON.stringify({ t: 'pipeline.get', sessionId: seed.sessionId }))

const msg = await Promise.race([reply, new Promise((r) => setTimeout(() => r(null), 5000))])
ws.close()
if (!msg) {
  console.log('no pipeline reply in 5s')
  process.exit(1)
}

const mark = { reached: '+', 'not-reached': '-', unknown: '?' }
for (const run of msg.runs) {
  const open = run.endedAt == null ? 'OPEN ' : 'closed'
  console.log(`\n${open}  ${run.ask}`)
  for (const s of run.stages) {
    // Provenance printed on every stage, not only the reached ones. It is carried on all of them
    // and the client does not currently draw it when a stage is absent, so a wrong value there is
    // invisible on screen and can only be caught by asking the server what it actually sent.
    console.log(`   ${mark[s.state] ?? '!'} ${s.id.padEnd(9)} ${s.state.padEnd(11)} ${String(s.provenance).padEnd(10)} ${s.why || (s.evidence[0]?.detail ?? '')}`)
  }
}
console.log(`\n${msg.runs.length} runs on card ${seed.sessionId}`)
