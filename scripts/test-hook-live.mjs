/**
 * Proof that a real CLI, launched the way Garden launches it, actually reaches the receiver.
 *
 * Everything else about the spine can be tested with synthetic payloads, but not this. The whole
 * chain being verified here is outside Garden's control: whether `--settings` merges rather than
 * replaces, whether an installed hook fires at all, and whether the environment variable that
 * ties an event to a card survives the shell, the CLI, and the hook process. Each of those has
 * exactly one honest test, which is to run the real thing and see what arrives.
 *
 * It costs one tiny prompt on the owner's account, and it uses a scratch project it removes
 * afterwards. Run it after any change to the adapter, the installer or the hook script.
 */
import WebSocket from 'ws'
import { exec } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { target } from './lib/target.mjs'
import { seedRealProject } from './lib/live.mjs'

const garden = await target()
const PORT = garden.port
/*
 * A real folder and a real account, on this instance rather than on the owner's board.
 *
 * This test drives an actual Claude CLI, which the server refuses to launch without an account
 * bound to the project. It used to get that by connecting to his live board, where he had set it
 * up by hand, which is why it was one of the last scripts still writing cards onto his work.
 */
await seedRealProject(PORT)
const run = promisify(exec)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'garden-live-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')

const st = { projects: [], sessions: [], events: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'event') st.events.push(m.event)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1200)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  scratch project')
  process.exit(1)
}

const title = `LiveHook ${Date.now().toString().slice(-5)}`
ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title }))
await sleep(2000)
const card = st.sessions.find((s) => s.title === title)
if (!card) {
  console.log('FAIL  scratch card')
  process.exit(1)
}
st.events = []

/*
 * The hooks THIS instance installed, not the owner's.
 *
 * This read `~/.garden/hooks/settings.json`, which is the settings file his own Garden wrote. Once
 * the test got a server of its own that file stopped being the one under test: the instance writes
 * its hooks into its own workspace, so the probe was launching a CLI against one installation and
 * then asking a different one whether it had heard anything. It had not, and the test reported the
 * hook spine as broken when nothing about the spine was involved. Same shape as the database path
 * and the GARDEN_DB fall-through: isolate the workspace and every absolute path into the old one
 * becomes a silent lie.
 */
const settings = join(garden.home, 'hooks', 'settings.json')
console.log('   running a real claude turn against the installed hooks...')
try {
  await run(
    `claude --settings "${settings}" -p "reply with the single word: ok" --max-turns 1`,
    {
      /*
       * The repo, not the scratch directory. This machine has its own account shim that refuses
       * to launch anywhere its account map does not cover, and a temp folder is nowhere. That
       * guard is the owner's and is working correctly, so the probe runs where it is welcome.
       */
      cwd: process.cwd(),
      timeout: 180_000,
      env: {
        ...process.env,
        GARDEN_SESSION_ID: card.id,
        GARDEN_PORT: String(PORT),
        /*
         * C:\Garden belongs to no root in the account map, and the shim refuses rather than
         * guessing, which is correct. This names the account deliberately using the shim's own
         * documented escape hatch, so the probe never picks one by accident.
         */
        CLAUDE_ACCOUNT: process.env.GARDEN_TEST_ACCOUNT || 'personal',
      },
    },
  )
} catch (err) {
  console.log(`   claude exited badly: ${String(err.message).slice(0, 300)}`)
}
await sleep(1500)

const types = st.events.map((e) => e.type)
console.log('   events received:', types.join(', ') || 'none')

check('a real CLI run reaches the receiver', st.events.length > 0, `${st.events.length} events`)
check('every event is attributed to the right card',
  st.events.every((e) => e.sessionId === card.id),
  `${st.events.filter((e) => e.sessionId === card.id).length}/${st.events.length}`)
check('the prompt itself arrives', types.includes('UserPromptSubmit'), types.join(','))
check('so does the end of the turn', types.includes('Stop') || types.includes('SessionEnd'), types.join(','))

const after = st.sessions.find((s) => s.id === card.id)
check('the card learned the CLI session id', !!after?.claudeSessionId, String(after?.claudeSessionId))
check('and where its transcript lives', !!after?.transcriptPath, String(after?.transcriptPath))

ws.send(JSON.stringify({ t: 'session.delete', sessionId: card.id }))
await sleep(400)
ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(600)
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
