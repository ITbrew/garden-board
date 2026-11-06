#!/usr/bin/env node
/*
 * The Keeper's hands. docs/canonical/27-the-overseer.md, stage 3.
 *
 *   node <this> --findings                         the live Health list
 *   node <this> --finding <id>                     one finding, with its evidence
 *   node <this> --card <title or id>               status, unread mail, the line Garden typed and is
 *                                                  waiting on, its last events and terminal tail
 *   node <this> --machine                          CPU, free memory and what is using the CPU now
 *   node <this> --handled <id> --note-file <path>  record what was done about a finding
 *   node <this> --escalate <id> --note-file <path> record that it was passed on, and to whom
 *   node <this> --enter <title or id>              press Enter on a line Garden typed and never sent
 *   node <this> --resume <title or id>             start a card the watchdog saw crash, once
 *
 * Every refusal comes from the server with its reason; the conditions are checked there, not here,
 * so this file grants nothing. Only the card titled Keeper may use it, by its own token, or the owner
 * by his key. A note is read from a file because the Keeper's shell refuses separators and quotes
 * that a sentence of prose will contain.
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
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i < 0 ? undefined : (argv[i + 1] ?? '')
}
const has = (name) => argv.includes(`--${name}`)

let msg
if (has('findings')) msg = { op: 'findings' }
else if (has('finding')) msg = { op: 'finding', id: flag('finding') }
else if (has('card')) msg = { op: 'card', card: flag('card') }
else if (has('machine')) msg = { op: 'machine' }
else if (has('enter')) msg = { op: 'enter', card: flag('enter') }
else if (has('resume')) msg = { op: 'resume', card: flag('resume') }
else if (has('handled') || has('escalate')) {
  const op = has('handled') ? 'handled' : 'escalate'
  const file = flag('note-file')
  let note = flag('note')
  if (file) {
    try {
      note = readFileSync(file, 'utf8')
    } catch (e) {
      fail(`could not read ${file}: ${e.message}`)
    }
  }
  if (!note || !note.trim()) fail(`--${op} needs --note-file <path> saying what was done`)
  msg = { op, id: flag(op), note }
} else {
  fail('usage: --findings | --finding <id> | --card <card> | --machine | --handled <id> --note-file <f> | --escalate <id> --note-file <f> | --enter <card> | --resume <card>')
}

function ownerKey() {
  try {
    return readFileSync(join(process.env.GARDEN_HOME || join(homedir(), '.garden'), 'owner.key'), 'utf8').trim() || null
  } catch {
    return null
  }
}

const token = process.env.GARDEN_SESSION_TOKEN
// A card sends its token and never the key: the key is the owner's, for a terminal he runs himself.
const key = token ? null : ownerKey()
if (!token && !key) fail('This terminal was not started by Garden and there is no owner key to read.')

const body = JSON.stringify(msg)
const headers = {
  'content-type': 'application/json',
  'content-length': Buffer.byteLength(body),
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...(key ? { 'x-garden-owner-key': key } : {}),
}
const req = request({ host: '127.0.0.1', port: PORT, path: '/keeper', method: 'POST', headers }, (res) => {
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
