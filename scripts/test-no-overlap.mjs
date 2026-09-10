/**
 * The rule, and its one exception: cards keep a real gap from each other, except two rows of one
 * card's own web column, which keep the tighter gap the server is built to give them.
 *
 * The owner's words are that the board should read like photographs in an album. Not merely that
 * two cards are not on the same pixel, but that there is a visible gap between every pair of
 * borders, and that a session's roots hanging below it and its history stacked above it are cards
 * like any other and obey the same rule.
 *
 * The one place that gap narrows on purpose: two cards stacked in the SAME session's own web
 * column, such as two files in its Instructions column or two turns in its history. The server
 * packs those at BOARD.WEB_ROW_GAP, 8px (packages/shared/src/index.ts), tighter than the 26px
 * every other pair keeps, because a web's own column is meant to read as a list, not as a
 * scattering of separate photographs. This file checks that narrower gap wherever it genuinely
 * applies (same owner, same column) and still checks the full 26px everywhere else: between
 * different columns of the same web, between two different webs, between a web and the card that
 * owns it, and between any two cards that have nothing to do with each other.
 *
 * This is the failure it was written for: opening the roots web under a card put the file cards on
 * top of the card below, and opening two webs on neighbouring cards put those webs through each
 * other. Both of those look, from one screenshot of one corner, exactly like a board that is fine.
 * So this measures every pair of stored rectangles instead, which is the only way to see all of it
 * at once.
 *
 * Runs against a server of its own, so it can open and close things freely without touching the
 * board the owner is working on.
 */
import WebSocket from 'ws'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const PAD = 26
/**
 * Row-to-row inside one web column, tighter by design: packages/shared/src/index.ts's
 * BOARD.WEB_ROW_GAP. A web's own column is a list, not a scattering of separate cards, and the
 * owner asked for it to read as one.
 */
const ROW_GAP = 8
/**
 * How tall a collapsed card really draws: packages/shared/src/index.ts's BOARD.COLLAPSED_H. This
 * was 38 here, which does not match what the server actually reserves and made the row-to-row
 * gap this file measured come out 14px short of the real thing on every collapsed pair.
 */
const COLLAPSED_H = 52
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const garden = await startInstance()
const st = { projects: [], sessions: [], docs: [] }
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)

const apply = (m) => {
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs })
  else if (m.t === 'project.added') st.projects.push(m.project)
  else if (m.t === 'session.added') st.sessions.push(m.session)
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'doc.added') st.docs.push(m.card)
  else if (m.t === 'doc.updated') st.docs = st.docs.map((d) => (d.id === m.card.id ? m.card : d))
  else if (m.t === 'doc.removed') st.docs = st.docs.filter((d) => d.id !== m.cardId)
  else if (m.t === 'error' && m.message !== '__connected__') console.log('   server said:', m.message)
}
ws.on('message', (raw) => apply(JSON.parse(String(raw))))
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)

/** A project with enough files that a roots web is a real block rather than one card. */
const dir = mkdtempSync(join(tmpdir(), 'garden-overlap-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n\nSome instructions.\n')
mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
for (const n of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
  writeFileSync(join(dir, '.claude', 'skills', `${n}.md`), `# ${n}\n\nA file this session runs from.\n`)
}
mkdirSync(join(dir, 'docs'), { recursive: true })
for (const n of ['one', 'two', 'three', 'four']) {
  writeFileSync(join(dir, 'docs', `${n}.md`), `# ${n}\n`)
}

ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1500)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())
if (!project) {
  console.log('FAIL  scratch project')
  await garden.stop()
  process.exit(1)
}

const make = async (title, reportsTo) => {
  ws.send(JSON.stringify({ t: 'session.create', projectId: project.id, adapterId: 'shell', title, reportsTo, start: false }))
  await sleep(700)
  return st.sessions.find((s) => s.title === title)
}

/** Every pair of cards closer than the padding, named so a failure says what landed on what. */
function tooClose() {
  const cards = [
    ...st.sessions.filter((s) => s.projectId === project.id).map((s) => ({ ...s, name: s.title, kind: 'session' })),
    ...st.docs
      .filter((d) => d.projectId === project.id)
      .map((d) => ({ ...d, name: d.title, kind: d.web === 'history' ? 'history' : d.web === 'context' ? 'roots' : 'doc' })),
  ].map((c) => ({ ...c, h: c.collapsed ? COLLAPSED_H : c.height }))

  const bad = []
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i]
      const b = cards[j]
      const gap = Math.max(
        Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)),
        Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)),
      )
      /*
       * Two rows of the SAME web column are one list, not two photographs. Only a session and a
       * doc card ever carry both `ownerId` and `group`, and a plain loose doc carries neither, so
       * this only relaxes the pairs the server itself packs at WEB_ROW_GAP: two files in one
       * session's Instructions column, two turns in one session's history, and so on. A different
       * column of the same web, a different web entirely, or a card that owns nothing still needs
       * the full PAD.
       */
      const sameColumn = a.ownerId && a.ownerId === b.ownerId && a.group && a.group === b.group
      const minGap = sameColumn ? ROW_GAP : PAD
      if (gap < minGap) bad.push(`[${a.kind}] ${a.name} and [${b.kind}] ${b.name} are ${Math.round(gap)}px apart`)
    }
  }
  return bad
}

const report = (label) => {
  const bad = tooClose()
  check(label, bad.length === 0, bad.slice(0, 4).join('; '))
  return bad
}

const top = await make('Lead', null)
const left = await make('Coder', top.id)
const right = await make('Writer', top.id)
check('three cards exist', !!top && !!left && !!right)
report('a fresh board keeps every card apart')

// --- roots below a card ---

ws.send(JSON.stringify({ t: 'context.open', sessionId: left.id }))
await sleep(2000)
const rootCards = st.docs.filter((d) => d.ownerId === left.id && d.web === 'context')
check('the roots web opened with cards in it', rootCards.length > 0, `${rootCards.length} files`)
report('roots below a card clear everything, including the card that owns them')

// The specific thing he described: a gap between the card and the block hanging off it.
const owner = st.sessions.find((s) => s.id === left.id)
const highestRoot = Math.min(...rootCards.map((d) => d.y))
const ownerBottom = owner.y + (owner.collapsed ? 38 : owner.height)
check(
  'and there is real vertical space between the card and its roots',
  highestRoot - ownerBottom >= PAD,
  `${Math.round(highestRoot - ownerBottom)}px`,
)

// --- history above a card, while the roots are still open ---

ws.send(JSON.stringify({ t: 'history.open', sessionId: left.id }))
await sleep(1500)
report('history above a card clears everything too')

// --- two webs open on neighbouring cards at once ---

ws.send(JSON.stringify({ t: 'context.open', sessionId: right.id }))
await sleep(2000)
report('two roots webs open side by side stay out of each other')

ws.send(JSON.stringify({ t: 'history.open', sessionId: top.id }))
await sleep(1500)
report('a history web opening between two open roots webs still fits')

/*
 * Arranging is computed in the browser and arrives here as a finished set of positions, so it is
 * not reachable from a script and is not covered here. The board-level shape checks live with the
 * canvas tests.
 */

// --- folding a web away leaves the board as it found it ---

ws.send(JSON.stringify({ t: 'context.close', sessionId: left.id }))
await sleep(1200)
report('closing a roots web leaves nothing covering anything')

/*
 * And folding them away and opening them again, which is where the owner saw it come back.
 *
 * Closing gives back the room that was made, so the second open starts from a board that has
 * already been moved once. Anything that measures from where a card is now rather than from where
 * it was originally is wrong on the second pass and right on the first, which is exactly the kind
 * of bug that survives a test that only ever opens things once.
 */
ws.send(JSON.stringify({ t: 'history.close', sessionId: left.id }))
await sleep(1000)
ws.send(JSON.stringify({ t: 'context.open', sessionId: left.id }))
await sleep(2000)
report('reopening roots after closing them still clears everything')
ws.send(JSON.stringify({ t: 'history.open', sessionId: left.id }))
await sleep(1500)
report('and reopening history too')

for (let round = 0; round < 2; round++) {
  ws.send(JSON.stringify({ t: 'context.close', sessionId: left.id }))
  ws.send(JSON.stringify({ t: 'history.close', sessionId: left.id }))
  await sleep(1200)
  ws.send(JSON.stringify({ t: 'context.open', sessionId: left.id }))
  ws.send(JSON.stringify({ t: 'history.open', sessionId: left.id }))
  await sleep(2200)
  report(`after ${round + 2} rounds of folding both webs away and back, nothing covers anything`)
}

// --- a card's webs belong to that card, and stay with it ---

/*
 * Two sessions in one project share files. The project's CLAUDE.md is in the roots of both, and
 * while a card was keyed by path alone there was only ever one card for it, so opening the second
 * session's roots reached into the first session's block and took cards out of it.
 */
const beforeCount = st.docs.filter((d) => d.ownerId === left.id && d.web === 'context').length
ws.send(JSON.stringify({ t: 'context.open', sessionId: top.id }))
await sleep(2200)
const afterCount = st.docs.filter((d) => d.ownerId === left.id && d.web === 'context').length
check('opening another card roots does not take cards out of this one', afterCount === beforeCount, `${beforeCount} then ${afterCount}`)
check('and the other card has its own roots', st.docs.filter((d) => d.ownerId === top.id && d.web === 'context').length > 0)
const shared = st.docs.filter((d) => d.relPath.endsWith('CLAUDE.md') && d.web === 'context')
check('a file both of them run from has a card each', new Set(shared.map((d) => d.ownerId)).size >= 2,
  `${shared.length} cards across ${new Set(shared.map((d) => d.ownerId)).size} owners`)
report('and both blocks stay clear of everything')

/*
 * Then the one he worked out himself: the roots are placed against the bottom edge of the card, so
 * a card dragged taller afterwards grows straight down over its own block.
 */
const rootsTop = () => Math.min(...st.docs.filter((d) => d.ownerId === left.id && d.web === 'context').map((d) => d.y))
const before = { top: rootsTop(), card: st.sessions.find((s) => s.id === left.id) }
ws.send(JSON.stringify({ t: 'session.setBox', sessionId: left.id, width: 780, height: 620 }))
await sleep(1400)
const after = { top: rootsTop(), card: st.sessions.find((s) => s.id === left.id) }
check('growing a card moves its roots down with it', after.top > before.top,
  `roots top ${Math.round(before.top)} then ${Math.round(after.top)}`)
check('by as much as the card grew', Math.abs(after.top - before.top - (after.card.height - before.card.height)) < 2)
report('and a card grown to twice its height still covers nothing')

/*
 * And the size presets, which are the other way a card changes shape. Large and Full are worked out
 * rather than dragged, and while the server never heard what they came to it placed roots against
 * an edge the card did not have.
 */
const ownSize = { ...st.sessions.find((s) => s.id === left.id) }
for (const [size, dims] of [['large', {}], ['full', { width: 1900, height: 1100 }], ['normal', {}]]) {
  ws.send(JSON.stringify({ t: 'session.setSize', sessionId: left.id, size, ...dims }))
  await sleep(1400)
  const card = st.sessions.find((s) => s.id === left.id)
  const rootTop = rootsTop()
  check(`set to ${size}, the card knows its own size`, card.width > 0 && card.height > 0,
    `${card.width}x${card.height}`)
  check(`and its roots hang below its real bottom edge`, rootTop > card.y + card.height,
    `card ends ${Math.round(card.y + card.height)}, roots start ${Math.round(rootTop)}`)
  report(`and nothing overlaps at ${size}`)
}
// Stepping back down has to actually come back down, or the button only goes one way.
const shrunk = st.sessions.find((s) => s.id === left.id)
check('stepping back to normal returns the card to the size he had it at',
  shrunk.width === ownSize.width && shrunk.height === ownSize.height,
  `${shrunk.width}x${shrunk.height} against ${ownSize.width}x${ownSize.height}`)

ws.send(JSON.stringify({ t: 'session.setCollapsed', sessionId: left.id, collapsed: true }))
await sleep(1200)
report('folding the card to its header keeps its roots clear')
ws.send(JSON.stringify({ t: 'session.setCollapsed', sessionId: left.id, collapsed: false }))
await sleep(1200)
report('and opening it again')

ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
