#!/usr/bin/env node
/**
 * The overseer's eyes: look at the board the way the owner does. docs/canonical/27-the-overseer.md.
 *
 *   garden-eyes.mjs --read                   the board as JSON: every card, its status, its unread
 *                                            badge, what sits in its input line, and the Health list
 *   garden-eyes.mjs --shot <file.png>        a screenshot of the board as it is on screen
 *   garden-eyes.mjs --profile <seconds>      what the board window spends its CPU on, for that long
 *
 *   --port <n>     Chrome's DevTools port (default 9222, the one the board window opens)
 *   --board <re>   which tab is the board, as a regular expression on its URL (default :5177/ or :5178/)
 *
 * READ-ONLY, AND THAT IS ENFORCED HERE RATHER THAN PROMISED. It attaches to the owner's board tab
 * and uses Runtime.evaluate on an expression that only reads, Page.captureScreenshot and the
 * profiler. It never sends anything from the Input domain, never navigates, never scrolls, never
 * focuses. When the Keeper needs to act it does so through Garden's own commands, which record what
 * they did, not by clicking a page.
 *
 * If no board tab is open it opens one in the background, reads it, and closes it. It never launches
 * a browser: no Chrome on that port means it says so and exits, because nothing of the overseer may
 * outlive Garden or start without it.
 */
import { writeFileSync } from 'node:fs'

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

const argv = process.argv.slice(2)
const opts = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--read') opts.read = true
  else if (['--shot', '--profile', '--port', '--board'].includes(a)) {
    const v = argv[++i]
    if (v === undefined) fail(`${a} was given with nothing after it.`)
    opts[a.slice(2)] = v
  } else fail(`I do not know the argument "${a}". I take --read, --shot <file>, --profile <seconds>, --port and --board.`)
}
const modes = ['read', 'shot', 'profile'].filter((m) => opts[m] !== undefined)
if (modes.length !== 1) fail('Give exactly one of --read, --shot <file> or --profile <seconds>.')
const PORT = Number(opts.port) || 9222
const BOARD = new RegExp(opts.board ?? ':(5177|5178)/')

// ---------------------------------------------------------------------------- a minimal CDP client

async function json(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`).catch(() => null)
  if (!r || !r.ok) fail(`No Chrome is answering on port ${PORT}. The board window is not open, so there is nothing to look at.`, 2)
  return r.json()
}

const version = await json('/json/version')
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error('could not open the DevTools socket'))
})
let nextId = 1
const pending = new Map()
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result)
  }
}
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------- find the board

const { targetInfos } = await cdp('Target.getTargets')
let target = targetInfos.find((t) => t.type === 'page' && BOARD.test(t.url))
let opened = null
if (!target) {
  if (modes[0] === 'profile') fail('No board tab is open, so there is no board window to profile.', 2)
  // Somewhere to read from: the board's own address on this Chrome's origin, in the background.
  const any = targetInfos.find((t) => t.type === 'page' && /^https?:\/\/(127\.0\.0\.1|localhost):\d+\//.test(t.url))
  if (!any) fail('No board tab is open and no Garden page to take its address from.', 2)
  const created = await cdp('Target.createTarget', { url: any.url, background: true })
  opened = created.targetId
  target = { targetId: opened }
}
const { sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })

async function done(code = 0) {
  try {
    await cdp('Target.detachFromTarget', { sessionId })
    if (opened) await cdp('Target.closeTarget', { targetId: opened })
  } catch {
    // The tab went while we were looking; nothing is left to close.
  }
  ws.close()
  process.exit(code)
}

const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

if (opened) {
  // A fresh background tab has to load and receive the board's state before there is anything to read.
  for (let i = 0; i < 60; i++) {
    if (await evaluate("document.querySelectorAll('.react-flow__node').length > 0").catch(() => false)) break
    await sleep(250)
  }
  await sleep(1000)
}

// ---------------------------------------------------------------------------- the three looks

/*
 * Read, never write: every line below is a query. The input line's value is read from the owner's
 * own tab, which is the point of attaching to it: text he typed and has not sent is only there.
 */
const READ = `(() => {
  const text = (root, sel) => root.querySelector(sel)?.textContent?.trim() || null
  const cards = [...document.querySelectorAll('.react-flow__node')].map((n) => {
    const input = n.querySelector('.node-input input')
    const node = n.querySelector('.node')
    return {
      id: n.getAttribute('data-id'),
      title: text(n, '.node-title'),
      status: text(n, '.node-status'),
      off: node ? node.classList.contains('is-off') : null,
      unread: text(n, '.node-unread__count'),
      alert: text(n, '.node-alert__headline'),
      alertReason: text(n, '.node-alert__reason'),
      inputLine: input && input.value ? input.value : null,
    }
  }).filter((c) => c.title)
  const health = [...document.querySelectorAll('.health-row')].map((r) => ({
    severity: [...r.classList].find((c) => c.startsWith('health-row--'))?.slice('health-row--'.length) ?? null,
    title: text(r, '.health-row__title'),
    meta: text(r, '.health-row__meta'),
  }))
  return {
    at: Date.now(),
    title: document.title,
    visible: document.visibilityState,
    cards,
    health,
  }
})()`

try {
  if (modes[0] === 'read') {
    process.stdout.write(JSON.stringify(await evaluate(READ), null, 2) + '\n')
  } else if (modes[0] === 'shot') {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId)
    writeFileSync(opts.shot, Buffer.from(data, 'base64'))
    process.stdout.write(`${opts.shot}\n`)
  } else {
    const seconds = Math.min(60, Math.max(1, Number(opts.profile) || 10))
    await cdp('Performance.enable', {}, sessionId)
    const before = Object.fromEntries((await cdp('Performance.getMetrics', {}, sessionId)).metrics.map((m) => [m.name, m.value]))
    await cdp('Profiler.enable', {}, sessionId)
    await cdp('Profiler.setSamplingInterval', { interval: 1000 }, sessionId)
    await cdp('Profiler.start', {}, sessionId)
    await sleep(seconds * 1000)
    const { profile } = await cdp('Profiler.stop', {}, sessionId)
    const after = Object.fromEntries((await cdp('Performance.getMetrics', {}, sessionId)).metrics.map((m) => [m.name, m.value]))
    await cdp('Profiler.disable', {}, sessionId)
    await cdp('Performance.disable', {}, sessionId)
    process.stdout.write(JSON.stringify(summarise(profile, before, after, seconds), null, 2) + '\n')
  }
} catch (err) {
  process.stderr.write(`${err.message}\n`)
  await done(1)
}
await done(0)

/**
 * What the window spent its time on, in the terms that decide a fix: how much of each second went
 * to script, layout and style, and which functions took the most of it by their own time.
 */
function summarise(profile, before, after, seconds) {
  const per = (name) => +(((after[name] ?? 0) - (before[name] ?? 0)) / seconds).toFixed(3)
  const total = profile.endTime - profile.startTime
  const samples = profile.samples?.length ?? 0
  const perSample = samples ? total / samples : 0
  const self = new Map()
  for (const n of profile.nodes) {
    const f = n.callFrame
    const name = f.functionName || '(anonymous)'
    if (name === '(idle)' || name === '(program)' || name === '(root)') continue
    const where = f.url ? `${f.url.split('/').pop()}:${f.lineNumber + 1}` : f.functionName ? '(native)' : ''
    const key = `${name} ${where}`
    self.set(key, (self.get(key) ?? 0) + (n.hitCount ?? 0) * perSample)
  }
  const idle = profile.nodes.filter((n) => n.callFrame.functionName === '(idle)').reduce((t, n) => t + (n.hitCount ?? 0) * perSample, 0)
  return {
    seconds,
    busyShare: total ? +(1 - idle / total).toFixed(3) : null,
    perSecond: {
      scriptSeconds: per('ScriptDuration'),
      layoutSeconds: per('LayoutDuration'),
      styleSeconds: per('RecalcStyleDuration'),
      taskSeconds: per('TaskDuration'),
      layouts: per('LayoutCount'),
      styleRecalcs: per('RecalcStyleCount'),
    },
    domNodes: after.Nodes ?? null,
    jsHeapMB: after.JSHeapUsedSize ? Math.round(after.JSHeapUsedSize / 1024 / 1024) : null,
    topSelfTime: [...self]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([fn, us]) => ({ fn, ms: Math.round(us / 1000), share: total ? +(us / total).toFixed(3) : null })),
  }
}
