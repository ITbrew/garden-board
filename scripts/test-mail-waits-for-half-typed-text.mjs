/**
 * A mail notice never joins what the owner is part way through typing. Canon 25. On 2026-11-06 a board
 * check-in landed on "how do i get", and its Enter submitted both.
 *
 * An isolated fake Claude, so its composer can be read exactly and no real session is spent.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoard } from './lib/board.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, description) {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    if (check()) return
    await sleep(100)
  }
  throw new Error(`Timed out: ${description}`)
}
const bin = mkdtempSync(join(tmpdir(), 'garden-mail-draft-'))
const heard = join(bin, 'heard.jsonl')
const submitted = join(bin, 'submitted.jsonl')
writeFileSync(heard, '')
writeFileSync(submitted, '')
writeFileSync(join(bin, 'claude.cmd'), '@node "%~dp0fake-claude.mjs"\r\n')
process.env.PATH = `${bin};${process.env.PATH}`
const board = await openBoard({
  entry: 'tsx',
  projectName: 'mail-draft',
  cards: [{ title: 'Sender', roleClass: 'manager' }, { title: 'Reader', roleClass: 'worker', reportsTo: 0, adapterId: 'claude' }],
})
const [sender, reader] = board.cards
const tokens = new Map()
const statuses = new Map()
board.ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'session.token') tokens.set(m.sessionId, m.token)
  if (m.t === 'session.updated') statuses.set(m.session.id, m.session)
})
const heardText = () => readFileSync(heard, 'utf8')
const sent = () => readFileSync(submitted, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
writeFileSync(join(bin, 'fake-claude.mjs'), `
import {appendFileSync} from 'node:fs';
const hook = async name => fetch('http://127.0.0.1:${board.port}/hook', {
  method:'POST', headers:{'content-type':'application/json'},
  body:JSON.stringify({gardenSessionId:process.env.GARDEN_SESSION_ID,receivedAt:Date.now(),event:{hook_event_name:name,session_id:'draft-fixture'}})
});
let buf='';
const draw = () => process.stdout.write('\\x1b[H\\x1b[2J' + ['● ready','─'.repeat(60),'> '+buf,'─'.repeat(60),'  ⏵⏵ bypass permissions on'].join('\\r\\n'));
process.stdin.setRawMode?.(true); process.stdin.resume();
await hook('SessionStart'); draw();
process.stdin.on('data', async data => {
  const s=data.toString(); appendFileSync(${JSON.stringify(heard)},JSON.stringify(s)+'\\n');
  for(const ch of s){
    if(ch==='\\r'){
      if(buf){ appendFileSync(${JSON.stringify(submitted)},JSON.stringify(buf)+'\\n'); buf=''; await hook('UserPromptSubmit'); setTimeout(()=>hook('Stop'),300); }
    } else if(ch>=' ') buf+=ch;
  }
  draw();
});
`)
const input = (data) => board.ws.send(JSON.stringify({ t: 'session.input', sessionId: reader.id, data }))
const mail = async (text) => {
  const res = await fetch(`http://127.0.0.1:${board.port}/mail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.get(sender.id)}` },
    body: JSON.stringify({ from: sender.id, to: reader.id, kind: 'work', taskId: 'draft-fixture', text }),
  })
  assert.equal(res.status, 200, await res.text())
}
let failed = false
try {
  board.ws.send(JSON.stringify({ t: 'session.token', sessionId: sender.id }))
  await until(() => tokens.has(sender.id), 'sender token')
  board.ws.send(JSON.stringify({ t: 'session.start', sessionId: reader.id }))
  await until(() => !!statuses.get(reader.id)?.pid, 'reader started')
  await sleep(4000)

  input('how do i get')
  await until(() => heardText().includes('how do i get'), 'the half line reached the composer')
  await mail('NOTICE_ONE')
  await sleep(8000)
  assert.ok(!heardText().includes('NOTICE_ONE'), 'the notice stayed out of the half-typed line')
  assert.equal(sent().length, 0, 'nothing was submitted while the owner was typing')
  console.log('PASS a notice waits while a line is half typed')

  input('\r')
  await until(() => sent().length >= 1, 'the owner sends the line')
  assert.equal(sent()[0], 'how do i get', 'the owner\'s line went alone')
  console.log('PASS the owner\'s line goes alone')

  await until(() => heardText().includes('NOTICE_ONE'), 'the notice arrives after the line is sent')
  await until(() => sent().length >= 2, 'the notice is submitted')
  assert.ok(sent()[1].includes('NOTICE_ONE') && !sent()[1].includes('how do i get'), sent()[1])
  console.log('PASS the notice is delivered once the line is sent, on its own')
} catch (e) {
  failed = true
  console.log('FAIL ' + String(e.message).slice(0, 400))
}
await board.stop()
console.log(failed ? '\n1 FAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)
