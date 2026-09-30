/**
 * Ship a Garden change to the running board in one step, and prove both halves came back on it.
 *
 * Usage: node scripts/ship.mjs <version> <commit message file>
 *
 * Why it exists. The owner kept finding "builds differ" in his header, and on 2026-09-30 it came from
 * the version being bumped in the working tree well before the restart: Vite re-read package.json when
 * the lockfile changed and served the new number while the server was still on the old one. Every
 * step that can leave the halves apart is done here, in this order, with nothing in between:
 *
 *   1. Refuse if a version bump is already sitting uncommitted (that is the split waiting to happen).
 *   2. Typecheck.
 *   3. Bump the three package.json files and the lockfile.
 *   4. Commit what is staged, with the version files, using the message file.
 *   5. Restart the board exactly as its Restart button does (both halves), noting which cards were
 *      running and starting any the restart left off.
 *   6. Verify: the server's /health reports the version and HEAD's commit, and the page the owner is
 *      looking at (read through Chrome's debugging port, never clicked) shows the same version and no
 *      "builds differ" chip. Anything else exits 1 with what differs.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (s) => console.log(`[ship] ${s}`)
const die = (s) => {
  console.error(`[ship] FAILED: ${s}`)
  process.exit(1)
}
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

const [version, messageFile] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !messageFile || !existsSync(messageFile)) {
  die('usage: node scripts/ship.mjs <version> <commit message file>')
}
const FILES = ['package.json', 'server/package.json', 'apps/web/package.json']
const PORT = 5178
const PAGE = '5177'

// 1. No bump may be waiting in the working tree.
for (const f of FILES) {
  const now = JSON.parse(readFileSync(join(ROOT, f), 'utf8')).version
  const head = JSON.parse(git('show', `HEAD:${f}`)).version
  if (now !== head) die(`${f} is at ${now} but HEAD has ${head}. A bump outside this script is how the halves split; revert it.`)
}

// 2. Typecheck.
say('typecheck')
try {
  execFileSync('npm', ['run', 'typecheck'], { cwd: ROOT, stdio: 'inherit', shell: true })
} catch {
  die('typecheck')
}

// 3. Bump.
for (const f of FILES) {
  const path = join(ROOT, f)
  writeFileSync(path, readFileSync(path, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`), 'utf8')
}
execFileSync('npm', ['install', '--package-lock-only', '--prefix', ROOT], { cwd: ROOT, stdio: 'ignore', shell: true })

// 4. Commit.
git('add', ...FILES, 'package-lock.json')
git('commit', '-q', '-F', resolve(messageFile))
const head = git('rev-parse', '--short=7', 'HEAD')
say(`committed ${head}`)

// 5. Restart, as the button does, and bring back what was running.
const key = readFileSync(join(homedir(), '.garden', 'owner.key'), 'utf8').trim()
const connect = () =>
  new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    let sessions = []
    ws.on('error', fail)
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      if (m.t === 'state') sessions = m.sessions
    })
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', key }))
      setTimeout(() => ok({ ws, sessions: () => sessions }), 1500)
    })
  })
const health = async () => {
  try {
    return (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()).build ?? null
  } catch {
    return null
  }
}
const off = (s) => s.pid == null || ['stopped', 'failed', 'done'].includes(s.status)
const before = await connect()
const running = before.sessions().filter((s) => s.kind === 'session' && s.closedAt == null && !off(s))
const oldStart = (await health())?.startedAt
say(`restarting; ${running.length} cards running`)
before.ws.send(JSON.stringify({ t: 'server.restart' }))
setTimeout(() => before.ws.terminate(), 1000)

let build = null
for (let i = 0; i < 120; i++) {
  await sleep(2000)
  build = await health()
  if (build?.startedAt && build.startedAt !== oldStart) break
}
if (!build || build.startedAt === oldStart) die('the server did not come back within four minutes')

await sleep(15000)
const after = await connect()
for (const r of running) {
  const now = after.sessions().find((s) => s.id === r.id)
  if (now && off(now)) {
    say(`starting ${now.title} again`)
    after.ws.send(JSON.stringify({ t: 'session.start', sessionId: now.id }))
    await sleep(3000)
  }
}
after.ws.close()

// 6. Verify both halves.
const bare = (c) => String(c ?? '').replace(/\+$/, '')
const problems = []
if (build.version !== version) problems.push(`server is v${build.version}, wanted v${version}`)
if (bare(build.commit) !== head) problems.push(`server is on ${build.commit}, HEAD is ${head}`)
try {
  const puppeteer = require('puppeteer-core')
  const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })
  const page = (await b.pages()).find((p) => p.url().includes(PAGE))
  if (!page) problems.push(`no page on ${PAGE} in the debugging Chrome`)
  else {
    let seen = null
    for (let i = 0; i < 20; i++) {
      seen = await page.evaluate(() => ({
        version: document.querySelector('.brand-version')?.textContent ?? null,
        split: document.querySelector('.brand-split')?.title ?? null,
      }))
      if (seen.version === `v${version}` && !seen.split) break
      await sleep(1500)
    }
    if (seen.version !== `v${version}`) problems.push(`page shows ${seen.version}, wanted v${version}`)
    if (seen.split) problems.push(`page shows "builds differ": ${seen.split}`)
  }
  await b.disconnect()
} catch (err) {
  problems.push(`could not read the page: ${err.message}`)
}
if (problems.length) die(problems.join('; '))
say(`OK: server and page both on v${version} (${head}), no "builds differ"`)
process.exit(0)
