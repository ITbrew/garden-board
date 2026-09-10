/**
 * A browser test's own Garden, with a board already on it.
 *
 * The browser tests were the last ones still reaching for the owner's machine. They opened
 * `http://127.0.0.1:5177`, which is the Vite dev server, and then read whatever cards happened to be
 * on the board that day. So they only passed while he had the app running with the right things on
 * screen, they failed as "broken" whenever he did not, and anything they clicked was clicked on his
 * real work.
 *
 * This gives them a server of their own with its own workspace, serves the built app off that same
 * port, and puts a known board on it before the page is opened. What a test asserts is then a fact
 * about the code rather than a fact about what the owner left open.
 *
 * Needs `npm run build` first, since the app being served is the built one. That is deliberate: a
 * test that runs the TypeScript through a watcher restarts itself halfway through when a file is
 * saved.
 */
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Start one and seed it.
 *
 * `cards` is a list of titles, or of `{ title, roleClass, reportsTo }` where `reportsTo` is the
 * INDEX of an earlier card in the same list, so a test can describe a chain without knowing the ids
 * that do not exist yet. Cards are created switched off: a browser test is about what is drawn, and
 * spawning real shells to look at a layout is a cost with nothing to show for it.
 *
 * `files` seeds the scratch project folder, for the tests that open a document card.
 */
export async function openBoard({ cards = [], files = {}, projectName = 'scratch' } = {}) {
  const garden = await startInstance()
  const dir = mkdtempSync(join(tmpdir(), `garden-${projectName}-`))
  writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8')

  const state = { projects: [], sessions: [], docs: [], wires: [] }
  const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') Object.assign(state, { projects: m.projects, sessions: m.sessions, docs: m.docs, wires: m.wires })
    else if (m.t === 'project.added') state.projects.push(m.project)
    else if (m.t === 'session.added') state.sessions.push(m.session)
    else if (m.t === 'doc.added') state.docs.push(m.card)
    else if (m.t === 'wire.added') state.wires.push(m.wire)
    /*
     * Kept because opening a card's history is two steps: a bare `history.open` answers with the
     * days that exist and draws nothing, and a day is unfolded by name. A test that does not hold
     * onto this answer cannot take the second step, and reports zero turns for a card that has
     * taken several.
     */
    else if (m.t === 'history.groups') state.groups = m.groups
  })
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello' }))
  await sleep(400)

  ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
  await sleep(1200)
  const project = state.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
  if (!project) {
    await garden.stop()
    throw new Error('the scratch project was not added')
  }

  const made = []
  for (const entry of cards) {
    const spec = typeof entry === 'string' ? { title: entry } : entry
    const parent = typeof spec.reportsTo === 'number' ? made[spec.reportsTo]?.id ?? null : null
    ws.send(
      JSON.stringify({
        t: 'session.create',
        projectId: project.id,
        adapterId: 'shell',
        title: spec.title,
        roleClass: spec.roleClass ?? null,
        reportsTo: parent,
        start: false,
      }),
    )
    await sleep(450)
    made.push(state.sessions.find((s) => s.title === spec.title))
  }

  return {
    port: garden.port,
    home: garden.home,
    /** Where the built app is, on this instance's own port rather than the dev server's. */
    UI: `http://127.0.0.1:${garden.port}`,
    ws,
    state,
    project,
    cards: made,
    dir,
    async stop() {
      try {
        ws.close()
      } catch {
        // Already gone, which is not worth failing a test over.
      }
      await garden.stop()
    },
  }
}
