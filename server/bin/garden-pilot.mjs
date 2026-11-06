#!/usr/bin/env node
/*
 * An orchestrator's hands on its own board. docs/canonical/28-the-orchestrator-runs-the-board.md.
 *
 *   node <this> --answer <card title or id> <option>   answer the prompt on that card's screen with
 *                                                      one of the options it offers, by number
 *   node <this> --hold                                 hold the board: start nothing, hand out nothing
 *   node <this> --go                                   let the board flow again
 *
 * Every refusal comes from the server with its reason: it answers only while the card's screen shows
 * a prompt, only with an option that prompt offers, and only on the caller's own board. This file
 * grants nothing. An orchestrator card uses it by its own token, the owner by his key (with
 * --project <id>, since he has no board of his own).
 */
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.GARDEN_PORT) || 5178
const fail = (m) => {
  process.stderr.write(`${m}\n`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const at = (name) => argv.indexOf(`--${name}`)
const has = (name) => at(name) >= 0
const projectId = has('project') ? argv[at('project') + 1] : undefined

let msg
if (has('answer')) {
  const i = at('answer')
  const card = argv[i + 1]
  const option = Number(argv[i + 2])
  if (!card || !Number.isInteger(option)) fail('usage: --answer "<card title>" <option number>')
  msg = { op: 'answer', card, option, projectId }
} else if (has('hold')) msg = { op: 'hold', projectId }
else if (has('go')) msg = { op: 'go', projectId }
else fail('usage: --answer "<card title>" <option> | --hold | --go')

function ownerKey() {
  try {
    return readFileSync(join(process.env.GARDEN_HOME || join(homedir(), '.garden'), 'owner.key'), 'utf8').trim() || null
  } catch {
    return null
  }
}

const token = process.env.GARDEN_SESSION_TOKEN
const key = token ? null : ownerKey()
if (!token && !key) fail('This terminal was not started by Garden and there is no owner key to read.')

const body = JSON.stringify(msg)
const headers = {
  'content-type': 'application/json',
  'content-length': Buffer.byteLength(body),
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...(key ? { 'x-garden-owner-key': key } : {}),
}
const req = request({ host: '127.0.0.1', port: PORT, path: '/pilot', method: 'POST', headers }, (res) => {
  let out = ''
  res.on('data', (c) => (out += c))
  res.on('end', () => {
    if (res.statusCode !== 200) {
      let reason = out
      try {
        reason = JSON.parse(out).reason ?? out
      } catch {}
      fail(`Refused: ${reason}`)
    }
    try {
      process.stdout.write(`${JSON.stringify(JSON.parse(out), null, 2)}\n`)
    } catch {
      process.stdout.write(`${out}\n`)
    }
    process.exit(0)
  })
})
req.on('error', (e) => fail(`Garden is not answering on port ${PORT}: ${e.message}`))
req.end(body)
