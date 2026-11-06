/**
 * Seed an isolated Garden with a REAL project folder and a real account bound to it.
 *
 * The three tests that drive an actual Claude CLI need two things a fresh instance does not have:
 * a project pointing at a real folder on this machine, and an account bound to that project for the
 * `claude` adapter, because the server refuses to launch a Claude session without one.
 *
 * They used to get both by connecting to the owner's live board, where he had already set them up
 * by hand. That is why they were the last three scripts still reaching for port 5178, and why
 * running them put cards on the board he was working on. Pointing them at their own instance fixed
 * the danger and broke the tests, because a fresh instance has no Garden project and no bound
 * account: they failed on their first assertion having proven nothing at all, which is arguably
 * worse than the original problem, since a red test that never ran looks the same as a red test
 * that found something.
 *
 * So the setup he did by hand is done here instead. The accounts themselves are real and are read
 * from `~/.claude-account-map.json`, which `server/src/profiles.ts` reads from the home directory
 * rather than from GARDEN_HOME, so an isolated instance discovers exactly the accounts he has. That
 * is deliberate on their part and it is what makes this possible: the workspace is isolated, the
 * credentials are not, which is the only combination that can test a real CLI without inventing a
 * fake one.
 *
 * Seeded over a short-lived socket of its own, before the test opens its own connection, so the
 * test's first `hello` already carries the finished state and no test has to grow a profiles
 * handler it does not otherwise need.
 */
import WebSocket from 'ws'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Add `path` as a project on the instance at `port` and bind an account to it.
 *
 * Returns the project, with `profiles.claude` populated, or throws saying which half failed. It
 * throws rather than returning null on purpose: a test that carries on without an account produces
 * a launch failure ten assertions later that looks like a bug in the hook spine.
 */
export async function seedRealProject(port, { path = 'C:\\Garden', adapterId = 'claude' } = {}) {
  const state = { projects: [], profiles: [] }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'state') state.projects = m.projects
    else if (m.t === 'project.added') state.projects.push(m.project)
    else if (m.t === 'project.updated') {
      state.projects = state.projects.map((p) => (p.id === m.project.id ? m.project : p))
    } else if (m.t === 'profiles') state.profiles = m.profiles
  })
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello' }))
  await sleep(600)

  const wanted = path.toLowerCase()
  let project = state.projects.find((p) => p.path.toLowerCase() === wanted)
  if (!project) {
    ws.send(JSON.stringify({ t: 'project.add', path: path.replace(/\\/g, '/') }))
    for (let i = 0; i < 30 && !project; i++) {
      await sleep(200)
      project = state.projects.find((p) => p.path.toLowerCase() === wanted)
    }
  }
  if (!project) {
    ws.close()
    throw new Error(`could not add ${path} as a project on port ${port}`)
  }

  // The accounts this machine actually has, discovered from the owner's own map rather than made up.
  ws.send(JSON.stringify({ t: 'profile.refresh' }))
  await sleep(900)

  const profile = state.profiles.find((p) => p.adapterId === adapterId)
  if (!profile) {
    ws.close()
    throw new Error(
      `no ${adapterId} account is available to bind. ` +
        'This machine discovers accounts from ~/.claude-account-map.json, so either that file is ' +
        'missing or it names no config directory for this adapter.',
    )
  }

  ws.send(JSON.stringify({ t: 'project.setProfile', projectId: project.id, adapterId, profileId: profile.id }))
  for (let i = 0; i < 25; i++) {
    await sleep(200)
    project = state.projects.find((p) => p.id === project.id)
    if (project?.profiles?.[adapterId]) break
  }

  ws.close()
  if (!project?.profiles?.[adapterId]) {
    throw new Error(`added ${path} but the ${adapterId} account never bound to it`)
  }
  return project
}
