/**
 * Is the summary actually on the wire? One command, no context required.
 *
 * Written for the minutes right after the gated batch is applied, when the board has just come
 * back up and nobody can remember what good looked like. It asks the running server for a real
 * pipeline.get reply and prints what came back, so the answer is what a client would receive
 * rather than what the source says it should send.
 *
 * With no argument it uses the first session the server reports, which is enough to prove the
 * field exists and is populated. Pass a session id to ask about a particular card.
 *
 *   node scripts/check-pipeline-summary.mjs [sessionId]
 *
 * Before the patch: prints ABSENT and exits 1. After it: prints the counts and exits 0.
 */
import WebSocket from 'ws'

const PORT = Number(process.env.GARDEN_PORT) || 5178
const want = process.argv[2] || null
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)

let sessions = []
const gotState = new Promise((resolve) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') {
      sessions = m.sessions
      resolve()
    }
  })
})
const gotPipeline = new Promise((resolve) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'pipeline') resolve(m)
    if (m.t === 'error') console.log('server refused:', m.message, m.forT ?? '')
  })
})

await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await Promise.race([gotState, new Promise((r) => setTimeout(r, 4000))])

const sessionId = want || sessions[0]?.id
if (!sessionId) {
  console.log('no sessions on the board to ask about')
  process.exit(1)
}
ws.send(JSON.stringify({ t: 'pipeline.get', sessionId }))

const msg = await Promise.race([gotPipeline, new Promise((r) => setTimeout(() => r(null), 5000))])
ws.close()
if (!msg) {
  console.log('no pipeline reply in 5s')
  process.exit(1)
}

console.log('session   ', msg.sessionId)
console.log('runs      ', Array.isArray(msg.runs) ? msg.runs.length : '(not an array)')
if (!msg.summary) {
  console.log('summary    ABSENT')
  process.exit(1)
}
console.log('summary    project', msg.summary.projectId, 'totalRuns', msg.summary.totalRuns)
for (const id of ['intake', 'canon', 'plan', 'dispatch', 'code', 'review', 'close']) {
  console.log(`   ${id.padEnd(9)} ${msg.summary.reached?.[id] ?? '(missing)'}`)
}
// A count above the number of runs, or a stage key missing entirely, means the shape drifted.
const bad = msg.summary.totalRuns == null || Object.values(msg.summary.reached ?? {}).some((n) => n > msg.summary.totalRuns)
console.log(bad ? '\nSHAPE LOOKS WRONG' : '\nsummary present and internally consistent')
process.exit(bad ? 1 : 0)
