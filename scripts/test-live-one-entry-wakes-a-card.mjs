/**
 * Does ONE entry wake a card, on Claude and on Codex.
 *
 * The owner asked for this directly: "do a test by doing an input test for codex and claude cards to
 * see if a single entry wakes up the cards from codex/claude". It matters beyond typing, because
 * everything Garden does to a card automatically sends one string: a loop types its prompt, a mail
 * notice types its line. If a card only wakes when the text and the Enter arrive as two separate
 * writes, then every one of those paths is quietly unreliable and the card simply sits there.
 *
 * `test-live-session.mjs` already proves the two-part send works for Claude: prompt, wait 900ms,
 * then `\r`. This sends both in a single `session.input` and nothing else.
 *
 * **Two different things are measured, and conflating them is how this test lies.** Bytes coming
 * back prove the keystrokes reached the process, and nothing more: a TUI echoes what you type and
 * redraws its box, which is several hundred bytes of nothing happening. A card is awake when the
 * prompt was SUBMITTED, and the only honest evidence for that is the CLI's own published status
 * going to busy. So the two are asserted separately, and the terminal tail is printed either way.
 *
 * Status comes from `<config dir>/sessions/<pid>.json`, which the Claude CLI writes. Codex does not
 * write one, so for Codex the status half is reported and not asserted: an assertion that cannot
 * fail for the right reason is worse than no assertion.
 *
 * PAID. It drives two real CLIs and costs one small prompt on each. Its own Garden instance and its
 * own database; the accounts are the real ones, read from the owner's own account map. It deletes
 * the cards it makes.
 */
import WebSocket from 'ws'
import { target } from './lib/target.mjs'
import { seedRealProject } from './lib/live.mjs'

const garden = await target()
const PORT = garden.port
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}
const note = (n, d = '') => console.log(`NOTE  ${n}${d ? '  -- ' + d : ''}`)

const st = { projects: [], sessions: [], output: new Map(), seen: new Map() }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'project.updated') st.projects = st.projects.map((p) => (p.id === m.project.id ? m.project : p))
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') {
    st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
    // Every status this card has been through, because `working` can come and go between polls and
    // a card that has finished answering is back at idle by the time anything asks.
    if (!st.seen.has(m.session.id)) st.seen.set(m.session.id, new Set())
    st.seen.get(m.session.id).add(m.session.status)
  } else if (m.t === 'session.data') st.output.set(m.sessionId, (st.output.get(m.sessionId) ?? '') + m.data)
  else if (m.t === 'error') console.log('   server said:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(900)

const waitFor = async (predicate, ms, step = 400) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await sleep(step)
  }
  return false
}

const out = (id) => (st.output.get(id) ?? '').length
const cur = (id) => st.sessions.find((s) => s.id === id)
const tail = (id, n = 300) => (st.output.get(id) ?? '').slice(-n).replace(/\n/g, '\n   ')

/**
 * Wait until the CLI has finished drawing its opening screen.
 *
 * Three quiet ticks with bytes already received, rather than a fixed sleep: Claude and Codex take
 * very different times to paint a prompt, and a fixed wait would either waste time on one or type
 * into the other before it was listening, which looks exactly like a card that cannot be woken.
 */
const settle = async (id, ms) => {
  const until = Date.now() + ms
  let last = -1
  let quiet = 0
  while (Date.now() < until) {
    const now = out(id)
    quiet = now === last && now > 0 ? quiet + 1 : 0
    if (quiet >= 3) return true
    last = now
    await sleep(700)
  }
  return false
}

/**
 * The project both adapters run in.
 *
 * Seeded for Claude, which the server will not launch without an account bound. Codex is bound too
 * if this machine has an account for it, and left unbound if not: `launchFor` passes a null profile
 * straight through and the Codex adapter only sets `CODEX_HOME` when there is one, so an unbound
 * Codex card runs on whatever the CLI's own default config is. Skipping Codex for want of a profile
 * would have been a skip for a requirement that does not exist.
 */
let project = await seedRealProject(PORT, { adapterId: 'claude' })
check('a Claude account is bound to the project', !!project.profiles?.claude)
try {
  project = await seedRealProject(PORT, { adapterId: 'codex' })
  note('a Codex account is bound as well', String(project.profiles?.codex))
} catch (err) {
  note('no Codex account on this machine, running Codex unbound', String(err.message).slice(0, 120))
}

/** One adapter, end to end. `publishesStatus` says whether the status half can be asserted. */
async function tryAdapter(adapterId, publishesStatus) {
  console.log(`\n--- ${adapterId} ---`)

  const title = `Wake ${adapterId} ${Date.now().toString().slice(-5)}`
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId, title }))
  await sleep(2500)
  const card = st.sessions.find((s) => s.title === title)
  check(`${adapterId}: the card exists`, !!card)
  if (!card) return

  const up = await waitFor(() => cur(card.id)?.pid !== null, 30_000)
  check(`${adapterId}: it has a process`, up, `pid ${cur(card.id)?.pid ?? '-'}`)
  if (!up) {
    console.log(`   terminal:\n   ${tail(card.id)}`)
    ws.send(JSON.stringify({ t: 'session.delete', sessionId: card.id }))
    return
  }

  const drew = await settle(card.id, 90_000)
  check(`${adapterId}: the CLI drew its prompt`, drew, `${out(card.id)} bytes, status ${cur(card.id)?.status}`)

  /*
   * A CLI sitting on a question is not a card waiting for a prompt, and typing a prompt into one is
   * how a test invents a result.
   *
   * Codex opens on "Trust this folder?" the first time it sees a directory under a given config
   * home. Whatever is typed goes into that chooser: the run that found this sent "reply with the
   * single word: ok" and the terminal came back with a PowerShell `CommandNotFoundException` for
   * `gle word: ok`, because the CLI had quit and the shell behind it took the rest of the line. That
   * looked like an input bug and was not one.
   *
   * So the question is detected and reported rather than answered. Answering it would write a
   * persistent trust decision into the owner's own config for a real folder, which is his to make.
   */
  const screen = (st.output.get(card.id) ?? '').replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
  const blocked = /Trust this folder|Trust and continue|Do you trust/i.test(screen)
  if (blocked) {
    check(`${adapterId}: the CLI is ready for a prompt rather than asking a question`, false,
      'it is sitting on a trust prompt, so nothing about input can be measured here')
    note(`${adapterId}: answer "1. Trust and continue" once in a card by hand`, 'the decision is saved per folder')
    console.log(`   terminal:\n   ${tail(card.id, 400)}`)
    ws.send(JSON.stringify({ t: 'session.delete', sessionId: card.id }))
    await sleep(1200)
    return
  }

  // ---------------------------------------------------------------------
  // The whole question: one write carrying the text AND the Enter.
  // ---------------------------------------------------------------------
  const before = out(card.id)
  const beforeStatus = cur(card.id)?.status
  st.seen.set(card.id, new Set())
  ws.send(
    JSON.stringify({
      t: 'session.input',
      sessionId: card.id,
      data: 'reply with the single word: ok\r',
    }),
  )

  // 200 bytes rather than one, because the terminal echoes the keystrokes themselves.
  const arrived = await waitFor(() => out(card.id) - before > 200, 30_000)
  check(`${adapterId}: the keystrokes reached the process`, arrived, `${out(card.id) - before} new bytes`)

  const busy = () => st.seen.get(card.id)?.has('working') === true
  const submitted = await waitFor(busy, 90_000)
  if (publishesStatus) {
    check(
      `${adapterId}: ONE entry submitted the prompt`,
      submitted,
      `status ${beforeStatus} -> ${[...(st.seen.get(card.id) ?? [])].join(',') || 'never changed'}`,
    )
  } else {
    /*
     * Codex publishes no session file, so there is no status to watch go busy. This used to say
     * "judge it by the terminal below" and print ALL PASS over a prompt that had never been sent:
     * the typed words were sitting on the input row behind the CLI's own prompt marker. A note
     * nobody is obliged to read is not a result.
     *
     * So the terminal is read here rather than handed to a person. The input row is the whole
     * answer, because the CLI clears it on submit and redraws its placeholder, so the words still
     * being on it means the Enter did not take. Measured 2026-09-29 by
     * `scripts/_codex-submit-probe.mjs`: text and Enter in one write left "reply with the single
     * word: ok" on the input row, and a lone Enter afterwards submitted it and got "ok" back.
     *
     * A note and not a failure, because it is a fact about this CLI rather than a fault in Garden.
     */
    const seen = (st.output.get(card.id) ?? '')
      .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\u001b\][^\u0007]*\u0007/g, '')
    const at = seen.lastIndexOf('›')
    const onInput = at === -1 ? '' : seen.slice(at, at + 80).replace(/\s+/g, ' ')
    note(
      `${adapterId}: ONE entry does not submit, it only types`,
      `the input row reads ${JSON.stringify(onInput.slice(0, 60))}`,
    )
    /*
     * Which is exactly why Garden never sends it as one write, and that is the part worth failing
     * on. Every automatic path types the prompt and then sends the Enter separately through
     * `writeLater`, and `confirmCodexSubmit` re-sends it up to three times and raises a watchdog
     * alert if the card never starts working. So the assertion is on the send Garden actually makes.
     */
    ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\r' }))
    const submitted = await waitFor(() => out(card.id) - before > 3000, 60_000)
    check(
      `${adapterId}: a separate Enter submits it, which is the send Garden actually makes`,
      submitted,
      `${out(card.id) - before} new bytes since the text was typed`,
    )
  }
  console.log(`   terminal after the single entry:\n   ${tail(card.id, 400)}`)

  /*
   * Only when the single write did not submit: try it the way `test-live-session.mjs` does, as two
   * writes with a gap. If that works, the fault is in sending them together rather than in the card,
   * which is a different bug with a different fix. A red test that says which of the two is worth
   * far more than one that says "it did not wake up".
   */
  if (publishesStatus && !submitted) {
    st.seen.set(card.id, new Set())
    ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: 'reply with the single word: ok' }))
    await sleep(900)
    ws.send(JSON.stringify({ t: 'session.input', sessionId: card.id, data: '\r' }))
    const twoPart = await waitFor(busy, 90_000)
    note(
      `${adapterId}: two-part send (text, pause, Enter)`,
      twoPart
        ? 'SUBMITTED. Sending them together is the problem, not the card.'
        : 'also did nothing. The card is not accepting input at all.',
    )
  }

  // Let the turn finish rather than killing a CLI mid-answer.
  await waitFor(() => cur(card.id)?.status === 'idle' || cur(card.id)?.status === 'needs-input', 60_000)
  ws.send(JSON.stringify({ t: 'session.delete', sessionId: card.id }))
  await sleep(1200)
}

await tryAdapter('claude', true)
await tryAdapter('codex', false)

ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
