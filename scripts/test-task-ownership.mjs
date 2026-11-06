/**
 * Task ownership, driven the way a card drives it.
 *
 * Every assertion here goes through the shims with `GARDEN_SESSION_ID` and `GARDEN_SESSION_TOKEN`
 * in a child process's environment, because that is the only thing a card can actually reach. A
 * test that called the store directly would prove the rules are written and not that they are
 * wired, and the whole failure this feature exists to stop was a rule that was written down in
 * three places and enforced in none.
 *
 * The failing case comes first for every rule, on purpose. A guard that has never refused anything
 * is indistinguishable from a guard that is not running, and this board has shipped one of those
 * before: a test that passed for the wrong reason is worse than no test, because it is evidence.
 *
 * Its own instance, its own port, its own GARDEN_HOME and its own database. Nothing it does can
 * reach the owner's board. The home directory is made here rather than by `startInstance`, because
 * the last assertion is about a restart and a restart needs the same workspace opened twice; the
 * script that passes the directory owns cleaning it up.
 *
 * Needs `npm run build` first: the instance launches the built server, not the TypeScript.
 */
import WebSocket from 'ws'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startInstance } from './lib/instance.mjs'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let skipped = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + String(d).replace(/\s+/g, ' ').slice(0, 150) : ''}`)
  if (!ok) failures++
}

const home = mkdtempSync(join(tmpdir(), 'garden-own-home-'))
const dir = mkdtempSync(join(tmpdir(), 'garden-own-proj-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
mkdirSync(join(dir, 'server', 'src'), { recursive: true })
mkdirSync(join(dir, 'apps', 'web'), { recursive: true })
writeFileSync(join(dir, 'server', 'src', 'store.ts'), '// mine\n')
writeFileSync(join(dir, 'apps', 'web', 'App.tsx'), '// somebody else\n')
writeFileSync(join(dir, 'ORDER.md'), 'Finish the loader and say what you checked.\n')
const bodyFile = join(dir, 'message.md')

let garden = await startInstance({ home })
let PORT = garden.port

/*
 * The owner key, read off disk rather than scraped out of the log.
 *
 * A connection with no key is treated as the owner only while nothing on the board is enforcing,
 * which is exactly the state this test leaves as soon as it turns enforcement on. So it identifies
 * itself properly from the first message, and the fact that the key file exists at all is the first
 * thing this proves.
 */
const keyFile = join(home, 'owner.key')
let ownerKey = ''
for (let i = 0; i < 40 && !ownerKey; i++) {
  try {
    ownerKey = readFileSync(keyFile, 'utf8').trim()
  } catch {
    await sleep(100)
  }
}
check('the server writes an owner key at start', ownerKey.length > 20, `${ownerKey.length} chars`)

const st = { projects: [], sessions: [], tasks: [], reassignments: [], refusals: [], answers: [] }
let ws

async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  socket.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') {
      Object.assign(st, {
        projects: m.projects,
        sessions: m.sessions,
        tasks: m.tasks ?? [],
        reassignments: m.reassignments ?? [],
      })
    } else if (m.t === 'project.added') st.projects.push(m.project)
    else if (m.t === 'session.added') st.sessions.push(m.session)
    else if (m.t === 'session.updated') {
      st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
    } else if (m.t === 'task.state') {
      st.tasks = m.tasks
      st.reassignments = m.reassignments
      // What the Tasks panel reads, which is the only way anything outside the server can see a
      // refusal that was recorded rather than answered.
      st.refusals = m.refusals ?? []
    } else if (m.t === 'task.updated') {
      st.tasks = [...st.tasks.filter((t) => t.id !== m.task.id), m.task]
    } else if (m.t === 'task.reassigned') st.reassignments.push(m.row)
    else st.answers.push(m)
  })
  await new Promise((r) => socket.on('open', r))
  socket.send(JSON.stringify({ t: 'hello', key: ownerKey }))
  await sleep(700)
  return socket
}

ws = await connect()
check('a keyed connection is greeted as the owner', st.answers.some((m) => m.t === 'hello.ok' && m.identity === 'owner'),
  JSON.stringify(st.answers.find((m) => m.t === 'hello.ok')))

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  the scratch project was not added')
  process.exit(1)
}

const stamp = Date.now().toString().slice(-5)
const NAMES = [
  { title: `Boss ${stamp}`, roleClass: 'manager' },
  { title: `Alice ${stamp}`, roleClass: 'worker' },
  { title: `Bob ${stamp}`, roleClass: 'worker' },
  { title: `Checker ${stamp}`, roleClass: 'verifier' },
  { title: `Chief ${stamp}`, roleClass: 'orchestrator' },
]
for (const spec of NAMES) {
  ws.send(JSON.stringify({
    t: 'session.create',
    projectId: project.id,
    adapterId: 'shell',
    title: spec.title,
    roleClass: spec.roleClass,
    ownedPaths: spec.roleClass === 'worker' ? ['server/src', 'apps/web'] : null,
  }))
  await sleep(1600)
}
const card = (n) => st.sessions.find((s) => s.title === NAMES[n].title)
const [boss, alice, bob, checker, chief] = [card(0), card(1), card(2), card(3), card(4)]
if (!boss || !alice || !bob || !checker || !chief) {
  console.log('FAIL  the five cards were not created')
  process.exit(1)
}

// Wires first: mail that no wire permits is refused before ownership is ever consulted, so without
// these every refusal below would pass for the wrong reason.
for (const [a, b] of [
  [boss, alice], [boss, bob], [boss, checker], [alice, checker], [bob, checker],
  [chief, alice], [chief, bob],
]) {
  ws.send(JSON.stringify({ t: 'wire.create', projectId: project.id, sourceId: a.id, targetId: b.id }))
  await sleep(350)
}

/**
 * A card's own token, which is what proves it is that card rather than claiming to be.
 *
 * Asked for again after the restart near the end of this file, because tokens live in the server's
 * memory and a new process mints new ones. A real card gets the new value in its environment when it
 * starts; a shim spawned from a stale map would be sending a token that names nothing, which is
 * refused as an unverified sender and looks nothing like the rule the check was written for.
 */
const tokens = new Map()
async function mintTokens() {
  for (const c of [boss, alice, bob, checker, chief]) {
    st.answers.length = 0
    ws.send(JSON.stringify({ t: 'session.token', sessionId: c.id }))
    await sleep(400)
    const answer = st.answers.find((m) => m.t === 'session.token' && m.sessionId === c.id)
    if (answer) tokens.set(c.id, answer.token)
  }
}
await mintTokens()
check('every running card has a token of its own', tokens.size === 5 && new Set(tokens.values()).size === 5,
  `${tokens.size} tokens`)

// ---------------------------------------------------------------------------
// The unverified sender, on both doors, while the project is still in shadow
// ---------------------------------------------------------------------------

/*
 * Here rather than below, because this is the one thing that can only be seen in `shadow`.
 *
 * At `enforce` a request with no token is refused and nothing is recorded, so an assertion about the
 * recording would be asserting the opposite behaviour. The project is at its migrated default until
 * the next section turns it up, which is the state a real board is in on the day this lands.
 *
 * `GARDEN_TASK_AUTHORITY=enforce` in the server's environment raises every project's floor, and the
 * suite is run both ways, so the expectation follows the setting: recorded and delivered in shadow,
 * refused in enforce. The socket half does not move: an anonymous hello is recorded either way,
 * because a connection that proved nothing is the same fact whatever the board does about it.
 */
const enforcedByEnv = process.env.GARDEN_TASK_AUTHORITY === 'enforce'

const postMail = (body, token) =>
  fetch(`http://127.0.0.1:${PORT}/mail`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, text: (await r.text()).trim() }))

/** The same door `garden-task.mjs` posts to, reached directly, for the checks the shim short-circuits. */
const postTask = (body, token) =>
  fetch(`http://127.0.0.1:${PORT}/task`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, text: (await r.text()).trim() }))

const untokened = await postMail({
  from: alice.id,
  to: checker.title,
  kind: 'question',
  text: 'sent with no token at all, the way every card started before tokens sends',
})
check(
  enforcedByEnv
    ? 'a message with no token is refused while the board enforces'
    : 'a message with no token is delivered in shadow',
  enforcedByEnv ? untokened.status === 403 : untokened.status === 200,
  `${untokened.status} ${untokened.text.slice(0, 120)}`,
)

/*
 * Seeding the one thing the board cannot be told to make: a legacy task id.
 *
 * An `unbound` row is never created by any command. It appears when the server starts and finds a
 * task id it has delivered mail under and has no contract for, which is most of what is on the
 * owner's real board. In shadow this message is refused and delivered anyway, and the delivery is
 * what the backfill reads after the restart near the end of this file. Under `enforce` it is refused
 * outright, nothing is delivered, and no row appears, which the assertion after the restart says.
 */
const legacySeed = await postMail({
  from: alice.id,
  to: checker.title,
  kind: 'work',
  taskId: 'T-legacy',
  text: 'a task id that only ever existed in mail',
}, tokens.get(alice.id))
check(
  enforcedByEnv
    ? 'work for a task with no row is refused outright while the board enforces'
    : 'work for a task with no row is refused and delivered in shadow',
  enforcedByEnv ? legacySeed.status === 403 : legacySeed.status === 200,
  `${legacySeed.status} ${legacySeed.text.slice(0, 110)}`,
)

/*
 * A hello that proves nothing, on a socket of its own so the keyed connection above is untouched.
 * This is the door that used to write a console line instead of recording anything, so the panel
 * showed unverified HTTP senders and no unverified sockets at all.
 */
const anon = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
await new Promise((r) => anon.on('open', r))
anon.send(JSON.stringify({ t: 'hello' }))
await sleep(600)
anon.close()
await sleep(300)

ws.send(JSON.stringify({ t: 'task.list', projectId: project.id }))
await sleep(500)
const unverified = st.refusals.filter((e) => e.type === 'SenderUnverified')
check(
  'an anonymous socket hello is recorded as SenderUnverified',
  unverified.some((e) => e.payload?.rule === 'anonymous-socket'),
  JSON.stringify(unverified.map((e) => e.payload?.rule)),
)
check(
  enforcedByEnv
    ? 'and a refused HTTP sender records nothing, because it was answered instead'
    : 'and an HTTP sender with no token is recorded as SenderUnverified too',
  enforcedByEnv
    ? !unverified.some((e) => e.payload?.rule === 'no-token')
    : unverified.some((e) => e.payload?.rule === 'no-token' && e.sessionId === alice.id),
  JSON.stringify(unverified.map((e) => `${e.payload?.rule}:${e.sessionId === alice.id ? 'alice' : e.sessionId}`)),
)

/*
 * The same two facts kept apart in the record as well as in the sentence. A panel that files a stale
 * token under "no token" tells the owner to go looking for a card that never had one, which is the
 * opposite of what happened.
 */
const staleInShadow = await postMail({
  from: alice.id,
  to: checker.title,
  kind: 'question',
  text: 'a token from a server that is no longer running',
}, 'not-a-token-this-server-knows')
ws.send(JSON.stringify({ t: 'task.list', projectId: project.id }))
await sleep(500)
const unverifiedNow = st.refusals.filter((e) => e.type === 'SenderUnverified')
check(
  enforcedByEnv
    ? 'a token that names no card is refused outright while the board enforces'
    : 'a token that names no card is recorded as bad-token, not as no-token',
  enforcedByEnv
    ? staleInShadow.status === 403 && /names no card/.test(staleInShadow.text)
    : staleInShadow.status === 200 && unverifiedNow.some((e) => e.payload?.rule === 'bad-token'),
  enforcedByEnv
    ? `${staleInShadow.status} ${staleInShadow.text.slice(0, 120)}`
    : `${staleInShadow.status} ${JSON.stringify(unverifiedNow.map((e) => e.payload?.rule))}`,
)

// Enforcement on. Everything below this line is the strict setting, which is the one worth testing:
// shadow records and allows, so a shadow-only test cannot tell a working guard from a missing one.
st.answers.length = 0
ws.send(JSON.stringify({ t: 'limits.get', projectId: project.id }))
await sleep(400)
const current = st.answers.find((m) => m.t === 'limits')?.limits
ws.send(JSON.stringify({
  t: 'limits.set',
  projectId: project.id,
  limits: { ...current, taskAuthority: 'enforce' },
}))
await sleep(500)
st.answers.length = 0
ws.send(JSON.stringify({ t: 'limits.get', projectId: project.id }))
await sleep(400)
check('the owner can turn enforcement on',
  st.answers.find((m) => m.t === 'limits')?.limits?.taskAuthority === 'enforce',
  JSON.stringify(st.answers.find((m) => m.t === 'limits')?.limits))

// ---------------------------------------------------------------------------
// Running a shim exactly as a card runs it
// ---------------------------------------------------------------------------

function shim(script, args, actor, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, 'server', 'bin', script), ...args], {
      env: {
        ...process.env,
        GARDEN_PORT: String(PORT),
        GARDEN_SESSION_ID: actor.id,
        GARDEN_SESSION_TOKEN: tokens.get(actor.id) ?? '',
        CLAUDE_CODE_CHILD_SESSION: undefined,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (out += b))
    child.on('exit', (code) => done({ code, out: out.trim() }))
  })
}

const send = (from, to, kind, taskId, text, env) => {
  writeFileSync(bodyFile, `${text}\n`, 'utf8')
  return shim(
    'garden-send.mjs',
    ['--to', to.title, '--kind', kind, ...(taskId ? ['--task', taskId] : []), '--file', bodyFile],
    from,
    env,
  )
}
const task = (actor, args, env) => shim('garden-task.mjs', args, actor, env)

/*
 * The claim, sent the way the hook sends it: the card's token in a bearer header.
 *
 * The header is the whole point of the change canon 20 revision 2 asks for here. This door used to
 * take `gardenSessionId` out of the body, so the territory check was applied to whichever card the
 * body named, and a card with Bash could be checked against another card's territory by writing a
 * different id into the field. `withToken: false` is how the test asks what happens without one.
 */
const claim = async (actor, path, { withToken = true } = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/claim`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withToken ? { authorization: `Bearer ${tokens.get(actor.id) ?? ''}` } : {}),
    },
    body: JSON.stringify({ gardenSessionId: actor.id, path }),
  })
  return res.json()
}

const refreshTasks = async () => {
  ws.send(JSON.stringify({ t: 'task.list', projectId: project.id }))
  await sleep(400)
}
const stateOf = (id) => st.tasks.find((t) => t.id === id)?.state ?? null
const ownerOf = (id) => st.tasks.find((t) => t.id === id)?.ownerId ?? null

// ---------------------------------------------------------------------------
// The rules, failing case first each time
// ---------------------------------------------------------------------------

/*
 * The shim's own refusal, which never reaches the server at all.
 *
 * Worth keeping and worth naming for what it is: `garden-send.mjs` refuses a lifecycle kind with no
 * `--task` locally, so a card reads the sentence without a round trip. What it does not do is prove
 * the server would refuse it, and this file used to have only this check under a name that claimed
 * the server's behaviour.
 */
const noTask = await send(boss, alice, 'work', null, 'take the loader refactor')
check('the shim refuses lifecycle mail with no task id before it posts',
  noTask.code !== 0 && /which task/i.test(noTask.out), noTask.out)

/*
 * The server's own branch, reached by going around the shim, once for every lifecycle kind.
 *
 * A card with Bash can post to `/mail` directly, so the shim's refusal is a convenience and this is
 * the guard. All six kinds rather than one: the list is a constant in `tasks.ts` and a kind dropped
 * out of it would be a hole nobody could see from a test that only ever sent `work`.
 */
const LIFECYCLE = ['work', 'review', 'remediation', 'done', 'confirm', 'assessment']
for (const kind of LIFECYCLE) {
  const posted = await postMail(
    { from: boss.id, to: alice.title, kind, text: `a ${kind} with no task id, posted straight at the server` },
    tokens.get(boss.id),
  )
  check(`the server refuses ${kind} with no task id`,
    posted.status === 403 && /has to say which task/.test(posted.text),
    `${posted.status} ${posted.text.slice(0, 100)}`)
}

const outsider = await task(alice, ['create', '--task', 'T-x', '--owner', bob.title, '--acceptance', 'x'])
check('a card that does not hand work out cannot open a task',
  outsider.code !== 0 && /dispatcher/i.test(outsider.out), outsider.out)

const made = await task(boss, [
  'create', '--task', 'T-1', '--owner', alice.title, '--verifier', checker.title,
  '--territory', 'server/src', '--acceptance-file', 'ORDER.md',
])
check('a dispatcher opens a task', made.code === 0 && /assigned/.test(made.out), made.out)

const selfVerify = await task(boss, ['create', '--task', 'T-self', '--owner', alice.title, '--verifier', alice.title, '--acceptance', 'x'])
check('the owner of a task cannot also verify it', selfVerify.code !== 0 && /cannot also verify/.test(selfVerify.out), selfVerify.out)

const wrongOwner = await send(boss, bob, 'work', 'T-1', 'you take it instead')
check('work on a task cannot be sent to a card that does not own it',
  wrongOwner.code !== 0 && /T-1/.test(wrongOwner.out), wrongOwner.out)

const rightOwner = await send(boss, alice, 'work', 'T-1', 'start on the loader')
check('work reaches the card that owns the task', rightOwner.code === 0, rightOwner.out)
await refreshTasks()
check('and the task is now being worked', stateOf('T-1') === 'working', stateOf('T-1'))

const outside = await claim(alice, join(dir, 'apps', 'web', 'App.tsx'))
check('a write outside the task territory is refused at the claim',
  typeof outside.deny === 'string' && /territory/.test(outside.deny), JSON.stringify(outside))
const inside = await claim(alice, join(dir, 'server', 'src', 'store.ts'))
check('and a write inside it is allowed', inside.ok === true, JSON.stringify(inside))

/*
 * The same write, from the same card, with nothing proving it is that card.
 *
 * While the board enforces, a claim that cannot be attributed is refused rather than believed, which
 * is the same answer `/mail` and `/task` give an untokened sender. It matters here more than there:
 * the body field this door used to trust is the one thing an impostor would set.
 */
const unproven = await claim(alice, join(dir, 'server', 'src', 'store.ts'), { withToken: false })
check('a claim that cannot prove which card it is, is refused while the board enforces',
  typeof unproven.deny === 'string' && /GARDEN_SESSION_TOKEN/.test(unproven.deny), JSON.stringify(unproven).slice(0, 160))

/*
 * Typing into a terminal must not be able to move a task, however task-shaped the typing is. This is
 * the one door that carries arbitrary text straight into a card, and if the ownership rules could be
 * driven through it the rest of this file would be decoration.
 */
/*
 * The payload has to be one the server would accept if it read it, or the assertion is empty.
 *
 * The earlier version typed a `task.reassign` with `owner_stopped` while Alice was running, which
 * `reassignEvidence` refuses on its own: had `session.input` been dispatched straight into the task
 * plane, that message would have been turned away by the next guard along and the task would have
 * been unchanged either way. So it proved nothing about this door.
 *
 * This one is accepted on every count. `task.verifier` naming Bob on T-1 is a card that is neither
 * the owner nor the assigner, the connection typing it is the owner's, and the owner is a dispatcher
 * by definition, so the only thing standing between this payload and a changed contract is that
 * keystrokes are keystrokes. `verifierId` is in the snapshot for the same reason: the field this
 * payload would have moved has to be one the comparison can see.
 */
const shape = (t) => [t.id, t.state, t.ownerId, t.verifierId]
const before = JSON.stringify(st.tasks.map(shape).sort())
ws.send(JSON.stringify({
  t: 'session.input',
  sessionId: alice.id,
  data:
    JSON.stringify({ t: 'task.verifier', projectId: project.id, taskId: 'T-1', verifierId: bob.id }) + '\r',
}))
await sleep(900)
await refreshTasks()
check('a task-shaped payload typed into a terminal changes nothing',
  JSON.stringify(st.tasks.map(shape).sort()) === before,
  `${stateOf('T-1')} / verifier ${st.tasks.find((t) => t.id === 'T-1')?.verifierId === checker.id ? 'unchanged' : 'MOVED'}`)

const forged = await send(bob, boss, 'done', 'T-1', 'finished it', { GARDEN_SESSION_TOKEN: tokens.get(alice.id) })
check('a message whose body names a different card than its token is refused',
  forged.code !== 0 && /token/i.test(forged.out), forged.out)

/*
 * A token that names nothing is not the same fact as no token, and the sender is told which.
 *
 * Both were getting the sentence about having carried no `GARDEN_SESSION_TOKEN`, which is a lie to
 * the one case that matters most in practice: a card whose process started before the last server
 * restart is holding a token this server has never seen, because tokens live in memory and a restart
 * mints new ones. That card was being told to look for something it already has. The socket door has
 * always drawn this distinction, `bad-key-or-token` against `anonymous-socket`, and this is the HTTP
 * door catching up. Asserted by the two sentences differing, because telling them apart is the whole
 * of the change.
 */
const staleToken = await postMail({
  from: alice.id,
  to: checker.title,
  kind: 'question',
  text: 'sent with a token this server has never minted',
}, 'not-a-token-this-server-knows')
const noToken = await postMail({
  from: alice.id,
  to: checker.title,
  kind: 'question',
  text: 'sent with nothing at all',
})
check('a token that names no card is refused for naming no card, not for being absent',
  staleToken.status === 403 && /names no card/.test(staleToken.text) && /start/.test(staleToken.text),
  `${staleToken.status} ${staleToken.text.slice(0, 150)}`)
check('and that is a different sentence from the one for carrying no token at all',
  noToken.status === 403 && noToken.text !== staleToken.text && /carried no GARDEN_SESSION_TOKEN/.test(noToken.text),
  `${noToken.status} ${noToken.text.slice(0, 120)}`)

const notOwnerDone = await send(bob, boss, 'done', 'T-1', 'finished it')
check('done on a task cannot come from a card that does not own it',
  notOwnerDone.code !== 0 && /only that card reports it done/.test(notOwnerDone.out), notOwnerDone.out)

const review = await send(alice, checker, 'review', 'T-1', 'ready for a look')
check('the owner can send it for review', review.code === 0, review.out)
await refreshTasks()
check('and the task is in review', stateOf('T-1') === 'in_review', stateOf('T-1'))

const strayRemediation = await send(checker, bob, 'remediation', 'T-1', 'fix the loader')
check('ownership refuses a remediation aimed at a card that does not own the work',
  strayRemediation.code !== 0 && /goes to its owner/.test(strayRemediation.out), strayRemediation.out)

/*
 * After a review round it is the spiral guard that refuses the remediation, not ownership, and the
 * distinction is the whole point of asserting it.
 *
 * `MAX_REVIEW_ROUNDS` is 1 on this board, so a task that has been reviewed once cannot be sent back
 * down at all: the only way left is up, which is exactly what that guard was added to force. Canon
 * 20's table has `remediation` moving a task from `in_review` to `remediating`, and while the cap
 * stays at 1 that transition cannot be reached through mail. Ownership was told to narrow the
 * existing guards and never to widen them, so this is the correct outcome and the wrong sentence to
 * discover by surprise. The reachable path is below.
 */
const afterReview = await send(checker, alice, 'remediation', 'T-1', 'the loader still drops the last row')
check('after one review round it is the spiral guard that refuses a remediation, not ownership',
  afterReview.code !== 0 && /already been reviewed/.test(afterReview.out), afterReview.out)

/*
 * The same refusal on a card with more history than a page of events.
 *
 * `hopsForTask` walks each card's events looking for deliveries, and it was reading them through
 * `store.listEvents`, which is capped. Whichever end that cap keeps, a busy card's deliveries fall
 * out of it: a card's mail is a small fraction of what it records, so on a card with tens of
 * thousands of tool and hook rows the review hop is not in the page at all. The spiral guard then
 * counts zero review rounds on a task that has been round one, and lets a remediation back down
 * that the owner's own rule says has to go up instead. The answer changed with how much unrelated
 * traffic the card had produced, which is the one thing a guard must not do.
 *
 * The review hop for T-1 is filed against Checker, because a delivery is recorded on the card that
 * received it. So Checker is the card buried here, with rows stamped after the hop so that any
 * cap, from either end, excludes it. Written straight into the instance's own database rather than
 * produced through the server, because producing four thousand real events would take longer than
 * the rest of this file and would prove the same thing.
 */
const buried = new Database(join(home, 'garden.db'))
const fillFrom = Date.now()
const fill = buried.prepare('INSERT INTO events (id,sessionId,ts,type,provenance,payload) VALUES (?,?,?,?,?,?)')
buried.transaction(() => {
  for (let i = 0; i < 4200; i++) {
    fill.run(`filler-${stamp}-${i}`, checker.id, fillFrom + i, 'PostToolUse', 'structured', '{}')
  }
})()
const eventCount = buried.prepare('SELECT COUNT(*) AS n FROM events WHERE sessionId = ?').get(checker.id).n
buried.close()
check('a card can have more events than a page of them', eventCount > 4000, `${eventCount} events on the verifier`)

const afterBurial = await send(checker, alice, 'remediation', 'T-1', 'still dropping the last row')
check('and the spiral guard still counts the review round it cannot see in a page',
  afterBurial.code !== 0 && /already been reviewed/.test(afterBurial.out), afterBurial.out)

/*
 * The reachable remediation: a task reported done and sent back by its verifier. No review hop, so
 * the spiral guard has nothing to count, and what decides is ownership alone.
 */
await task(boss, ['create', '--task', 'T-2', '--owner', alice.title, '--verifier', checker.title, '--acceptance', 'the second piece'])
await send(boss, alice, 'work', 'T-2', 'and this one too')
const reported = await send(alice, boss, 'done', 'T-2', 'finished, here is what I checked')
check('the owner reports done to the card that assigned it', reported.code === 0, reported.out)
await refreshTasks()
check('and the task is done', stateOf('T-2') === 'done', stateOf('T-2'))

const strayBack = await send(checker, bob, 'remediation', 'T-2', 'fix it')
check("a verifier's remediation cannot land on a card that does not own the work",
  strayBack.code !== 0 && /goes to its owner/.test(strayBack.out), strayBack.out)
const remediation = await send(checker, alice, 'remediation', 'T-2', 'the loader still drops the last row')
check('and it does land on the owner', remediation.code === 0, remediation.out)
await refreshTasks()
check("which puts the task back in the owner's hands", stateOf('T-2') === 'remediating', stateOf('T-2'))

/*
 * The completion report, which is the one surface the owner actually reads when work comes home. It
 * is written when a `done` reaches an orchestrator, so this task is opened and reported by one.
 *
 * The refusal below is deliberate and is what makes the last assertion mean something: a report that
 * lists a refusal Garden really recorded is carrying the history, and a report that merely has the
 * heading could be carrying nothing.
 */
await task(chief, ['create', '--task', 'T-3', '--owner', alice.title, '--territory', 'server/src', '--acceptance', 'the third piece, finished properly'])
await send(chief, bob, 'work', 'T-3', 'wrong card on purpose')
await send(chief, alice, 'work', 'T-3', 'this one is yours')
const home3 = await send(alice, chief, 'done', 'T-3', 'done, and here is what I checked')
check('a done reaching an orchestrator is accepted', home3.code === 0, home3.out)
await sleep(600)
let report = ''
try {
  report = readFileSync(join(home, 'history', chief.id, 'task-T-3.md'), 'utf8')
} catch (err) {
  report = `unreadable: ${err.message}`
}
check('the completion report carries the contract at the top',
  /## The contract/.test(report) && report.includes(alice.title) && /acceptance/.test(report),
  report.slice(0, 200))
check('and the acceptance criteria it was measured against',
  report.includes('the third piece, finished properly'), report.slice(0, 200))
check('and how it changed hands at the bottom', /## How it changed hands/.test(report),
  report.slice(-400))
/*
 * The type comes off the recorded row, not out of the report's prose.
 *
 * This check used to read `/TaskRefused/` against the report text, which the legend at the bottom of
 * every report with any refusal in it satisfies on its own: the legend explains both types by name.
 * So the assertion was green in the red run, where every row was a `TaskWouldRefuse` and nothing had
 * actually been refused, which is the one state it exists to catch. The report is still asserted for
 * the section and the sentence, because that is what the owner reads; what kind of refusal it was is
 * read from `task.state`, which is where the panel reads it too.
 */
await refreshTasks()
const t3Refusals = st.refusals.filter((e) => e.payload?.taskId === 'T-3')
check('and what ownership refused on it',
  /## Refused/.test(report) && /goes to its owner/.test(report) &&
    t3Refusals.some((e) => e.type === 'TaskRefused' && /goes to its owner/.test(e.payload?.reason ?? '')),
  `${t3Refusals.map((e) => e.type).join(',') || 'no rows'} | ${report.slice(-200)}`)

const verifierGrab = await task(boss, ['reassign', '--task', 'T-1', '--to', checker.title, '--reason', 'owner_stopped'])
check('the verifier of a task cannot be given the task',
  verifierGrab.code !== 0 && /verifier/.test(verifierGrab.out), verifierGrab.out)

const verifierSplit = await task(boss, ['split', '--task', 'T-1', '--into', `T-1z=${checker.title}`])
check('nor a piece of it through a split', verifierSplit.code !== 0 && /verif/.test(verifierSplit.out), verifierSplit.out)

const workerReassign = await task(bob, ['reassign', '--task', 'T-1', '--to', bob.title, '--reason', 'owner_stopped'])
check('a card cannot reassign work to itself', workerReassign.code !== 0 && /dispatcher/i.test(workerReassign.out), workerReassign.out)

const madeUpReason = await task(boss, ['reassign', '--task', 'T-1', '--to', bob.title, '--reason', 'convenience'])
check('a reason Garden does not check is not a reason',
  madeUpReason.code !== 0 && /not one of the reasons work may change hands/.test(madeUpReason.out),
  madeUpReason.out)

const untrue = await task(boss, ['reassign', '--task', 'T-1', '--to', bob.title, '--reason', 'owner_stopped'])
check('a true-sounding reason that is not true right now is refused',
  untrue.code !== 0 && /still on the board/.test(untrue.out), untrue.out)

/*
 * Stopping Alice, and making the stop hold, which is a check rather than a preamble.
 *
 * `owner_stopped` is read off the card's status at the moment of the reassign, so everything below
 * depends on Alice being down at that instant, and this used to be a bare loop that gave up after
 * 12 s and fell through in silence. On a loaded machine that produced three red checks whose text
 * pointed at the ownership rules, and the verifier reasonably read them as a defect in the feature.
 *
 * Waiting longer was not the fix, and finding out why was the point. Garden's own mail waker sweeps
 * every 1500 ms and starts any card that has mail waiting and no process, so Alice comes back up
 * roughly a second and a half after being stopped and settles at `idle`. The 0.2 s wait was winning
 * on an idle machine and losing to a node spawn on a busy one. So the stop is repeated until it
 * survives a full sweep: each start lets the waker deliver what it was holding and clear the queue,
 * and after that Alice stays where she was put.
 *
 * The checks that need her stopped are skipped rather than failed when this does not get there. A
 * skip still turns the run red through this check, so nothing goes quiet; what it stops is three
 * lines blaming the ownership rules for a card Garden itself restarted.
 */
const WAKE_SWEEP_MS = 1500
const isDown = (row) => Boolean(row) && (row.status === 'stopped' || row.status === 'failed' || row.closedAt !== null)
const aliceRow = () => st.sessions.find((s) => s.id === alice.id)
const stopWaitBegan = Date.now()
let aliceStatus = 'no row at all'
let aliceStopped = false
let stopsSent = 0
while (Date.now() - stopWaitBegan < 60_000) {
  const row = aliceRow()
  if (row) aliceStatus = row.closedAt !== null ? `${row.status}, closed` : row.status
  if (!isDown(row)) {
    ws.send(JSON.stringify({ t: 'session.stop', sessionId: alice.id }))
    stopsSent++
    await sleep(600)
    continue
  }
  // Down. Hold it past one sweep of the waker before believing it, because the waker is the thing
  // that put it back up last time.
  await sleep(WAKE_SWEEP_MS + 500)
  const held = aliceRow()
  if (held) aliceStatus = held.closedAt !== null ? `${held.status}, closed` : held.status
  if (isDown(held)) {
    aliceStopped = true
    break
  }
}
const stopWaited = ((Date.now() - stopWaitBegan) / 1000).toFixed(1)
check('Alice reached stopped and stayed stopped through a wake sweep', aliceStopped,
  `last saw ${aliceStatus} after ${stopWaited}s and ${stopsSent} stop${stopsSent === 1 ? '' : 's'}`)

/*
 * A check that cannot run unless something earlier actually happened says so instead of failing.
 */
const needing = (met, why) => (n, ok, d = '') => {
  if (met) return check(n, ok, d)
  skipped++
  console.log(`SKIP  ${n}  -- ${why}${d ? '; saw ' + String(d).replace(/\s+/g, ' ').slice(0, 110) : ''}`)
}
const afterStop = needing(aliceStopped,
  `not run, because Alice was ${aliceStatus} after ${stopWaited}s and owner_stopped was not true of her`)

const moved = await task(boss, ['reassign', '--task', 'T-1', '--to', bob.title, '--reason', 'owner_stopped', '--note', 'alice was switched off'])
afterStop('once the reason is true the task moves', moved.code === 0, moved.out)
await refreshTasks()
afterStop('and the new owner is recorded', ownerOf('T-1') === bob.id, ownerOf('T-1'))

const shown = await task(bob, ['show', '--task', 'T-1'])
check('show reads the hand-off back out',
  shown.code === 0 && shown.out.includes('owner_stopped') && shown.out.includes(bob.title), shown.out.slice(0, 200))
check('and it names the acceptance criteria it was given', /ORDER\.md/.test(shown.out) && /sha256/.test(shown.out),
  shown.out.slice(0, 200))

const split = await task(boss, ['split', '--task', 'T-1', '--into', `T-1a=${bob.title}=server/src; T-1b`])
check('a task splits into pieces', split.code === 0, split.out)
check('and a piece nobody owns is paused rather than given to somebody', /paused/.test(split.out), split.out)
await refreshTasks()
check('the pieces are on the board', stateOf('T-1a') === 'assigned' && stateOf('T-1b') === 'paused',
  `${stateOf('T-1a')} / ${stateOf('T-1b')}`)

/*
 * A refusal on the task plane is recorded, not only answered.
 *
 * The plane refuses at every setting, `off` included, because these are operations on the record
 * rather than messages about it. That makes the recording the only way the owner sees them: there is
 * no shadow pass for a refusal that always refuses, so a `/task` refusal that was answered and not
 * written down would be invisible in the panel he is watching.
 */
await refreshTasks()
const planeRefusals = st.refusals.filter((e) => e.type === 'TaskRefused' && String(e.payload?.rule ?? '').startsWith('task.'))
check('every refusal on the task plane is recorded where the panel reads it',
  planeRefusals.some((e) => e.payload?.rule === 'task.reassign' && /not one of the reasons/.test(e.payload?.reason ?? '')),
  JSON.stringify(planeRefusals.map((e) => e.payload?.rule)))

/*
 * The other door, which refused the same operation and wrote nothing down.
 *
 * A card connection turned away by the socket gate never reaches the op, so the refusal existed only
 * in the answer that card got. The HTTP twin of the identical refusal was recorded. An owner reading
 * the panel would have seen one door's refusals and not the other's, which is worse than seeing
 * neither, because a record with a hole in it reads as a complete one. Sent over a socket that says
 * hello with Bob's token, so this is a real card connection and not the owner's.
 */
const bobSocket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
const bobSaid = []
bobSocket.on('message', (raw) => bobSaid.push(JSON.parse(String(raw))))
await new Promise((r) => bobSocket.on('open', r))
bobSocket.send(JSON.stringify({ t: 'hello', token: tokens.get(bob.id) }))
await sleep(500)
bobSocket.send(JSON.stringify({
  t: 'task.create',
  projectId: project.id,
  task: { id: 'T-socket', ownerId: bob.id, assignerId: bob.id, acceptance: 'work a worker gave itself' },
}))
await sleep(600)
bobSocket.close()
await sleep(300)
check('a worker is refused a task op over the socket as well as over HTTP',
  bobSaid.some((m) => m.t === 'error' && /dispatcher/.test(m.message ?? m.reason ?? '')),
  JSON.stringify(bobSaid.map((m) => m.t)))
await refreshTasks()
check('and the socket door records that refusal the way the HTTP door does',
  st.refusals.some((e) => e.type === 'TaskRefused' && e.payload?.rule === 'task.create' &&
    e.payload?.taskId === 'T-socket'),
  JSON.stringify(st.refusals.filter((e) => e.payload?.rule === 'task.create').map((e) => e.payload?.taskId)))
check('and the refused op did not happen',
  !st.tasks.some((t) => t.id === 'T-socket'), st.tasks.map((t) => t.id).join(','))

/*
 * The token outlives the process, which is the correction canon 20 revision 2 makes.
 *
 * Alice was switched off several checks ago. Her token used to die with her process, so this asked
 * the one question the owner needs answered to hand a stopped card's identity to anything, and got
 * a refusal. It is the same token as before, not merely some token: a value that changed under a
 * holder would be worse than none.
 */
st.answers.length = 0
ws.send(JSON.stringify({ t: 'session.token', sessionId: alice.id }))
await sleep(400)
const stoppedToken = st.answers.find((m) => m.t === 'session.token' && m.sessionId === alice.id)
check('a card that is switched off still has its token',
  Boolean(stoppedToken) && stoppedToken.token === tokens.get(alice.id),
  stoppedToken ? 'same token' : JSON.stringify(st.answers.find((m) => m.t === 'error')))

/*
 * `blocked_elsewhere` reads a field and never the note.
 *
 * Both halves matter. A note that names the blocking task in prose used to pass, which meant a note
 * saying "T-1 is finished, so this is unblocked" was accepted as evidence that T-1 was blocking it;
 * and a note that described the dependency in words the pattern did not cut was refused for saying
 * exactly the right thing.
 */
const noteOnly = await postTask(
  { op: 'reassign', taskId: 'T-2', toOwnerId: bob.id, reason: 'blocked_elsewhere', note: 'waiting on T-1, which Bob holds' },
  tokens.get(boss.id),
)
check('a task id in the note is not evidence of anything',
  noteOnly.status === 403 && /--blocked-by/.test(noteOnly.text), `${noteOnly.status} ${noteOnly.text.slice(0, 120)}`)

const blockedByNothing = await task(boss, [
  'reassign', '--task', 'T-2', '--to', bob.title, '--reason', 'blocked_elsewhere', '--blocked-by', 'T-nope',
])
check('and --blocked-by has to name a task that exists',
  blockedByNothing.code !== 0 && /no task with that id/.test(blockedByNothing.out), blockedByNothing.out)

const blocked = await task(boss, [
  'reassign', '--task', 'T-2', '--to', bob.title, '--reason', 'blocked_elsewhere',
  '--blocked-by', 'T-1', '--note', 'the loader has to land first',
])
afterStop('and a real task in another card\'s hands moves it', blocked.code === 0, blocked.out)

/*
 * A card that is gone is stopped, and it is not silent.
 *
 * Both used to allow, which lost the difference between a card that was there and gave no answer and
 * a card that no longer exists. The history is read months later by somebody deciding whether a card
 * can be trusted with work, and "went quiet" is a judgement on a card that never got the chance.
 */
ws.send(JSON.stringify({
  t: 'session.create',
  projectId: project.id,
  adapterId: 'shell',
  title: `Ghost ${stamp}`,
  roleClass: 'worker',
  start: false,
}))
await sleep(1200)
const ghost = st.sessions.find((s) => s.title === `Ghost ${stamp}`)
check('a card can be laid out without being started', Boolean(ghost), `${st.sessions.length} cards`)
if (ghost) {
  await task(boss, ['create', '--task', 'T-4', '--owner', ghost.title, '--acceptance', 'work nobody will finish'])
  await task(boss, [
    'create', '--task', 'T-5', '--owner', ghost.title, '--territory', 'server/src',
    '--acceptance', 'work whose owner will be gone',
  ])
  ws.send(JSON.stringify({ t: 'session.delete', sessionId: ghost.id }))
  await sleep(900)

  const silentGone = await task(boss, ['reassign', '--task', 'T-4', '--to', bob.title, '--reason', 'owner_silent'])
  check('a card that is gone from the board has not gone quiet',
    silentGone.code !== 0 && /owner_stopped/.test(silentGone.out), silentGone.out)

  const stoppedGone = await task(boss, [
    'reassign', '--task', 'T-4', '--to', bob.title, '--reason', 'owner_stopped', '--note', 'the card was deleted',
  ])
  check('and owner_stopped is true of it, and says which fact it allowed on',
    stoppedGone.code === 0 && /not on this board/.test(stoppedGone.out), stoppedGone.out)

  /*
   * A reason with two halves, decided on the half that could still be checked.
   *
   * `missing_territory` compares what the owner holds against what the destination holds. With the
   * owner row gone the first comparison cannot run at all, and the move is allowed on the second
   * alone, which is right. What was wrong was that the row it wrote looked exactly like a row where
   * both halves had been checked, so a reader months later could not tell a checked hand-off from
   * one that had half a check available. The allow now says which half it stood on, and the row
   * carries that sentence rather than only the reply.
   */
  const halfChecked = await task(boss, [
    'reassign', '--task', 'T-5', '--to', bob.title, '--reason', 'missing_territory',
    '--note', 'the card that held this is gone',
  ])
  check('a reason with a missing owner is allowed on the half that could be checked',
    halfChecked.code === 0 && /not on this board any more/.test(halfChecked.out) &&
      /Allowed on/.test(halfChecked.out),
    halfChecked.out)
  await refreshTasks()
  const t5Row = st.reassignments.find((r) => r.taskId === 'T-5')
  check('and the hand-off row carries what Garden found, apart from the note',
    Boolean(t5Row) && /not on this board any more/.test(t5Row.evidence ?? '') &&
      t5Row.note === 'the card that held this is gone',
    t5Row ? `${t5Row.evidence ?? 'no evidence'} | note: ${t5Row.note}` : 'no row')

  const shown5 = await task(bob, ['show', '--task', 'T-5'])
  check('and show reads it back under the note, marked as Garden\'s',
    shown5.code === 0 && /Garden found:/.test(shown5.out), shown5.out.slice(-300))
}

/*
 * Closing a card takes its token away, which is what closing one is for.
 *
 * Switching a card off deliberately leaves the token alone: the card is coming back and the owner
 * has to be able to hand a stopped card's identity to a script. Closing is the owner saying this
 * must not send any more, and a credential that outlived it would make closing cosmetic. Checked at
 * both settings on purpose, because this refusal is not governed by `taskAuthority`: Garden is not
 * unsure who sent this, it is certain, and certain the owner withdrew it.
 */
ws.send(JSON.stringify({
  t: 'session.create',
  projectId: project.id,
  adapterId: 'shell',
  title: `Sealed ${stamp}`,
  roleClass: 'worker',
  start: false,
}))
await sleep(1200)
const sealed = st.sessions.find((s) => s.title === `Sealed ${stamp}`)
let sealedToken = ''
if (sealed) {
  st.answers.length = 0
  ws.send(JSON.stringify({ t: 'session.token', sessionId: sealed.id }))
  await sleep(400)
  sealedToken = st.answers.find((m) => m.t === 'session.token' && m.sessionId === sealed.id)?.token ?? ''
  check('a card that has never started can be given a token', sealedToken.length > 20, `${sealedToken.length} chars`)

  ws.send(JSON.stringify({ t: 'session.close', sessionId: sealed.id }))
  await sleep(700)
  const afterClose = await postMail({
    from: sealed.id,
    to: checker.title,
    kind: 'question',
    text: 'sent with the token of a card that has been closed',
  }, sealedToken)
  check('a closed card cannot send, and is told that it is closed',
    afterClose.status === 403 && /closed/.test(afterClose.text),
    `${afterClose.status} ${afterClose.text.slice(0, 140)}`)

  st.answers.length = 0
  ws.send(JSON.stringify({ t: 'session.token', sessionId: sealed.id }))
  await sleep(400)
  check('and asking again does not mint it a new one',
    st.answers.some((m) => m.t === 'error' && /closed/.test(m.message ?? '')),
    JSON.stringify(st.answers.map((m) => m.t)))
}

// ---------------------------------------------------------------------------
// A restart, which is the only thing that proves any of this was written down
// ---------------------------------------------------------------------------

const beforeRestart = st.tasks.filter((t) => t.id !== 'T-legacy').map((t) => `${t.id}:${t.state}:${t.ownerId}`).sort().join('|')
const rowsBefore = st.reassignments.length
ws.close()
await garden.stop()
garden = await startInstance({ home })
PORT = garden.port
st.tasks = []
st.reassignments = []
st.answers.length = 0
ws = await connect()
await mintTokens()
await refreshTasks()
/*
 * `T-legacy` is left out of both sides on purpose. It is not a task anybody created: it is the row
 * the backfill writes when the server starts and finds a delivered task id with no contract, so it
 * exists only on the far side of this restart and comparing it would fail the wrong assertion. It
 * has checks of its own below.
 */
const persisted = (t) => t.id !== 'T-legacy'
const afterRestart = st.tasks.filter(persisted).map((t) => `${t.id}:${t.state}:${t.ownerId}`).sort().join('|')
check('every task is where it was after a restart', afterRestart === beforeRestart, `${afterRestart} vs ${beforeRestart}`)
/*
 * `rowsBefore > 0` is half the assertion, not decoration. When the reassign above failed for an
 * unrelated reason this read "0 vs 0" and passed, which is a check that survives the very thing it
 * exists to catch: a hand-off table that a restart empties.
 */
check('and so is every hand-off', rowsBefore > 0 && st.reassignments.length === rowsBefore,
  `${st.reassignments.length} vs ${rowsBefore}`)

/*
 * The legacy row, and the sentence a reader gets when work arrives for it.
 *
 * Two people who saw only the screen read the old refusal, which told them to create the task, as
 * one of two ways of doing the same job as the Bind button beside it, and could not say which they
 * were meant to use. They are not two ways: the row is already there, so creating is refused, and a
 * bind is the only thing that moves it out of `unbound`. The remedy names the button first, because
 * that is what the reader is looking at when they read it.
 */
const legacyRow = st.tasks.find((t) => t.id === 'T-legacy')
if (enforcedByEnv) {
  check('a delivery refused outright leaves nothing for the backfill to find',
    !legacyRow, legacyRow ? legacyRow.state : 'no row, which is right')
} else {
  check('a task id seen only in old mail comes back as unbound after a restart',
    legacyRow?.state === 'unbound' && legacyRow?.ownerId === null,
    legacyRow ? `${legacyRow.state} owned by ${legacyRow.ownerId}` : 'no row')
  const workOnLegacy = await send(boss, alice, 'work', 'T-legacy', 'somebody has to own this')
  check('and work on it points at bind rather than at create',
    workOnLegacy.code !== 0 && /bind it/i.test(workOnLegacy.out) && /Tasks panel/.test(workOnLegacy.out) &&
      !/Create it/.test(workOnLegacy.out),
    workOnLegacy.out)
}

/*
 * The setting that used to be two radio buttons, reached from a terminal.
 *
 * Last in the file on purpose: these checks move the project's own authority, and everything above
 * depends on it being `enforce`. It is put back before the file ends, and the read-back is what
 * proves it, so a later reader is not left wondering what state this left behind.
 *
 * The owner's key is read from the instance's own `GARDEN_HOME`, never the real board's. That is the
 * whole reason the shim honours that variable: a test that reached for `~/.garden/owner.key` would
 * be authenticating against the owner's live board from inside a scratch one.
 */
const authRead = await task(chief, ['authority'])
check('the authority setting can be read back from a terminal',
  authRead.code === 0 && /enforce/.test(authRead.out), authRead.out)

const authWorker = await task(bob, ['authority', 'off'])
check('and a worker cannot change it',
  authWorker.code !== 0 && /board policy/.test(authWorker.out) && /worker is neither/.test(authWorker.out),
  authWorker.out)
st.answers.length = 0
ws.send(JSON.stringify({ t: 'limits.get', projectId: project.id }))
await sleep(400)
const afterRefusal = st.answers.find((m) => m.t === 'limits')?.limits
check('and the refusal changed nothing',
  afterRefusal?.taskAuthority === 'enforce', JSON.stringify(afterRefusal))

const authSet = await task(chief, ['authority', 'shadow'])
check('the orchestrator can set it', authSet.code === 0 && /now shadow/.test(authSet.out), authSet.out)
const authAfter = await task(chief, ['authority'])
check('and the board says so when asked again',
  authAfter.code === 0 && /is shadow/.test(authAfter.out), authAfter.out)

/*
 * The owner's own hands: no card id, no card token, just the key the server wrote at start. This is
 * the path that exists because the sidebar buttons went away, so it is the one that has to work
 * without a card at all.
 */
const authByKey = await task(chief, ['authority', 'enforce'], {
  GARDEN_SESSION_ID: '',
  GARDEN_SESSION_TOKEN: '',
  GARDEN_HOME: home,
})
check('and the owner can set it with his key and no card at all',
  authByKey.code === 0 && /now enforce/.test(authByKey.out), authByKey.out)
const authRestored = await task(chief, ['authority'])
check('which leaves the board where this file found it',
  authRestored.code === 0 && /is enforce/.test(authRestored.out), authRestored.out)

const authNonsense = await task(chief, ['authority', 'sideways'])
check('a setting Garden does not have is refused by name, before it is sent',
  authNonsense.code !== 0 && /not a setting/.test(authNonsense.out), authNonsense.out)
/*
 * And again at the server, because the line above is the shim refusing locally. A card with Bash
 * posts to this door directly, so a value only the shim checks is not checked at all. Same lesson as
 * the lifecycle kinds above.
 */
const authNonsensePosted = await postTask(
  { op: 'authority', authority: 'sideways' },
  tokens.get(chief.id),
)
check('and the server refuses it too, not only the shim',
  authNonsensePosted.status === 400 && /not a setting/.test(authNonsensePosted.text),
  `${authNonsensePosted.status} ${authNonsensePosted.text.slice(0, 120)}`)

try {
  ws.close()
} catch {
  // Already gone, which is not worth failing a test over.
}
await garden.stop()
for (const p of [home, dir]) {
  try {
    rmSync(p, { recursive: true, force: true })
  } catch {
    // A file the server still has open on Windows is not worth failing a test over.
  }
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED${skipped ? `, ${skipped} not run` : ''}`)
process.exit(failures === 0 ? 0 : 1)
