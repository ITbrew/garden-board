/*
 * Press this machine's Restart server button, from a card.
 *
 * NOT `garden-restart.mjs`, which sits beside this file. That one is the detached helper the server
 * launches for itself and which a card has no reason to run. This one is the client: it sends the
 * board the exact message the button sends, and the server then launches that helper. If you are
 * reading one of these wondering which you want, a card wants this one.
 *
 *   node "%GARDEN_BIN%\garden-restart-board.mjs"
 *
 * Written by the PC1 Orchestrator on 2026-09-18 and moved here from a skill directory, because a
 * skill's files only reach cards whose PROJECT is that checkout, and every card on both boards has
 * a different project. GARDEN_BIN is set by the server from its own location, so this path carries
 * no drive letter and is correct on either machine. The prose for it is the `board-restart` skill.
 *
 * **Only on the owner's word.** This ends every card on the board, including the one that ran it.
 * The cards that were running come back with revive; their work in flight does not. Say what needs
 * saying, and write your notes, BEFORE the send.
 *
 * Uses the WebSocket built into Node 22+ deliberately, so it needs no node_modules and runs from any
 * directory. It only ever reaches 127.0.0.1, which is this machine's own board and never the other
 * PC's.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The board's port, the same variable the rest of Garden reads, so a board on a non-default port is
// reachable without editing this file.
const PORT = Number(process.env.GARDEN_PORT) || 5178

// Read, never printed. A hello that proves nothing is a guest, and a guest cannot press this.
let key
try {
  key = readFileSync(join(homedir(), '.garden', 'owner.key'), 'utf8').trim()
} catch (e) {
  console.log(`no owner key to send: ${e.code ?? ''} ${String(e.message).split('\n')[0]}`.trim())
  console.log('The server writes it as it starts. Without it this connects as a guest, and a guest')
  console.log('cannot restart the board. Nothing was sent.')
  process.exit(1)
}

// The /ws path matters: a socket to the bare port is refused with a 400 and nothing is sent.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
const t = setTimeout(() => {
  console.log('timeout, no reply')
  process.exit(2)
}, 8000)

ws.onopen = () => {
  ws.send(JSON.stringify({ t: 'hello', key }))
  setTimeout(() => {
    ws.send(JSON.stringify({ t: 'server.restart' }))
    console.log('server.restart sent')
  }, 500)
}
ws.onmessage = (m) => {
  console.log('reply:', String(m.data).slice(0, 200))
}
ws.onerror = (e) => {
  console.log('error:', e.message ?? e)
}
// The socket closing IS the backend going down. That is the expected ending, not a failure.
ws.onclose = (e) => {
  console.log('closed', e.code)
  clearTimeout(t)
  process.exit(0)
}
