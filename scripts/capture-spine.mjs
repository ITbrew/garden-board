/**
 * Screenshots of the states the hook spine produces.
 *
 * The ordinary capture script shows a board of terminals. None of the new surfaces appear on it,
 * because they only exist once a CLI has said something: a card waiting on a permission prompt, a
 * subagent card that outlived its agent, a wire that carried a dispatch, a context gauge with a
 * real number in it. So this drives real hook payloads at the receiver and photographs the
 * result.
 *
 * It builds a scratch project and removes it at the end. Nothing here touches the owner's board.
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = Number(process.env.GARDEN_PORT) || 5178
const WIDTH = 3840
const HEIGHT = 1600

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'garden-shots-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# Scratch project\n\nUsed for screenshots.\n')

const st = { projects: [], sessions: [] }
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(700)

async function hook(sessionId, event) {
  await (await fetch(`http://127.0.0.1:${PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: sessionId, receivedAt: Date.now(), event }),
  })).text()
  await sleep(200)
}

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) throw new Error('scratch project was not created')

const names = ['Lead', 'Builder', 'Reviewer']
for (const n of names) {
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title: n }))
  await sleep(1800)
}
const card = (n) => st.sessions.find((s) => s.projectId === project.id && s.title === n)

// Lead: mid turn, with a subagent it dispatched still running and one that finished.
await hook(card('Lead').id, { hook_event_name: 'SessionStart', session_id: 'shot-lead' })
await hook(card('Lead').id, {
  hook_event_name: 'UserPromptSubmit', session_id: 'shot-lead', prompt_id: 'p1',
  prompt: 'take this paragraph, write the canon doc, then dispatch the coding plan',
})
for (const [tu, ag, type, desc] of [
  ['tu-1', 'ag-1', 'Explore', 'find every call site of the loader'],
  ['tu-2', 'ag-2', 'blind-reviewer', 'review the new screen'],
]) {
  await hook(card('Lead').id, {
    hook_event_name: 'PreToolUse', session_id: 'shot-lead', prompt_id: 'p1',
    tool_name: 'Task', tool_use_id: tu, tool_input: { description: desc, subagent_type: type },
  })
  await hook(card('Lead').id, {
    hook_event_name: 'SubagentStart', session_id: 'shot-lead', prompt_id: 'p1',
    tool_use_id: tu, agent_id: ag, agent_type: type,
  })
}
await hook(card('Lead').id, {
  hook_event_name: 'SubagentStop', session_id: 'shot-lead', agent_id: 'ag-1',
  agent_transcript_path: 'C:/nonexistent/agent.jsonl',
})

// A subagent hiring its own, so the board shows a second tier stepping right and down.
const explorer = st.sessions.find((s) => s.projectId === project.id && s.agentId === 'ag-1')
if (explorer) {
  await hook(explorer.id, {
    hook_event_name: 'PreToolUse', session_id: 'shot-lead', prompt_id: 'p9',
    tool_name: 'Task', tool_use_id: 'tu-3',
    tool_input: { description: 'read the loader module', subagent_type: 'Explore' },
  })
  await hook(explorer.id, {
    hook_event_name: 'SubagentStart', session_id: 'shot-lead', prompt_id: 'p9',
    tool_use_id: 'tu-3', agent_id: 'ag-3', agent_type: 'Explore',
  })
}

// Builder: blocked on the owner, which is the state that has to be findable across a wide board.
await hook(card('Builder').id, { hook_event_name: 'SessionStart', session_id: 'shot-builder' })
await hook(card('Builder').id, {
  hook_event_name: 'UserPromptSubmit', session_id: 'shot-builder', prompt_id: 'p2',
  prompt: 'rewrite the loader module',
})
await hook(card('Builder').id, {
  hook_event_name: 'PostToolUse', session_id: 'shot-builder', prompt_id: 'p2',
  tool_name: 'Write', tool_input: { file_path: 'C:/scratch/loader.ts' },
})
await hook(card('Builder').id, {
  hook_event_name: 'PermissionRequest', session_id: 'shot-builder', waiting_for: 'permission prompt',
})

// Reviewer: finished its turn and sitting idle.
await hook(card('Reviewer').id, { hook_event_name: 'SessionStart', session_id: 'shot-rev' })
await hook(card('Reviewer').id, {
  hook_event_name: 'UserPromptSubmit', session_id: 'shot-rev', prompt_id: 'p3', prompt: 'check the diff',
})
await hook(card('Reviewer').id, { hook_event_name: 'Stop', session_id: 'shot-rev', prompt_id: 'p3' })

// A wire the owner drew, so a manual wire and a derived one appear side by side.
ws.send(JSON.stringify({
  t: 'wire.create', projectId: project.id,
  sourceId: card('Lead').id, targetId: card('Builder').id, label: 'work orders',
}))
await sleep(600)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  args: [`--window-size=${WIDTH},${HEIGHT}`, '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(e.stack || String(e)))

await page.goto('http://localhost:5177/', { waitUntil: 'networkidle2' })
await sleep(1500)

// Open the scratch project's tab by its name.
await page.evaluate((name) => {
  const tab = [...document.querySelectorAll('button, .tab')].find((b) => (b.textContent || '').trim().startsWith(name))
  if (tab) tab.click()
}, project.name)
await sleep(1800)

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  console.log('shot:', join(OUT, `${name}.png`))
}

await shot('10-spine-board')

/*
 * Read the DOM for what the wires actually carry, rather than judging arrowheads from a picture.
 * A two-way wire has to end up with both marker attributes on its path element; if the flag never
 * reaches the SVG, the screenshot just looks like an ordinary wire and nothing says why.
 */
const markers = await page.evaluate(() => {
  const paths = [...document.querySelectorAll('.react-flow__edge-path')]
  return {
    total: paths.length,
    withEnd: paths.filter((p) => p.getAttribute('marker-end')).length,
    withStart: paths.filter((p) => p.getAttribute('marker-start')).length,
  }
})
console.log('wire markers:', JSON.stringify(markers))

// Cards must paint over wires. Read the stacking from the DOM rather than judging it by eye.
const stacking = await page.evaluate(() => {
  const node = document.querySelector('.react-flow__node')
  const edges = document.querySelector('.react-flow__edges') || document.querySelector('svg.react-flow__edges')
  const z = (el) => (el ? getComputedStyle(el).zIndex : 'none')
  const opacity = (el) => (el ? getComputedStyle(el).opacity : 'none')
  return {
    nodeZ: z(node),
    edgeZ: z(edges),
    edgeTag: edges ? edges.tagName + '.' + edges.getAttribute('class') : 'not found',
    nodeOpacity: opacity(node),
    nodeBg: node ? getComputedStyle(node.querySelector('.node') || node).backgroundColor : 'none',
  }
})
console.log('stacking:', JSON.stringify(stacking))

/*
 * Do wires paint under the cards?
 *
 * An earlier version of this probe asked elementFromPoint what was on top inside each card and
 * reported "none", twice, while two blind reviewers looking at the screenshots both said a wire
 * ran across a card. The reviewers were right and the probe was worthless: elementFromPoint skips
 * anything with pointer-events none, and a rendered edge path has exactly that, so it could never
 * have returned a wire no matter what was painted.
 *
 * Paint order is a structural fact, so read it structurally: which container comes first in the
 * DOM, and what z-index each one carries. A later sibling wins unless an earlier one is lifted.
 */
const paintOrder = await page.evaluate(() => {
  const viewport = document.querySelector('.react-flow__viewport')
  if (!viewport) return { error: 'no viewport' }
  const kids = [...viewport.children]
  const describe = (el) => ({
    cls: el.getAttribute('class'),
    z: getComputedStyle(el).zIndex,
    index: kids.indexOf(el),
  })
  const edges = kids.find((k) => k.classList.contains('react-flow__edges'))
  const nodes = kids.find((k) => k.classList.contains('react-flow__nodes'))
  return {
    edges: edges ? describe(edges) : 'missing',
    nodes: nodes ? describe(nodes) : 'missing',
    order: kids.map((k) => k.getAttribute('class')),
  }
})
console.log('paint order:', JSON.stringify(paintOrder))

/*
 * Transparency, checked properly this time.
 *
 * The occlusion probe above uses elementFromPoint, which reports the topmost element whether or
 * not it is see-through, so it happily passed while cards were being drawn at 0.72 opacity and
 * every wire behind them showed through. The owner spotted that from the screen. Opacity has to
 * be read directly, on the card and on every ancestor that could dilute it.
 */
const seeThrough = await page.evaluate(() => {
  const bad = []
  for (const node of document.querySelectorAll('.react-flow__node')) {
    let el = node
    let combined = 1
    while (el && el !== document.body) {
      combined *= Number(getComputedStyle(el).opacity || 1)
      el = el.parentElement
    }
    const card = node.querySelector('.node')
    if (card) combined *= Number(getComputedStyle(card).opacity || 1)
    if (combined < 0.999) bad.push(`${(node.textContent || '').slice(0, 20)} @${combined.toFixed(2)}`)
  }
  return bad
})
console.log('see-through cards:', seeThrough.length ? seeThrough.join(' | ') : 'none')

// The working card should be drawing its rotating ring, and only the working card.
const rings = await page.evaluate(() =>
  [...document.querySelectorAll('.react-flow__node')].map((n) => ({
    title: (n.querySelector('.node-title')?.textContent || '').slice(0, 20),
    busy: !!n.querySelector('.node.is-busy'),
  })).filter((r) => r.busy).map((r) => r.title))
console.log('cards drawing the working ring:', rings.length ? rings.join(', ') : 'none')

// The lit border has to be the card's own role colour, or it says "busy" without saying "as what".
const ringColors = await page.evaluate(() =>
  [...document.querySelectorAll('.react-flow__node')].map((n) => {
    const card = n.querySelector('.node')
    if (!card) return null
    return {
      title: (n.querySelector('.node-title')?.textContent || '').slice(0, 22),
      role: getComputedStyle(card).getPropertyValue('--role-color').trim(),
      busy: card.classList.contains('is-busy'),
    }
  }).filter(Boolean))
const controls = await page.evaluate(() => {
  const n = document.querySelector('.react-flow__node')
  return {
    header: [...(n?.querySelectorAll('.node-head button') ?? [])].map((b) => (b.title || b.textContent || '').trim()),
    footer: [...(n?.querySelectorAll('.node-actions button') ?? [])].map((b) => (b.textContent || '').trim()),
  }
})
console.log('card controls:', JSON.stringify(controls))
console.log('role colours:', ringColors.map((r) => `${r.title}=${r.role}${r.busy ? ' (lit)' : ''}`).join(' | '))

// A wire carrying something, caught while it is actually pulsing.
ws.send(JSON.stringify({
  t: 'wire.send',
  wireId: (await (async () => {
    const probe = new Promise((r) => {
      const h = (raw) => {
        const m = JSON.parse(String(raw))
        if (m.t === 'state') { ws.off('message', h); r(m.wires) }
      }
      ws.on('message', h)
    })
    ws.send(JSON.stringify({ t: 'hello' }))
    const wires = await probe
    return wires.find((w) => w.sourceId === card('Lead').id && w.targetId === card('Builder').id)?.id
  })()),
  text: 'canon doc is written, take the loader refactor',
}))
await sleep(400)
await shot('11-wire-carrying')

// The history web: one card per turn, above the session that did the work.
ws.send(JSON.stringify({ t: 'history.open', sessionId: card('Builder').id }))
await sleep(1600)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /fit/i.test(b.title || b.textContent || ''))
  if (btn) btn.click()
})
await sleep(900)
await shot('12-history-web')

console.log(errors.length ? `page errors:\n${errors.slice(0, 5).join('\n')}` : 'no page errors')

await browser.close()

// Put the workspace back exactly as it was.
for (const s of st.sessions.filter((s) => s.projectId === project.id && !s.parentId)) {
  ws.send(JSON.stringify({ t: 'session.delete', sessionId: s.id }))
  await sleep(350)
}
ws.send(JSON.stringify({ t: 'project.remove', projectId: project.id }))
await sleep(700)
ws.close()
console.log('scratch project removed')
