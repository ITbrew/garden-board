/**
 * The one sequence Department D is judged by: a card made through `session.create` with
 * `start: true` sends a message to the card it answers to, and that card receives it.
 *
 * A card that Garden created but never briefed is the failure this exists to catch. `startSession`
 * writes PEERS.md and seeds the memory directory, but the card's own CLAUDE.md is written from one
 * place only, the hook ingest path (`ensureCardMemory` in server/src/index.ts), and nothing fires
 * that for a card the owner or a manager creates directly. So the card lands with LESSONS.md,
 * NOTES.md and PLAYBOOK.md and no instructions saying what it is or who it answers to, and it then
 * reads the project's CLAUDE.md and behaves like every other session in the folder. Each check
 * below names the breakage it would have caught.
 *
 * IT RUNS AGAINST ITS OWN BACKEND, NOT THE OWNER'S.
 *
 * The sequence goes over the WebSocket, and the server the owner is using holds his real board.
 * Environment variables cannot move a process that is already running, so this starts a second
 * server instead: the same source, a scratch GARDEN_HOME, and a port of its own. Every path the
 * server writes is derived from DATA_DIR (server/src/store.ts), so the two share no database, no
 * mailbox, no memory root and no hook file, and nothing this run does can reach his board. The two
 * older scripts, test-spawn-topology.mjs and test-wire-mail.mjs, do NOT do this: they default to
 * port 5178 and make a scratch project on the live board, which is confinement rather than
 * isolation, and any crash leaves those cards sitting on it.
 *
 * Run it with: node scripts/test-created-card-can-report.mjs
 */
import WebSocket from 'ws'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..')
const TSX = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const SERVER_ENTRY = join(REPO, 'server', 'src', 'index.ts')
const SEND_SHIM = join(REPO, 'server', 'bin', 'garden-send.mjs')

/*
 * A port of this run's own, and never the owner's.
 *
 * Derived from the pid so two runs at once do not collide, and bounded well away from 5178. The
 * guard below is not decoration: addressing the live port is the single mistake that would put
 * test cards on his real board, and it has to be impossible rather than unlikely.
 */
const PORT = 5300 + (process.pid % 90)
const HOME_DIR = mkdtempSync(join(tmpdir(), 'garden-proof-home-'))
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'garden-proof-proj-'))

if (PORT === 5178 || HOME_DIR.toLowerCase().startsWith(join(homedir(), '.garden').toLowerCase())) {
  console.error('refusing to run: this would have addressed the live workspace')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
/*
 * The detail is printed on a failure only.
 *
 * It is written as the reason a check would have failed, so printing it beside PASS puts a line
 * like "sender missing" next to a check that found the sender. A reader skimming the output would
 * take that as a warning, and a harness that reads as half broken when it is fine is a harness
 * nobody trusts when it is not.
 */
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

writeFileSync(join(PROJECT_DIR, 'CLAUDE.md'), '# scratch project for the D4 proof harness\n')

console.log(`workspace  ${HOME_DIR}`)
console.log(`project    ${PROJECT_DIR}`)
console.log(`port       ${PORT}   (the owner's board on 5178 is not addressed by this run)\n`)

const server = spawn(process.execPath, [TSX, SERVER_ENTRY], {
  env: {
    ...process.env,
    GARDEN_PORT: String(PORT),
    GARDEN_HOME: HOME_DIR,
    GARDEN_DB: join(HOME_DIR, 'garden.db'),
  },
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (c) => (serverLog += c))
server.stderr.on('data', (c) => (serverLog += c))

let ws = null
let stopped = false
const stopServer = () => {
  if (stopped) return
  stopped = true
  try { ws?.close() } catch {}
  if (server.exitCode === null) {
    // The server owns child shells, so the whole tree goes, and only this run's tree.
    spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
  }
}
process.on('exit', stopServer)

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (res.ok) return true
    } catch {
      // Not up yet, which is the normal case for the first second or two.
    }
    if (server.exitCode !== null) return false
    await sleep(500)
  }
  return false
}

const st = { projects: [], sessions: [], wires: [], events: [] }
const mailFile = (id, name) => join(HOME_DIR, 'mail', id, name)
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'card'

/*
 * The memory root read from where this run put it, not from the home directory.
 *
 * test-spawn-topology.mjs hardcodes homedir() for this, so under a redirected GARDEN_HOME it looks
 * in the owner's directory, finds nothing, and reports that cards have no memory when they do. A
 * harness that invents a failure is worse than no harness.
 */
const memoryDirOf = (projectName, cardId) => {
  const projectDir = join(HOME_DIR, 'memory', slug(projectName))
  let names = []
  try {
    names = readdirSync(projectDir)
  } catch {
    return null
  }
  const found = names.find((n) => n.endsWith(`-${cardId.slice(0, 8)}`))
  return found ? join(projectDir, found) : null
}

/*
 * ============================================================================
 * THE ONE PLACE TO EDIT WHEN THE UNWIRED REFUSAL IS REWORDED
 * ============================================================================
 *
 * A LITERAL copy, typed here, deliberately NOT read from the code under test.
 *
 * It mirrors the string built at `server/src/index.ts:3745`. Go there when you need to update it,
 * but do not make this function fetch it from there: a test that reads its expectation out of the
 * code it is testing agrees with that code by construction, including when the code is wrong, which
 * is the exact failure this department spent a morning pulling apart. The value of the comparison is
 * that it is an independent second opinion about what the server should say.
 *
 * So the check that uses this is EXPECTED TO FAIL when the refusal is reworded, and updating this
 * function is part of applying that patch rather than a repair afterwards. A test that breaks loudly
 * on a deliberate change is worth more than one that cannot tell a deliberate change from a
 * corrupted capture. The failure message names both possibilities so whoever sees it red does not
 * have to guess which happened.
 *
 * It is lifted up here, away from the check that reads it, for exactly one reason: the edit that
 * follows a reword should be one obvious line rather than a hunt through the middle of a run.
 */
function expectedWireRefusal(target) {
  return (
    `there is no wire from you to "${target.title}". Draw one on the board first, ` +
    'or send to a card in your PEERS.md.'
  )
}

/** Send exactly as a card's own shell would: the shim, with the identity Garden puts in its env. */
function sendAs(card, args) {
  const r = spawnSync(process.execPath, [SEND_SHIM, ...args], {
    env: { ...process.env, GARDEN_SESSION_ID: card.id, GARDEN_PORT: String(PORT), GARDEN_HOME: HOME_DIR },
    encoding: 'utf8',
  })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

const created = { sessionIds: [], projectId: null }
let exitCode = 1

try {
  if (!(await waitForServer())) {
    console.error('the scratch server never came up. Its output was:\n' + serverLog)
    process.exit(2)
  }

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, wires: m.wires })
    else if (m.t === 'project.added') st.projects.push(m.project)
    else if (m.t === 'session.added') st.sessions.push(m.session)
    else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
    else if (m.t === 'wire.added') st.wires.push(m.wire)
    else if (m.t === 'event') st.events.push(m.event)
  })
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello' }))
  await sleep(600)

  check("the board this run addresses is empty, so nothing on it is the owner's",
    st.sessions.length === 0 && st.projects.length === 0,
    `${st.sessions.length} cards, ${st.projects.length} projects`)

  ws.send(JSON.stringify({ t: 'project.add', path: PROJECT_DIR.replace(/\\/g, '/') }))
  await sleep(1200)
  const project = st.projects.find((p) => p.path.toLowerCase() === PROJECT_DIR.toLowerCase())
  if (!project) {
    console.log('FAIL  the scratch project was not created, so nothing below could run')
    throw new Error('no project')
  }
  created.projectId = project.id

  const stamp = Date.now().toString().slice(-5)
  ws.send(JSON.stringify({
    t: 'session.create',
    projectId: project.id,
    adapterId: 'shell',
    title: `Manager ${stamp}`,
    roleClass: 'orchestrator',
  }))
  await sleep(2200)
  const manager = st.sessions.find((s) => s.title === `Manager ${stamp}`)
  if (!manager) {
    console.log('FAIL  the parent card was not created, so nothing below could run')
    throw new Error('no parent')
  }
  created.sessionIds.push(manager.id)

  /*
   * The card under test: created through session.create, started, answering to the card above it.
   * `start` is left at its default, because the default is the path a manager hiring a worker
   * actually takes and it is the path the department is judged on.
   */
  ws.send(JSON.stringify({
    t: 'session.create',
    projectId: project.id,
    adapterId: 'shell',
    title: `Worker ${stamp}`,
    roleClass: 'worker',
    reportsTo: manager.id,
  }))
  await sleep(2400)
  const worker = st.sessions.find((s) => s.title === `Worker ${stamp}`)
  check('session.create with start true puts a card on the board', !!worker, worker ? worker.id : 'no card arrived')
  if (!worker) throw new Error('no worker card')
  created.sessionIds.push(worker.id)

  // Would have caught: a card created with a boss that Garden does not record as answering to it.
  check('and it records the card it answers to', worker.reportsTo === manager.id,
    `reportsTo ${worker.reportsTo}`)

  // Would have caught: the wire being drawn only after the first turn, or not at all, which is
  // what decides whether the message below is permitted at all.
  const wire = st.wires.find(
    (w) => (w.sourceId === manager.id && w.targetId === worker.id) || (w.sourceId === worker.id && w.targetId === manager.id),
  )
  check('a wire exists between the two of them from the moment it is created', !!wire,
    wire ? `${wire.label}, ${wire.bidirectional ? 'both ways' : 'one way'}` : 'no wire')
  check('and it runs both ways, so the card can answer its boss', !!wire?.bidirectional)

  /*
   * Would have caught: a started card getting no PEERS.md. Without it the card is told nothing
   * about who it may send to or what the command is, and the first thing the owner sees is a card
   * that never reports. `startSession` writes it; a card created with `start: false` gets it from
   * the other branch. Both paths are checked by one file existing with the boss named in it.
   */
  const peers = readIf(mailFile(worker.id, 'PEERS.md'))
  check('the new card is told who it is wired to', peers.includes(`Manager ${stamp}`),
    peers ? peers.split('\n').find((l) => l.startsWith('- ')) ?? peers.slice(0, 70) : 'PEERS.md does not exist')
  check('and is told how to send, by being given the command', peers.includes('garden-send.mjs'),
    peers ? 'no command in the file' : 'PEERS.md does not exist')

  /*
   * An address that cannot be ambiguous.
   *
   * PEERS.md lists a peer by title (mail.ts:74) and the command it hands over says
   * `--to "<their title>"` (mail.ts:94). The card id appears only buried inside the mailbox path,
   * which is not offered as something to address. Titles are not unique, and /mail resolves one by
   * matching open cards in row order (index.ts:3696-3698), a comment block that documents this
   * going wrong during a live demonstration. The board this runs on has two cards titled "Boss"
   * right now, which is why this card's own roots had to tell it in prose to ignore the file and
   * address by id.
   *
   * Would have caught: Garden handing a card an addressing scheme that the same server's own
   * comments describe as having already misdelivered a message.
   */
  check('and PEERS.md gives an id to address, not only a title that another card may share',
    peers.includes(manager.id), 'the boss card id appears nowhere in the file')

  /*
   * A brief that agrees with the settings file the CLI actually read.
   *
   * This is the department's own rule turned on the department: a card must not be told in writing
   * that it may do something the deny list forbids. The worker role denies Agent
   * (packages/shared/src/index.ts, ROLE_POWERS.worker), and writePowers appends the same
   * hand-work-out paragraph to every card regardless of role (server/src/mail.ts:277-283), ending
   * with "nothing here stops you". Something does stop it. The comment above that push
   * (mail.ts:274-276) says the preference is deliberately not enforced, which was true when no role
   * denied Agent and is false now that worker and reviewer both do.
   *
   * Would have caught: exactly what happened to this card's own manager, who read the friendly half
   * of a contradictory POWERS.md and repeated it in writing to five cards. A brief that overstates
   * what a card may do is the same defect as one that overstates what it may not.
   */
  const settingsFile = join(HOME_DIR, 'hooks', 'sessions', `${worker.id}.json`)
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : null
  const denied = settings?.permissions?.deny ?? []
  check('the card gets a settings file with the denials its role carries', denied.includes('Agent'),
    settings ? `deny: ${JSON.stringify(denied)}` : 'no settings file for this card')

  const powers = readIf(join(HOME_DIR, 'mail', worker.id, 'POWERS.md'))
  check('and a POWERS.md that names the same denial', /Denied by the CLI:.*Agent/.test(powers),
    powers ? 'the denial is not stated' : 'POWERS.md does not exist')
  check('and that brief does NOT also invite it to do the thing the CLI will refuse',
    !(denied.includes('Agent') && /nothing here stops you/.test(powers)),
    'POWERS.md tells a card whose Agent tool is denied to spawn one anyway')

  /*
   * Would have caught: the card having a memory directory with no brief in it. writeCardBrief is
   * called from the hook ingest path only, so a card created through session.create gets the three
   * notes files and no CLAUDE.md, and therefore no statement of its role, its restrictions or who
   * it answers to. The CLI reads CLAUDE.md on its own; nothing else it is given says any of this.
   */
  const memDir = memoryDirOf(project.name, worker.id)
  if (memDir) console.log(`  its memory directory: ${memDir}`)
  check('the new card has a memory directory of its own', !!memDir, 'none found for this card id')
  const memFiles = memDir ? readdirSync(memDir) : []
  check('with the three notes files in it', ['LESSONS.md', 'NOTES.md', 'PLAYBOOK.md'].every((f) => memFiles.includes(f)),
    memFiles.join(' ') || 'empty')
  check('AND a CLAUDE.md, so the card knows what it is rather than reading only the project brief',
    memFiles.includes('CLAUDE.md'), memFiles.join(' ') || 'empty')
  const brief = memDir && memFiles.includes('CLAUDE.md') ? readFileSync(join(memDir, 'CLAUDE.md'), 'utf8') : ''
  check('and that brief names the card it answers to', brief.includes(`Manager ${stamp}`),
    brief ? brief.slice(0, 70).replace(/\n/g, ' ') : 'no CLAUDE.md to read')

  /*
   * The sequence itself. Run through the real shim with the real identity Garden hands a card's
   * shell (GARDEN_SESSION_ID, GARDEN_PORT), so the refusal or the delivery is the same one a live
   * card would get. Whatever it prints is printed here verbatim, because the reason is the useful
   * part and paraphrasing it is how a wrong reason gets believed.
   */
  const sent = sendAs(worker, [
    '--to', manager.id,
    '--kind', 'done',
    '--task', 'proof-run',
    '--text', 'the worker card reporting to the card it answers to',
  ])
  console.log(`\n  the card ran garden-send.mjs, exit ${sent.code}`)
  if (sent.out) console.log(`  stdout: ${sent.out}`)
  if (sent.err) console.log(`  stderr: ${sent.err}`)
  console.log('')
  check('the card can send to the card it answers to', sent.code === 0, sent.err || sent.out || 'no output')

  await sleep(600)
  const inbox = readIf(mailFile(manager.id, 'INBOX.md'))
  check('and the boss receives it', inbox.includes('the worker card reporting to the card it answers to'),
    inbox ? inbox.slice(-80).replace(/\n/g, ' ') : 'INBOX.md does not exist')
  check('with the sender named on it', inbox.includes(`Worker ${stamp}`), 'sender missing')

  // Would have caught: a send that is recorded as delivered in the sender's own record while the
  // receiver got nothing, which is the state that leaves both cards believing different things.
  const sentRecord = readIf(mailFile(worker.id, 'SENT.md'))
  check('and the sender\'s own record agrees that it went',
    sent.code === 0 ? sentRecord.includes('the worker card reporting') : !sentRecord.includes('the worker card reporting'),
    sent.code === 0 ? 'SENT.md missing the message' : 'recorded as sent while the send failed')

  /*
   * The other half of the same question: a card with no wire to the card it is addressing.
   *
   * Worth having next to the permitted case because the two together say what a missing PEERS.md
   * actually costs. The card above has no PEERS.md and its message went through, so the file is
   * not consulted by the shim or by /mail at any point: it buys the agent knowledge and nothing
   * else. The refusal below is what the wire being absent costs, which is a different thing, and
   * conflating the two is how the wrong refusal string ended up in a work order.
   */
  ws.send(JSON.stringify({
    t: 'session.create',
    projectId: project.id,
    adapterId: 'shell',
    title: `Stranger ${stamp}`,
    roleClass: 'worker',
  }))
  await sleep(2400)
  const stranger = st.sessions.find((s) => s.title === `Stranger ${stamp}`)
  if (stranger) created.sessionIds.push(stranger.id)
  check('a card with no boss can be created too', !!stranger, 'no card arrived')

  if (stranger) {
    const refused = sendAs(stranger, [
      '--to', manager.id,
      '--kind', 'done',
      '--task', 'proof-run',
      '--text', 'a card with no wire, addressing one it was never connected to',
    ])
    console.log(`\n  an unwired card ran garden-send.mjs, exit ${refused.code}`)
    if (refused.out) console.log(`  stdout: ${refused.out}`)
    if (refused.err) console.log(`  stderr: ${refused.err}`)
    console.log('')

    // Would have caught: a send with no wire behind it going through anyway, which would make the
    // board decorative. The wire is what permits a message; that is the whole design.
    check('a card with no wire to the card it addresses is refused', refused.code === 1,
      `exit ${refused.code}`)
    check('and the refusal says it is the wire that is missing',
      /no wire from you to/.test(refused.err), refused.err || refused.out || 'nothing on stderr')

    /*
     * The captured refusal, byte for byte against the string the server actually builds
     * (index.ts:3745). Not a regex, because a regex is exactly what would let a corrupted capture
     * through: the point of this check is that what this department quotes as verbatim IS verbatim.
     *
     * Nothing here goes near a shell. The shim is run with spawnSync, node to node, stdio piped and
     * decoded as utf8, so there is no redirection anywhere in the path. That matters because
     * redirecting a native command's stderr inside Windows PowerShell 5.1 wraps each line in an
     * ErrorRecord and adds a NativeCommandError block, which is how a refusal gets quoted with
     * noise in it and reported as the clean line. This capture cannot acquire that wrapper, and
     * these three checks fail loudly if it ever does.
     */
    const expected = expectedWireRefusal(manager)
    check('and the captured refusal is the server\'s string exactly, not a wrapped version of it',
      refused.err === expected,
      `expected: ${JSON.stringify(expected)}\n        got:      ${JSON.stringify(refused.err)}\n` +
        '        If the refusal was reworded on purpose, update the literal in this script to match ' +
        'index.ts:3745.\n        If it was not, the capture is corrupted and must not be relayed as verbatim.')
    check('with nothing on stdout, so the whole message is on one channel',
      refused.out === '', `stdout: ${JSON.stringify(refused.out)}`)
    check('and it is a single line, with no error-record noise wrapped around it',
      refused.err.split('\n').length === 1, `${refused.err.split('\n').length} lines`)

    /*
     * Short enough to survive being relayed by a card that is not using this harness.
     *
     * Measured rather than taken from the guidance. On this machine PowerShell 5.1 leaves native
     * stderr alone at 300 characters when nothing is redirected, and splits it at exactly the
     * console buffer width (120 here, from $Host.UI.RawUI.BufferSize.Width) the moment `2>&1` is
     * added, along with the ErrorRecord block. So the wrap is not a second independent mechanism
     * at ~117 columns: it is what the redirection's own rendering does, at whatever width the
     * console is.
     *
     * This refusal is 97 characters plus the target's title, so a title of 23 characters or more
     * pushes it past 120. Every title on the board today is well inside that, which is exactly why
     * three cards captured it cleanly and nobody found the edge. A longer card title would move
     * this line across the boundary without anyone touching the string.
     *
     * Would have caught: the fleet's canonical refusal quietly becoming wrappable because somebody
     * named a card something longer, which corrupts a relayed capture and not the send itself.
     */
    check('and is short enough that relaying it cannot split it mid-sentence',
      refused.err.length < 120,
      `${refused.err.length} characters, over the 120-column console width, because the title is ${manager.title.length} long`)

    /*
     * Would have caught: a refusal that cannot tell "I do not know that card" apart from "I know
     * it and you have no wire to it". It was addressed by id and the refusal names it by title,
     * so the id was resolved before the wire was checked, and a refusal in this shape therefore
     * proves the address was recognised. D1 Birth and D2 Fields captured the same line
     * independently; this is a third, on a board where the two cards are known to be unwired by
     * construction rather than by assumption.
     */
    check('and names the card by title although it was addressed by id, so the address resolved',
      refused.err.includes(`Manager ${stamp}`), refused.err || 'title not in the refusal')

    /*
     * Would have caught: a refused send leaving no durable trace anywhere, which is the state where
     * a card believes it reported and nothing on the board can contradict it. The trace is an
     * event, and it carries `structured` provenance because the server refused it itself rather
     * than anything having been inferred from the text.
     */
    await sleep(400)
    const refusalEvent = st.events.find(
      (e) => e.type === 'MailRefused' && e.sessionId === stranger.id && /no wire from you to/.test(e.payload?.reason ?? ''),
    )
    check('the refusal is recorded on the board as something Garden can prove', !!refusalEvent,
      `${st.events.filter((e) => e.type === 'MailRefused').length} MailRefused events`)
    check('and it is marked structured, not inferred', refusalEvent?.provenance === 'structured',
      refusalEvent?.provenance ?? 'no event to read')

    /*
     * Not a failure, a finding, and reported rather than asserted.
     *
     * A refused send writes nothing to the sender's own SENT.md: recordRefusal (index.ts:643)
     * inserts an event and broadcasts it, and that is all. A delivered send does write SENT.md. So
     * the card's own file record is the half that carries only successes, and a card reading its
     * record back after a restart finds no sign it ever tried. Whether that is worth changing is
     * not this script's call, so it says so rather than voting FAIL on behaviour nobody designed.
     */
    const strangerSent = readIf(mailFile(stranger.id, 'SENT.md'))
    console.log(
      `  note: the refused send left ${strangerSent ? 'something' : 'nothing'} in the sender's SENT.md, ` +
        'and the only durable record of it is the event above',
    )

    const bossInbox = readIf(mailFile(manager.id, 'INBOX.md'))
    check('and nothing reached the card it tried to address',
      !bossInbox.includes('a card with no wire, addressing one it was never connected to'),
      'the refused message arrived anyway')
  }

  /*
   * Two cards with one name, which is not a hypothetical: the owner's board has two called "Boss".
   *
   * Reproduced rather than argued about. Both are wired to the same manager, so both are legitimate
   * addressees, and the manager then does exactly what its own PEERS.md tells it to do and sends by
   * title. One of them gets it. Nothing in the file the manager read could have told it which.
   */
  const twinTitle = `Twin ${stamp}`
  for (let i = 0; i < 2; i++) {
    ws.send(JSON.stringify({
      t: 'session.create',
      projectId: project.id,
      adapterId: 'shell',
      title: twinTitle,
      roleClass: 'worker',
      reportsTo: manager.id,
    }))
    await sleep(2400)
  }
  const twins = st.sessions.filter((s) => s.title === twinTitle)
  for (const t of twins) created.sessionIds.push(t.id)
  check('two cards can hold the same title at once', twins.length === 2, `${twins.length} cards named ${twinTitle}`)

  if (twins.length === 2) {
    const byTitle = sendAs(manager, [
      '--to', twinTitle,
      '--kind', 'work',
      '--task', 'proof-run',
      '--text', 'addressed by title, with two cards answering to that name',
    ])
    await sleep(600)
    const got = twins.filter((t) =>
      readIf(mailFile(t.id, 'INBOX.md')).includes('addressed by title, with two cards answering to that name'),
    )
    console.log(`\n  addressed by title with two cards holding it, exit ${byTitle.code}: ${byTitle.out || byTitle.err}`)
    console.log(`  it reached ${got.length} of the 2, and PEERS.md offered no way to say which\n`)

    /*
     * Reported rather than voted on. Delivering to one of two is defensible and so is refusing;
     * what is not defensible is a file telling a card to address this way without saying that it
     * can happen. The check carrying the weight is the one above, that an id is offered at all.
     */
    check('a message addressed by a shared title reaches exactly one card, not both',
      got.length === 1, `${got.length} of the 2 received it`)
  }

  /*
   * Cleanup removes only what this run made, by ids captured at creation, never by title or by
   * time. The workspace itself is a fresh temp directory and is left on disk so a failed run can
   * still be read afterwards; its path is printed at the top.
   */
  for (const id of created.sessionIds) {
    ws.send(JSON.stringify({ t: 'session.delete', sessionId: id }))
    await sleep(400)
  }
  ws.send(JSON.stringify({ t: 'project.remove', projectId: created.projectId }))
  await sleep(600)

  exitCode = failures === 0 ? 0 : 1
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
} catch (err) {
  console.error(`\nthe run stopped early: ${err.message}`)
  if (serverLog) console.error(`\nserver output:\n${serverLog.slice(-1500)}`)
} finally {
  stopServer()
}

process.exit(exitCode)
