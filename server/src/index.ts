import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import {
  BOARD,
  DEFAULT_LIMITS,
  DEFAULT_PORT,
  FRAME_HEADROOM,
  WS_PATH,
  drawnOnBoard,
  type AgentEvent,
  type ClientMessage,
  type ServerMessage,
  type Project,
  type TerminalSession,
  type DocCard,
  type Channel,
  type Wire,
  type WireKind,
  type TaskContract,
  type TaskReassignment,
  type TaskState,
  type ReassignReason,
  type BoundaryResult,
} from '@garden/shared'
import { BUILD } from './build.js'
import { Store } from './store.js'
import { PtyManager } from './pty-manager.js'
import { getAdapter, isAdapterId } from './adapters.js'
import { contentTypeOf, kindOf, listMarkdown, mtimeOf, readDoc, readExternalDoc, safeJoin, writeDoc, writeExternalDoc } from './docs.js'
import { createReadStream } from 'node:fs'
import { scanContext } from './context-web.js'
import { ensureMemory, memoryDirFor, writeCardBrief } from './memory.js'
import { mailDirFor, postMessage, recordSent, writePeers, writePowers, type Peer } from './mail.js'
import { hasSubstance, historyDirFor, stamp, writeAgentHistory, writeHistory } from './history.js'
import { readChat, renderTranscript } from './transcript.js'
import { reachAgent } from './agent-reach.js'
import {
  MAIL_KINDS,
  completionReport,
  confirmGuard,
  hopsForTask,
  isMailKind,
  isLifecycleKind,
  ownershipGuard,
  participantsOfTask,
  pathInsideAny,
  reassignEvidence,
  spiralGuard,
  verifierAncestry,
  type CardFacts,
  type MailKind,
} from './tasks.js'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { accountForPath, defaultConfigDir, discoverAccounts, ensureConfigDir, readAccount } from './profiles.js'
import { Ingest } from './ingest.js'
import { ROLE_POWERS, installHooks, installSessionHooks } from './hooks-install.js'
import { ensureRoots, ensureCardRoots } from './roots.js'
import { conversationHeldElsewhere, runningVersionForConversation } from './cli-sessions.js'
import {
  boundaryFrom,
  checkpointFactsFrom,
  checkpointRecord,
  codexUpdateState,
  installedVersionFor,
  updateStateFor,
  writeCheckpoint,
  type BoundaryFacts,
} from './update.js'
import { watchSessionFiles } from './session-watch.js'
import { TokenTally, fractionOf, readTokens } from './tokens.js'
import { startArchiver } from './archive.js'
import { derivePipeline } from './pipeline.js'
import { deleteBoard, listBoards, readBoard, saveBoard } from './boards.js'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { DATA_DIR } from './store.js'

const store = new Store()
const ptys = new PtyManager()

/*
 * One-off repair for cards created before parentId was written on the create path.
 *
 * Those rows carry a reporting line and no maker: the same fact recorded in one place and missing
 * from the other, which is why a card that had hired several agents listed none of them. Copying
 * it across is copying an assertion that was already made and stored, not inferring a new one, and
 * it only ever fills a null.
 */
{
  let filled = 0
  for (const s of store.listSessions()) {
    if (s.kind !== 'session' || s.parentId || !s.reportsTo) continue
    store.upsertSession({ ...s, parentId: s.reportsTo })
    filled++
  }
  if (filled) {
    console.log(`[garden] filled parentId on ${filled} card${filled === 1 ? '' : 's'} from the reporting line already stored`)
  }
}

const port = Number(process.env.GARDEN_PORT) || DEFAULT_PORT

/*
 * Garden's hooks are written on every start and handed to each CLI it launches with --settings.
 * Nothing is merged into the owner's own configuration: this file lives in ~/.garden and holds
 * only Garden's observer, so uninstalling the app removes every trace of it.
 */
const hookSettingsFile = installHooks(port)
process.env.GARDEN_HOOK_SETTINGS = hookSettingsFile

// A process cannot be re-parented across an app restart, so anything the database still thinks
// is running is stale. Say so rather than showing a node that looks alive.
//
// It hands back the cards that were live a moment ago, and they are started again once the server
// is listening (see `revive` at the bottom of this file). The owner's words for why: "the only
// thing that should kill the board is if i kill all or a major update, but u should restart it to
// live state not just kill it leaving me hanging".
const wereLive = store.markAllExitedOnBoot()

const pruned = store.pruneOrphanedBindings()
if (pruned) console.log(`[garden] pruned ${pruned} account bindings for projects that no longer exist`)

// Cards whose owner is gone cannot be reached by any control on the board, so they can only be
// cleared from here. Reported rather than silent: this removes things the owner could see.
const strays = store.pruneOrphanedCards()
if (strays.docs || strays.wires) {
  console.log(`[garden] removed ${strays.docs} orphaned cards and ${strays.wires} wires with a missing end`)
}

const clients = new Set<WebSocket>()

/**
 * A card with what Garden knows about its CLI version attached, on the way out and nowhere else.
 *
 * Derived rather than stored, and this is the reason: a stored version is a claim about a process,
 * and the process can be gone by the time anybody reads the row. The two facts are read fresh, from
 * the CLI's own registry entry for this card's conversation and from the executable on disk, and a
 * card whose process ended reports null for the first of them the moment it does.
 *
 * Attached at the two seams every card passes through rather than at the twenty-eight places a card
 * is broadcast, so no path can quietly send a card without it.
 */
function withUpdateState(s: TerminalSession): TerminalSession {
  const running = s.adapterId === 'claude'
    ? runningVersionForConversation(s.claudeSessionId, configDirFor(s))
    : null
  const state = updateStateFor({
    adapterId: s.adapterId,
    runningVersion: running,
    installedVersion: installedVersionFor(s.adapterId),
    // The same question `startSession` asks before it passes `--resume`: a conversation on disk
    // under the exact id this card claims. A card with nothing to reopen is not eligible, which is
    // a different statement from not being pending.
    resumeId: resumeIdFor(s),
    ...(s.adapterId === 'codex' ? { codex: codexUpdateState(codexHomeFor(s)) } : {}),
  })
  return { ...s, ...state }
}

/**
 * Where a Codex card's own state lives, or undefined when Garden has not put it anywhere.
 *
 * `configDirFor` is not the answer here and it took a test to see why. It falls back to the Claude
 * config directory for any card with no profile bound, which is right for what it was written for
 * and wrong for this: a Codex card with no profile is launched with `CODEX_HOME` untouched, so its
 * state is wherever Codex itself keeps it and not in a Claude directory that has no `version.json`
 * in it at all. Undefined says exactly that, and `codexUpdateState` then reads the same place the
 * card reads.
 */
function codexHomeFor(s: TerminalSession): string | undefined {
  const boundId = store.getProjectProfile(s.projectId, s.adapterId)
  const profile = boundId ? store.getProfile(boundId) : undefined
  return profile ? getAdapter(s.adapterId).configDirFor(profile) : undefined
}

function decorate(msg: ServerMessage): ServerMessage {
  if (msg.t === 'session.updated') return { ...msg, session: withUpdateState(msg.session) }
  if (msg.t === 'state') return { ...msg, sessions: msg.sessions.map(withUpdateState) }
  return msg
}

function broadcast(msg: ServerMessage) {
  const raw = JSON.stringify(decorate(msg))
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(raw)
  }
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(decorate(msg)))
}

function fail(ws: WebSocket, message: string, forT?: string) {
  send(ws, { t: 'error', message, forT })
}

const PALETTE = ['#7c5cff', '#2dd4bf', '#f59e0b', '#ec4899', '#38bdf8', '#a3e635']

function nextColor(): string {
  return PALETTE[store.listProjects().length % PALETTE.length]!
}

function addProject(path: string, name?: string): Project {
  const abs = resolve(path)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`not a directory: ${abs}`)
  }
  const existing = store.getProjectByPath(abs)
  if (existing) return existing

  const project: Project = {
    id: randomUUID(),
    name: name?.trim() || basename(abs) || abs,
    path: abs,
    color: nextColor(),
    defaultAdapterId: 'shell',
    defaultProfileId: null,
    profiles: {},
    notes: '',
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  }
  store.insertProject(project)

  // The account map already says which account owns which folder, so bind it rather than making
  // the owner remember. Getting this wrong is a billing mistake, not a cosmetic one.
  const owner = accountForPath(discoverAccounts(), abs)
  if (owner) {
    const id = `dir:${owner.configDir.toLowerCase()}`
    if (store.getProfile(id)) store.setProjectProfile(project.id, 'claude', id)
  }
  return store.getProject(project.id)!
}

/**
 * Lay a new node out in a loose grid so sessions never spawn on top of each other. Four across,
 * because the target display is a 4K ultrawide and a taller grid wastes the shape of the screen.
 */
const CARD_W = 340
const CARD_H = 260
/*
 * Enough room above and below a card to reach its two arrows.
 *
 * Not a whole web's worth: that was tried, and reserving hundreds of pixels around every card for
 * something most of them are not doing at any moment wasted most of the board. The space a web
 * needs is still made when the web opens, by pushing the cards below it down.
 *
 * What this gap has to cover is smaller and constant. The History and Roots arrows sit half
 * outside the card's own edge, so two cards packed tightly would put one card's top arrow against
 * the card above it, and an arrow you cannot reach is an arrow that does not exist.
 */
const NODE_GAP_X = 140
const NODE_GAP_Y = 150
const COLUMNS = 6
function nextPosition(projectId: string): { x: number; y: number } {
  const n = store.listSessions().filter((s) => s.projectId === projectId).length
  const col = n % COLUMNS
  const row = Math.floor(n / COLUMNS)
  return { x: col * (CARD_W + NODE_GAP_X), y: row * (CARD_H + NODE_GAP_Y) }
}

/**
 * Re-read every profile's signed-in account from its own config dir.
 *
 * This is what makes the account on a tab real rather than a label: it comes from the same file
 * the CLI writes, so signing in or out is reflected without Garden being told.
 */
/**
 * Adopt the accounts the owner already has.
 *
 * `~/.claude-account-map.json` is this machine's own convention and already names both config
 * directories and the path prefix each one owns. Reading it means the account picker offers the
 * two real accounts rather than asking for empty profiles to be created and signed into again.
 * Discovered profiles keep a stable id derived from their directory, so binding one to a project
 * survives restarts.
 */
function adoptDiscoveredAccounts(): void {
  for (const a of discoverAccounts()) {
    const id = `dir:${a.configDir.toLowerCase()}`
    const existing = store.getProfile(id)
    const email = a.identity?.email ?? a.declaredEmail ?? null
    store.upsertProfile({
      id,
      name: existing?.name ?? (email ? email.split('@')[0]! : a.configDir),
      adapterId: 'claude',
      configDir: a.configDir,
      accountEmail: a.identity?.email ?? null,
      accountName: a.identity?.displayName ?? null,
      organizationName: a.identity?.organizationName ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
    })
  }
}

function refreshProfiles(): void {
  adoptDiscoveredAccounts()
  for (const p of store.listProfiles()) {
    const acct = readAccount(p.configDir)
    store.upsertProfile({
      ...p,
      accountEmail: acct?.email ?? null,
      accountName: acct?.displayName ?? null,
      organizationName: acct?.organizationName ?? null,
    })
  }
}

interface Rect { x: number; y: number; w: number; h: number }

/**
 * Every card currently DRAWN on a project's board, as rectangles. Collapsed cards are header height.
 *
 * Drawn, not stored, and the difference is the whole of a bug the owner hit: this used to take every
 * session row on the project. His board drew three cards and this built 24 rectangles out of it, the
 * other 21 being spent subagents the canvas no longer draws and cards he had closed and parked. A
 * card dragged into space he could see was empty was pushed aside by them, and nothing on screen
 * could say why. `drawnOnBoard` is shared with the canvas filter for that reason: two definitions of
 * visible is how this happens, so there is only one.
 *
 * Documents are all drawn, so they are all taken as they were.
 */
function occupiedRects(projectId: string, exceptId?: string): Rect[] {
  const COLLAPSED_H = 38
  const out: Rect[] = []
  for (const s of store.listSessions().filter((x) => x.projectId === projectId && drawnOnBoard(x))) {
    if (s.id === exceptId) continue
    out.push({ x: s.x, y: s.y, w: s.width, h: s.collapsed ? COLLAPSED_H : s.height })
  }
  for (const d of store.listDocs().filter((x) => x.projectId === projectId)) {
    if (d.id === exceptId) continue
    out.push({ x: d.x, y: d.y, w: d.width, h: d.collapsed ? COLLAPSED_H : d.height })
  }
  return out
}

/**
 * Nudge a card to the nearest spot where it touches nothing.
 *
 * Cards must never overlap: a board where one card hides another is worse than no board, because
 * the thing it is hiding is exactly what you were trying to see. Dropping a card on top of one
 * is treated as aiming for that area, not as a request to stack, so it settles beside it.
 */
function nearestFree(projectId: string, moving: string, want: Rect): { x: number; y: number } {
  const taken = occupiedRects(projectId, moving)
  const clear = (x: number, y: number) => !taken.some((r) => overlaps({ ...want, x, y }, r, 12))
  if (clear(want.x, want.y)) return { x: want.x, y: want.y }

  // Spiral outward in steps of roughly a card, so the card lands next to where it was dropped.
  const stepX = Math.max(80, want.w / 2)
  const stepY = Math.max(60, want.h / 2)
  for (let ring = 1; ring <= 24; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const x = want.x + dx * stepX
        const y = want.y + dy * stepY
        if (clear(x, y)) return { x, y }
      }
    }
  }
  return { x: want.x, y: want.y }
}

function overlaps(a: Rect, b: Rect, pad = 40): boolean {
  return (
    a.x < b.x + b.w + pad &&
    a.x + a.w + pad > b.x &&
    a.y < b.y + b.h + pad &&
    a.y + a.h + pad > b.y
  )
}

/**
 * Find somewhere the web can unfold without landing on top of anything.
 *
 * The canvas is infinite, so there is no reason to squeeze a block of cards into occupied space.
 * This walks downward from just below the owner and then outward, taking the first placement that
 * clears every existing card. Opening further away is fine: these are usually folded straight
 * back up once they have been read.
 */
function findFreeArea(projectId: string, anchor: Rect, w: number, h: number): { x: number; y: number } {
  const taken = occupiedRects(projectId)
  const clear = (x: number, y: number) => !taken.some((r) => overlaps({ x, y, w, h }, r))

  const startX = anchor.x + anchor.w / 2 - w / 2
  const startY = anchor.y + anchor.h + 140

  for (let row = 0; row < 40; row++) {
    const y = startY + row * 220
    if (clear(startX, y)) return { x: startX, y }
    // Then try stepping sideways at the same height before dropping further.
    for (const dx of [w + 120, -(w + 120), 2 * (w + 120), -2 * (w + 120)]) {
      if (clear(startX + dx, y)) return { x: startX + dx, y }
    }
  }
  // Nothing clear within the search: fall well below everything rather than overlapping.
  const lowest = taken.reduce((m, r) => Math.max(m, r.y + r.h), anchor.y + anchor.h)
  return { x: startX, y: lowest + 200 }
}

/**
 * Rewrite one session's list of who it is wired to.
 *
 * Called whenever a wire appears or disappears, so the file on disk and the board never disagree.
 * A card that is not a session has no mailbox, which is why document cards are skipped rather
 * than given an empty one.
 */
function refreshMail(cardId: string): void {
  const session = store.getSession(cardId)
  if (!session) return
  const peers: Peer[] = []
  for (const w of store.listWires()) {
    if (w.kind === 'context' || w.kind === 'history') continue
    let otherId: string
    if (w.sourceId === cardId) otherId = w.targetId
    else if (w.targetId === cardId) otherId = w.sourceId
    else continue
    const other = store.getSession(otherId)
    if (!other) continue
    peers.push({
      title: other.title,
      direction: w.sourceId === cardId ? 'to' : 'from',
      twoWay: w.bidirectional,
      kind: w.kind,
      label: w.label,
      mailDir: mailDirFor(other.id),
    })
  }
  writePeers(session, peers)
}

/**
 * Where a newly spawned agent's card goes.
 *
 * The rule is the owner's and it is about reading a team at a glance: whoever dispatched sits to
 * the left, whoever was dispatched sits to the right, and each step down the chain also steps
 * down the board. So the eye reads seniority left to right and depth top to bottom, and a card's
 * position tells you where it sits in the hierarchy without following a single wire.
 *
 * Siblings stack downward beside each other rather than fanning out, because an agent that
 * dispatches five at once should read as five rows in one column, not a spray.
 *
 * The chosen spot is still passed through the no-overlap check, since that rule outranks this
 * one: a card placed exactly where the hierarchy wants it, on top of another card, would hide
 * the very thing it was drawn to show.
 */
function placeSpawnedCard(parent: TerminalSession, w: number, h: number): { x: number; y: number } {
  /*
   * Close, because a family has to read as one group.
   *
   * The gap was wide enough that a parent and the agents it hired looked like separate parts of the
   * board rather than one team, which is the opposite of what the wires between them are saying.
   */
  const GAP_X = 90
  const GAP_Y = 28

  const siblings = store.childSessions(parent.id).length

  /*
   * Outward, in whatever direction this family is already growing.
   *
   * Always placing to the right is correct for a family that grew rightward and wrong for one that
   * did not: in the radial web a department can run leftward from the middle, and a new hire
   * appearing on the far side of its own maker would cross the family it belongs to. So a child
   * goes on the opposite side of its maker from the maker's own maker, which needs no knowledge of
   * which arrangement is on screen and keeps a branch pointing the same way for its whole length.
   *
   * A card the owner started himself has no maker to be on the far side of, so it keeps placing to
   * the right, which is the direction everything else defaults to.
   */
  const grandparent = parent.parentId ? store.getSession(parent.parentId) : undefined
  const growsLeft = grandparent
    ? grandparent.x + grandparent.width / 2 > parent.x + parent.width / 2
    : false

  /*
   * Level with the parent, then stacked downward, and depth is not counted here.
   *
   * It used to be, and that is what scattered a family across the board: a child's vertical
   * position included how deep its parent already sat, so an agent hired by an agent started two
   * card heights below its own parent and a third generation started three, all while the wire
   * between them still claimed they belonged together. Depth is already said by the horizontal
   * step, once per generation, so saying it again vertically was counting the same fact twice.
   *
   * The first child sits alongside its parent's top edge, and each sibling after it takes the next
   * row down, so a card that hired five reads as one column of five beside it.
   */
  /*
   * Stacked by what a collapsed card actually draws, not by its stored height.
   *
   * A spawned card arrives folded to its header, so it draws at header height while its stored
   * height stays the full 260 it would take if opened. Stacking by the stored figure left roughly
   * two hundred pixels of nothing between one agent and the next, so a card that hired six had them
   * strung down the board instead of listed beside it. The owner asked for a tight vertical list and
   * this is what was in the way.
   */
  /*
   * The column starts one clear gap BELOW the parent's top edge, not level with it.
   *
   * Level is what it was, and it cost the board the one thing the arrangement is supposed to say.
   * Seniority reads left to right and depth reads top to bottom, so a card and the card it hired
   * sharing a top edge means the second generation is drawn as though it were the first. On a board
   * three deep that is the difference between a chain you can read at a glance and a row of cards
   * that all look like peers, which is what the owner was looking at when he called the spawns
   * chaotic.
   *
   * One gap rather than a whole card height, so the family still reads as one tight group. The
   * scattering this function was written to fix came from counting depth once per generation
   * vertically AND horizontally, not from the step itself.
   */
  const drawn = BOARD.COLLAPSED_H
  const y = parent.y + BOARD.GAP + siblings * (drawn + GAP_Y)

  /*
   * The family moves as a column, never card by card.
   *
   * Handing each new agent to the free-space search looked reasonable and is what scattered them:
   * the parent's own roots web hangs directly below it and occupies exactly where this column
   * wants to go, so every card was shoved to a different empty patch. The owner ended up with a
   * card's agents at three separate places on the board, one of them two thousand pixels down,
   * while the wires still said they were one team.
   *
   * So the row is fixed by which sibling this is, and only the column moves. If the slot is taken,
   * the whole column steps one card width further out and tries again, which keeps the list
   * straight and keeps it beside the parent it belongs to. Falling back to the free search after
   * several tries is deliberate: a board with no room at all should still place the card somewhere
   * visible rather than on top of something.
   */
  const step = w + BOARD.GAP
  for (let out = 0; out < 6; out++) {
    const x = growsLeft ? parent.x - GAP_X - w - out * step : parent.x + parent.width + GAP_X + out * step
    const free = nearestFree(parent.projectId, '', { x, y, w, h: drawn })
    if (Math.abs(free.x - x) < 2 && Math.abs(free.y - y) < 2) return { x, y }
  }
  const x = growsLeft ? parent.x - GAP_X - w : parent.x + parent.width + GAP_X
  return nearestFree(parent.projectId, '', { x, y, w, h: drawn })
}

/**
 * Insert a band of space into the board, moving everything past it by the same amount.
 *
 * Not "push aside whatever is in the way". Moving only the cards that happened to overlap the
 * block changed the spacing between them and their own neighbours, so opening a blip reshuffled
 * the structure underneath it and the wires with it. Shifting everything below the insertion line
 * by one identical distance moves the whole lower half of the board as a unit: every card keeps
 * its position relative to every other card, and the only thing that changed is that there is now
 * room where the web needs to be.
 *
 * Upward for history, downward for files, and never sideways, so nothing loses what its
 * horizontal position was saying about it.
 *
 * The exact distance each card moved is recorded, so closing the blip can take precisely that
 * distance back.
 */
interface Pushed {
  id: string
  dy: number
}

/**
 * Where room was made, so it can be given back.
 *
 * Keyed by the card and which of its two webs, since the two open and close independently.
 * In memory rather than in the database on purpose: after a restart, nothing on the board moves
 * on its own. A card that stayed where the owner last saw it is worth more than a perfectly
 * reversed shuffle he is not watching.
 */
const roomMade = new Map<string, Pushed[]>()

function insertBand(
  projectId: string,
  atY: number,
  amount: number,
  keep: Set<string>,
  direction: 'down' | 'up',
): { moved: Array<TerminalSession | DocCard>; pushed: Pushed[] } {
  const moved: Array<TerminalSession | DocCard> = []
  const pushed: Pushed[] = []
  if (amount <= 0) return { moved, pushed }
  const dy = direction === 'down' ? amount : -amount

  for (const session of store.listSessions().filter((x) => x.projectId === projectId)) {
    if (keep.has(session.id)) continue
    const h = session.collapsed ? BOARD.COLLAPSED_H : session.height
    // Below the line for a downward insert, above it for an upward one. A card straddling the
    // line moves with the side it mostly sits on.
    const past = direction === 'down' ? session.y + h / 2 >= atY : session.y + h / 2 <= atY
    if (!past) continue
    const updated = { ...session, y: session.y + dy, manualPos: true }
    store.upsertSession(updated)
    moved.push(updated)
    pushed.push({ id: session.id, dy })
  }

  for (const doc of store.listDocs().filter((x) => x.projectId === projectId)) {
    if (keep.has(doc.id)) continue
    const h = doc.collapsed ? BOARD.COLLAPSED_H : doc.height
    const past = direction === 'down' ? doc.y + h / 2 >= atY : doc.y + h / 2 <= atY
    if (!past) continue
    const updated = { ...doc, y: doc.y + dy, manualPos: true }
    store.upsertDoc(updated)
    moved.push(updated)
    pushed.push({ id: doc.id, dy })
  }

  return { moved, pushed }
}

/**
 * Close the space a web was given, moving every card back by exactly what it was moved by.
 *
 * By distance rather than to a remembered coordinate, so a card the owner dragged in the meantime
 * keeps that adjustment instead of snapping back to where it used to be.
 */
function giveBackRoom(key: string) {
  const pushed = roomMade.get(key)
  if (!pushed) return
  roomMade.delete(key)
  for (const p of pushed) {
    const session = store.getSession(p.id)
    if (session) {
      const updated = { ...session, y: session.y - p.dy }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      continue
    }
    const doc = store.getDoc(p.id)
    if (doc) {
      const updated = { ...doc, y: doc.y - p.dy }
      store.upsertDoc(updated)
      broadcast({ t: 'doc.updated', card: updated })
    }
  }
}

function announceMoved(moved: Array<TerminalSession | DocCard>) {
  for (const card of moved) {
    if ('adapterId' in card) broadcast({ t: 'session.updated', session: card })
    else broadcast({ t: 'doc.updated', card })
  }
}

/**
 * Put a card directly under the card it belongs to, and make the room for it.
 *
 * Not "somewhere free". A file card that belongs to a session has to be next to that session or it
 * says nothing: the owner reads which card owns what from where it sits, and a block that landed
 * two screens away because that is where the board happened to have space is worse than useless.
 * So the position is fixed relative to the owner and the board is opened up to fit, the same way
 * the two blips do it.
 *
 * Returns the spot, having already moved whatever was in the way.
 */
/**
 * Push anything still standing in a block out of it, once the block is really placed.
 *
 * Inserting a band ahead of time moves everything past a line, which is what keeps the structure
 * below a card intact. It cannot catch a card that straddles the line: a tall card whose middle
 * sits above it stays put, and the block then opens straight across it. The owner saw exactly
 * that, with roots landing on top of cards.
 *
 * So the block's real rectangle is measured after the fact, from the cards that were actually
 * created, and any card still intersecting it is moved clear along the same axis the block opened.
 * The distance is recorded with the rest of the room, so folding the web away gives it back.
 */
/**
 * Nothing on a board may cover anything else, and this is the pass that guarantees it.
 *
 * Every placement rule in this file tries to avoid a collision before it happens, and every one of
 * them can be defeated by something arriving later: a web opening under a card that was dragged
 * there afterwards, two webs opened on neighbouring cards, a card resized after its neighbours
 * settled. The owner's rule has no exceptions, so there is a pass that runs after any placement
 * and simply fixes whatever is left.
 *
 * It only ever moves a card DOWN. Horizontal position carries meaning everywhere on this board:
 * which family a card belongs to, how far down a chain it is, which side of its maker it sits on.
 * Vertical position, below the card something belongs to, carries almost none.
 *
 * Anchors are left alone, so a card the owner is looking at does not move out from under him;
 * everything else settles around them.
 */
/**
 * Record where every card in a project is sitting right now.
 *
 * Used for the automatic step back taken before an arrangement, and for the layouts the owner
 * saves by name. Both are the same thing: a list of positions and nothing else.
 */
/**
 * How many times one task may go round the review loop before it has to go to the owner.
 *
 * One by default, because the owner said plainly that he does not want tasks in an endless review
 * and edit spiral: a review happens, and then the work and the notes come to him and he decides.
 */
const MAX_REVIEW_ROUNDS = 1

/** The shim an agent runs to hand work along a wire, found next to the hook script. */
function sendShimPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'garden-send.mjs')
}

/**
 * How a card asks for another card to exist.
 *
 * Handed to every session, not only to the ones that may create. A card that cannot create still
 * needs this, because asking is what it does with it: the request is filed as mail to the orchestrator
 * and answered along a wire. Without it a card told to hire had nothing at all to call, and fell
 * back to the CLI's own Agent tool, which produces a helper that lives inside one turn rather than
 * a card on the board.
 */
function hireShimPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'garden-hire.mjs')
}

/**
 * How a card reads and changes a task contract.
 *
 * Handed to every session for the same reason the hiring shim is: most cards may not create or
 * reassign a task, but every card can be told why its message was refused and every card can look
 * at the contract it is working to. `show` is the subcommand that matters to a worker.
 */
function taskShimPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'garden-task.mjs')
}

/**
 * The built app, served from the same port as everything else.
 *
 * This is the difference between an app the owner can use and one he can only watch me build. The
 * dev server runs the TypeScript under a watcher, so every server file saved restarts the process
 * and takes every terminal he has open with it. A build is a copy: it stops changing the moment it
 * is made, so editing the source of the app he is running does nothing to the app he is running
 * until he asks for a new build.
 *
 * No build present is not an error. It means he is on the dev server, where Vite serves the app on
 * its own port and this route has nothing to add.
 */
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'web', 'dist')

const APP_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function builtAppExists(): boolean {
  return existsSync(join(APP_DIR, 'index.html'))
}

function serveBuiltApp(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!builtAppExists()) return false

  const path = (req.url ?? '/').split('?')[0]
  /*
   * Resolve first, then check the result is still inside the build. Checking the request string
   * for ".." instead would miss an encoded one, and this route reads files off disk.
   */
  const abs = resolve(APP_DIR, '.' + decodeURIComponent(path))
  const inside = abs === APP_DIR || abs.startsWith(APP_DIR + sep)
  const file = inside && existsSync(abs) && statSync(abs).isFile() ? abs : join(APP_DIR, 'index.html')

  const type = APP_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  // The hashed assets are safe to keep; index.html must never be, or a rebuild would not show up.
  const cache = file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
  res.writeHead(200, { 'content-type': type, 'cache-control': cache })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(file)
    .on('error', () => res.end())
    .pipe(res)
  return true
}

/**
 * Record a delivery that was refused.
 *
 * A refusal is as much a fact about the board as a delivery, and a more useful one: it is the
 * moment an agent tried to go somewhere the chain does not allow, and the owner should be able to
 * see that happened rather than only its absence.
 */
function recordRefusal(
  from: TerminalSession,
  to: TerminalSession,
  kind: string,
  taskId: string | null,
  reason: string,
): void {
  const event = {
    id: randomUUID(),
    sessionId: from.id,
    ts: Date.now(),
    type: 'MailRefused',
    provenance: 'structured' as const,
    payload: { to: to.id, toTitle: to.title, kind, taskId, reason },
  }
  store.insertEvent(event)
  broadcast({ t: 'event', event })
}

// ---------------------------------------------------------------------------
// Identity: who Garden started, rather than who the body says
// ---------------------------------------------------------------------------

/**
 * A card's secret for this server's lifetime, and the two directions it is looked up in.
 *
 * In memory and never on disk, which is the whole shape of it. A token that outlived the server
 * would be a credential lying around on a machine where every card runs as the owner, and there is
 * nothing that needs it to: a restarted server mints again and hands each card the new one.
 *
 * It belongs to the card and not to the process, which is the correction canon 20 revision 2 makes.
 * A token minted at `session.create` and rotated at every start meant `session.token` had no answer
 * for a card that was switched off, so the owner could not hand a stopped card's token to anything,
 * and every restart invalidated a token something else was still holding. Now it is minted when the
 * card is made, kept until this server exits, and put in the environment at every start, so the
 * value is stable for as long as the board is up.
 *
 * Only the hash is compared, so a token read out of this process's memory is the only way to get
 * one, and nothing that is written down or logged carries it.
 */
const tokenToSession = new Map<string, string>()
const sessionToToken = new Map<string, string>()

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * This card's token, minting one the first time anything asks.
 *
 * Minting on demand is what covers a card that predates the mint: every row already in the database
 * when this server started has no token, and nothing would ever give it one if only `session.create`
 * did. The first `session.token`, or the card's first start, is where it gets one.
 */
function tokenFor(sessionId: string): string {
  const held = sessionToToken.get(sessionId)
  if (held) return held
  const token = randomBytes(32).toString('base64url')
  tokenToSession.set(sha256(token), sessionId)
  sessionToToken.set(sessionId, token)
  return token
}

/**
 * Tokens that were withdrawn, kept by hash so a request carrying one can be told why it failed.
 *
 * Closing a card withdraws its token, which canon 20 revision 3 asks for and which the maps above
 * could not express: forgetting the hash entirely would make a withdrawn token indistinguishable
 * from a made-up one, and "Garden cannot tell which card sent this" is the wrong sentence for a
 * credential that was real until the owner closed the card. Only the hash is kept, so this holds no
 * more of a secret than the map it came from.
 */
const withdrawnTokens = new Map<string, string>()

/** Stop honouring this card's token, keeping the hash so its holder is told what happened. */
function withdrawToken(sessionId: string): void {
  const held = sessionToToken.get(sessionId)
  if (!held) return
  const hash = sha256(held)
  tokenToSession.delete(hash)
  sessionToToken.delete(sessionId)
  withdrawnTokens.set(hash, sessionId)
}

/** The card a bearer token belongs to, or nothing. Never throws on rubbish input. */
function cardForToken(token: string | null): TerminalSession | undefined {
  if (!token) return undefined
  const id = tokenToSession.get(sha256(token))
  return id ? store.getSession(id) : undefined
}

/** The card a withdrawn token used to belong to, for the sentence and for nothing else. */
function cardForWithdrawnToken(token: string | null): TerminalSession | undefined {
  if (!token) return undefined
  const id = withdrawnTokens.get(sha256(token))
  return id ? store.getSession(id) : undefined
}

function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers['authorization']
  const raw = Array.isArray(h) ? h[0] : h
  if (!raw) return null
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m ? m[1]!.trim() : null
}

/**
 * The owner's key, so a browser tab can prove it is his and a card with Bash cannot be him by
 * omission.
 *
 * What this closes and what it does not, both worth stating. Before it, the socket was loopback
 * with no identity at all and a connection that said nothing was treated as the owner, so any card
 * that could open a WebSocket was him. It no longer is. What it does not close is a card that goes
 * looking: every card runs as the same Windows user, so nothing on this machine can hide this file
 * from one process and show it to another. Canon 20 records that honestly rather than claiming more.
 */
const OWNER_KEY_FILE = join(DATA_DIR, 'owner.key')

function ownerKey(): string {
  try {
    if (existsSync(OWNER_KEY_FILE)) {
      const held = readFileSync(OWNER_KEY_FILE, 'utf8').trim()
      if (held) return held
    }
  } catch {
    // Unreadable is treated as absent and rewritten below. A board that could not start because of
    // this file would be a worse failure than a rotated key.
  }
  const key = randomBytes(32).toString('base64url')
  mkdirSync(dirname(OWNER_KEY_FILE), { recursive: true })
  writeFileSync(OWNER_KEY_FILE, key, 'utf8')
  return key
}

/**
 * How hard ownership bites on a project. Read fresh every time; the owner changes it live.
 *
 * `GARDEN_TASK_AUTHORITY` raises the floor, and exists for one reason: canon 20 asks for the
 * existing suite to pass at `shadow` and at `enforce`, and those tests each build their own project
 * and never touch limits, so without this there is no way to run them under enforcement at all.
 *
 * It accepts only `enforce`, and any other value is ignored. That is the whole of its power and it
 * is deliberately one-directional: the variable can only ever make the board stricter, so nothing in
 * an environment can turn a project down from `shadow` to `off`. Since `enforce` is the strictest
 * setting there is, the stored value never needs comparing with anything: a project already at
 * `enforce` is unchanged by it, and a project at `off` or `shadow` is raised. An earlier version of
 * this compared the stored value against the default and its comment claimed `off` from the
 * environment worked, and neither was true of what it did.
 */
function authorityFor(projectId: string): 'off' | 'shadow' | 'enforce' {
  const stored = store.getLimits(projectId).taskAuthority
  if (process.env.GARDEN_TASK_AUTHORITY === 'enforce') return 'enforce'
  return stored
}

/**
 * The sessionId a board-wide record is filed under, for the one event that belongs to no card.
 *
 * A socket that says hello with no key and no token has no card to hang an event on, which is why
 * that door used to write a console line instead. Canon 20 asks for the record, so it is filed
 * against the board itself and `listTaskRefusals` returns it to every project. Board-wide is also
 * the truth of it: a socket is not per project, one tab carries every board, so an unverified
 * connection is not a fact about one of them.
 */
const BOARD_EVENTS_ID = 'board'

/**
 * Record what ownership stopped, or would have stopped.
 *
 * On the sending card, exactly as `MailRefused` already is, so the refusal sits in the history of
 * the card that hit it rather than in a log nobody opens. Broadcast as well as stored, because the
 * board draws it live; stored as well as broadcast, because the page throws `event` messages away
 * and a shadow-mode list that empties on reload is not a list anybody can act on.
 */
function recordTaskEvent(
  sessionId: string,
  type: 'TaskRefused' | 'TaskWouldRefuse' | 'SenderUnverified',
  payload: { taskId: string | null; kind: string; rule: string; reason: string; to: string | null },
): void {
  const event = {
    id: randomUUID(),
    sessionId,
    ts: Date.now(),
    type,
    provenance: 'structured' as const,
    payload,
  }
  store.insertEvent(event)
  broadcast({ t: 'event', event })
}

/**
 * Record a refusal on the `/task` plane, at every setting including `off`.
 *
 * Deliberately not asking `authorityFor`. Everything else ownership refuses is a message or a write,
 * and those are governed: in `shadow` they are recorded and allowed, in `off` neither. These are
 * operations on the record itself, they refuse whatever the setting is, and canon 20 revision 2 says
 * a refusal the owner cannot see while he is watching in `shadow` would leave the record he is
 * watching unaccountable. `TaskRefused` and never `TaskWouldRefuse`, because the refusal really did
 * happen.
 *
 * Filed against the acting card, or against the board when the owner acted from his own hands, which
 * is the same place the socket door files a hello it could not identify.
 */
function recordTaskPlaneRefusal(
  actor: TerminalSession | null,
  op: string,
  taskId: string | null,
  reason: string,
): void {
  recordTaskEvent(actor?.id ?? BOARD_EVENTS_ID, 'TaskRefused', {
    taskId,
    kind: 'task',
    rule: `task.${op}`,
    reason,
    to: null,
  })
}

type SenderResolution =
  | { ok: true; card: TerminalSession }
  | { ok: false; code: number; reason: string }

/**
 * Who actually sent this request.
 *
 * The token wins over the body, and that inversion is the second of canon 20's four holes closed:
 * `/mail` and `/hire` read the sender off the request body, so every wire check and every guard was
 * being applied to whichever card the sender claimed to be. `garden-send.mjs` filled the field
 * honestly, and nothing made it.
 *
 * A body that disagrees with the token is a card sending as another card, which is refused under
 * `enforce` and recorded and overridden under `shadow`. No token at all is the ordinary case today,
 * because a card started before this change has none, so under `shadow` it is accepted and recorded
 * and under `enforce` it is refused with the fix named.
 */
function resolveSender(req: IncomingMessage, body: any): SenderResolution {
  const bodyCard = store.getSession(String(body?.from ?? ''))
  const tokenCard = cardForToken(bearerOf(req))

  /*
   * A token that was real until the card was closed is refused by name, at every setting.
   *
   * Not governed by `taskAuthority`, unlike the rest of this function. The others are Garden being
   * unsure who sent something; this one is Garden being certain, and certain that the owner
   * withdrew it. Allowing it in `shadow` would mean closing a card does not stop it sending until
   * somebody turns enforcement on, which is not what the owner did when he closed it.
   */
  const withdrawn = cardForWithdrawnToken(bearerOf(req))
  if (!tokenCard && withdrawn) {
    return {
      ok: false,
      code: 403,
      reason:
        `this request was sent with "${withdrawn.title}"'s token, and that card is closed. Closing a ` +
        'card withdraws its token, which is what closing one is for: a card that must not send any ' +
        'more cannot be left holding a credential that still works. Restore the card and start it, ' +
        'and it will be given a new token.',
    }
  }

  const candidate = tokenCard ?? bodyCard
  if (!candidate) {
    return { ok: false, code: 404, reason: 'the card sending this is not one Garden knows' }
  }
  const authority = authorityFor(candidate.projectId)
  if (authority === 'off') return { ok: true, card: candidate }

  if (tokenCard) {
    if (bodyCard && bodyCard.id !== tokenCard.id) {
      const reason =
        `this request says it comes from "${bodyCard.title}" and it was sent with ` +
        `"${tokenCard.title}"'s token. Garden believes the token. A card sending as another card is ` +
        'the hole every wire check and every ownership rule was being checked against.'
      if (authority === 'enforce') return { ok: false, code: 403, reason }
      recordTaskEvent(tokenCard.id, 'SenderUnverified', {
        taskId: body?.taskId ? String(body.taskId) : null,
        kind: String(body?.kind ?? ''),
        rule: 'from-mismatch',
        reason,
        to: bodyCard.id,
      })
    }
    return { ok: true, card: tokenCard }
  }

  /*
   * A token that names nothing, and no token at all, are two different facts about the sender.
   *
   * They shared one sentence until now, and it was the wrong one for the case that happens most:
   * tokens live in this process's memory, so every card that was running before the last server
   * restart is holding a value this server has never seen. Telling that card it "carried no
   * GARDEN_SESSION_TOKEN" sends whoever reads it looking for a missing variable that is in fact
   * sitting right there in the environment, correctly set, and merely stale. The socket door has
   * drawn this distinction since revision 2, `bad-key-or-token` against `anonymous-socket`, and this
   * is the HTTP door catching up with it.
   *
   * The remedy says what the noun is, which the "no token" sentence had to learn once already: it
   * used to end "turning one off and on again mints one", where "one" had no antecedent and two
   * readers who had never seen the code both stopped at it.
   */
  const offered = bearerOf(req)
  const reason = offered
    ? 'this request was sent with a token that names no card Garden knows. A session token is the ' +
      'secret Garden gives a card when it is created and puts in GARDEN_SESSION_TOKEN every time the ' +
      'card starts, and it is kept in the running server rather than on disk, so a restart mints new ' +
      'ones and the value a card was started with stops being recognised. A card that has been up ' +
      'since before the last restart is the ordinary cause: start it again and it will carry a token ' +
      'this server knows.'
    : 'this request carried no GARDEN_SESSION_TOKEN, so Garden cannot tell which card sent it and is ' +
      'taking the word of the message itself. A session token is the secret Garden gives a card when ' +
      'it is created and puts in GARDEN_SESSION_TOKEN every time the card starts, so that a message ' +
      'can prove which card sent it. A process that was already running before its card had one will ' +
      'not have it in its environment until the card is started again, and a shim run by hand outside ' +
      'any card has none at all, which is ordinary rather than wrong.'
  if (authority === 'enforce') return { ok: false, code: 403, reason }
  recordTaskEvent(candidate.id, 'SenderUnverified', {
    taskId: body?.taskId ? String(body.taskId) : null,
    kind: String(body?.kind ?? ''),
    rule: offered ? 'bad-token' : 'no-token',
    reason,
    to: null,
  })
  return { ok: true, card: candidate }
}

// ---------------------------------------------------------------------------
// Tasks: the rules from tasks.ts, wired to the store
// ---------------------------------------------------------------------------

/** The card facts the ownership rules read, out of a session row. */
function factsOf(s: TerminalSession | undefined): CardFacts | undefined {
  if (!s) return undefined
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    closedAt: s.closedAt ?? null,
    roleClass: s.roleClass ?? null,
    ownedPaths: s.ownedPaths ?? null,
  }
}

/** How a card is named to a sender reading a refusal. The title, in quotes, or the bare id. */
function titleOf(id: string | null): string {
  if (!id) return 'nobody'
  const s = store.getSession(id)
  return s ? `"${s.title}"` : id
}

function reportsToOf(id: string): string | null {
  return store.getSession(id)?.reportsTo ?? null
}

/** Everyone allowed to talk about a task, with the parent task's owner folded in. */
function participantsFor(t: TaskContract): Set<string> {
  const parent = t.parentId ? store.getTask(t.projectId, t.parentId) : undefined
  return participantsOfTask(t, parent?.ownerId ?? null)
}

/**
 * A dispatcher is a live card whose role hires, or the owner at the board.
 *
 * `hires` rather than `creates`, per canon 20, and the two are deliberately different bits: creating
 * a card is the orchestrator's alone, and handing out work is what a manager does all day.
 */
function isDispatcher(card: TerminalSession | undefined): boolean {
  if (!card) return false
  return ROLE_POWERS[card.roleClass ?? '']?.hires === true
}

// ---------------------------------------------------------------------------
// Socket identity
// ---------------------------------------------------------------------------

/**
 * `keyed` says whether the owner actually proved it, as against being treated as the owner because
 * nothing on this board is enforcing yet. Only one decision turns on the difference and it is the
 * one that can lock him out: see `limits.set`.
 */
type SocketIdentity =
  | { kind: 'owner'; keyed: boolean }
  | { kind: 'guest' }
  | { kind: 'card'; cardId: string }

const socketIdentity = new WeakMap<WebSocket, SocketIdentity>()

/**
 * Whether the socket is checking identities yet.
 *
 * Board-wide rather than per project, because a connection is not per project: one tab shows every
 * board and one socket carries all of it. So the strictest project on the board decides, which is
 * the only direction that cannot be walked around by sending a message about a lax project.
 */
function socketEnforced(): boolean {
  return store.listProjects().some((p) => store.getLimits(p.id).taskAuthority === 'enforce')
}

/**
 * Decide what a connection is, from what its `hello` carried.
 *
 * The owner's key, a card's token, or neither. Neither is a guest once anything on this board is
 * enforcing, and until then it is treated as the owner, because every window open right now
 * predates the key and locking the owner out of his own board to close a hole he asked for would
 * be the change refusing the person who requested it.
 *
 * Every hello that proves nothing is recorded as `SenderUnverified`, against the board rather than
 * against a card, because there is no card to hang it on. That is the difference canon 20 revision 2
 * closes: the HTTP door recorded its unverified senders and this one wrote a console line, so the
 * Tasks panel showed half of the answer to "who is talking to this board without proving who they
 * are". Both shapes are recorded here, the anonymous hello and a key or token that was offered and
 * did not match, and they carry different rules so the two are told apart in the list.
 */
function identify(ws: WebSocket, key?: string, token?: string): SocketIdentity {
  if (key && key === ownerKey()) {
    const id: SocketIdentity = { kind: 'owner', keyed: true }
    socketIdentity.set(ws, id)
    return id
  }
  const card = cardForToken(token ?? null)
  if (card) {
    const id: SocketIdentity = { kind: 'card', cardId: card.id }
    socketIdentity.set(ws, id)
    return id
  }

  // Offered and wrong is a different fact from offered nothing, and the second is the ordinary
  // state of every tab open right now, so the two are recorded separately.
  const offered = Boolean(key || token)
  const enforcing = socketEnforced()
  const reason = offered
    ? 'a connection said hello with a key or a token that matches nothing on this board. It is a ' +
      (enforcing ? 'guest and reads only.' : 'guest once any project on this board enforces; until then it is treated as the owner.')
    : 'a connection arrived with no owner key and no card token. It is treated as ' +
      (enforcing
        ? 'a guest and reads only, because a project on this board is enforcing task authority.'
        : 'the owner, because no project on this board is enforcing task authority yet.')
  recordTaskEvent(BOARD_EVENTS_ID, 'SenderUnverified', {
    taskId: null,
    kind: 'hello',
    rule: offered ? 'bad-key-or-token' : 'anonymous-socket',
    reason,
    to: null,
  })

  if (enforcing) {
    const id: SocketIdentity = { kind: 'guest' }
    socketIdentity.set(ws, id)
    return id
  }
  const id: SocketIdentity = { kind: 'owner', keyed: false }
  socketIdentity.set(ws, id)
  return id
}

function identityOf(ws: WebSocket): SocketIdentity {
  return socketIdentity.get(ws) ?? (socketEnforced() ? { kind: 'guest' } : { kind: 'owner', keyed: false })
}

/**
 * What a guest may ask for: the reads, and nothing that changes anything.
 *
 * An allowlist rather than a list of the mutations, because the two fail in opposite directions.
 * A message added beside this one and forgotten is refused to a guest, which is visible and
 * annoying; on a deny list it would be silently allowed, which is a hole that appears by omission.
 */
const GUEST_READS = new Set<string>([
  'pulse',
  'hello',
  'task.list',
  'limits.get',
  'session.scrollback',
  'doc.list',
  'doc.read',
  'channel.read',
  'work.list',
  'pipeline.get',
  'history.groups',
  'board.list',
  'layout.list',
  'project.listClosed',
  'context.list',
])

/**
 * Whether this connection may send this message, checked before anything acts on it.
 *
 * This is canon 20's third hole. `session.create` and `session.start` treat a message with no `by`
 * field as coming from the owner, and the socket was loopback with no identity, so a card with Bash
 * could open one and be him. The card connection now meets the same `ROLE_POWERS` check its HTTP
 * twin applies, and a connection that is neither the owner nor a card reads and changes nothing.
 */
function socketMaySend(ws: WebSocket, t: string): { ok: true } | { ok: false; reason: string } {
  const id = identityOf(ws)
  if (id.kind === 'owner') return { ok: true }
  if (id.kind === 'guest') {
    if (GUEST_READS.has(t)) return { ok: true }
    return {
      ok: false,
      reason:
        'guest connections read the board and change nothing. Open Garden from its launcher, or ' +
        'from the URL the server prints at start, which carries the owner key.',
    }
  }

  const card = store.getSession(id.cardId)
  if (!card) return { ok: false, reason: 'the card this connection belongs to is no longer on the board' }
  const powers = ROLE_POWERS[card.roleClass ?? ''] ?? { hires: false, creates: false }

  if (t === 'session.create' || t === 'session.start') {
    if (powers.creates) return { ok: true }
    return {
      ok: false,
      reason:
        `a ${card.roleClass ?? 'card with no role'} may not bring a card into existence, over this ` +
        'socket any more than through GARDEN_HIRE. Ask the orchestrator, and it will answer along a wire.',
    }
  }

  if (t.startsWith('task.') && t !== 'task.list') {
    if (powers.hires) return { ok: true }
    return {
      ok: false,
      reason:
        `changing a task contract is a dispatcher's, and a ${card.roleClass ?? 'card with no role'} is ` +
        'not one. Ask the card that assigned the work.',
    }
  }

  /*
   * Typing into another card is dispatch, whatever it looks like. Canon 18 puts it with creation
   * rather than with the reads: a card that can type into another card's terminal can make it do
   * anything that card can do, which is a wider power than sending it mail.
   */
  if (t === 'session.input' && !powers.creates) {
    return {
      ok: false,
      reason:
        'typing into another card is the control plane, and this card does not have it. Send mail ' +
        'along a wire instead: the card reads it when it chooses to, which is the difference between ' +
        'a hand-off and taking somebody over mid-turn.',
    }
  }

  return { ok: true }
}

/**
 * Live descendants of one pid, from the operating system's own table, before anything is killed.
 *
 * Before, and that is the whole point of doing it this way. Garden's teardown is a kill of the pty,
 * which takes the shell and the CLI with it and leaves anything the card started with `Start-Process`
 * running as an orphan: measured twice, in section 6 of `.claude/work-orders/cli-update-evidence.md`.
 * After the kill those survivors no longer name the pty as their parent, so a check that ran then
 * would find nothing and report a clean exit over the top of a build that is still going.
 *
 * One level down, then their children, because a card's work is usually a grandchild of the shell.
 * An empty answer on a failure, since a boundary check that throws is worse than one that says it
 * does not know: the caller treats no children as no blocker, and everything else in the check still
 * has to pass.
 */
function liveChildren(pid: number | null): number[] {
  if (!pid) return []
  try {
    if (process.platform !== 'win32') {
      const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 5000 })
      return out.split(/\s+/).map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    }
    /*
     * The process table once, then walked in memory. It used to enumerate inside the loop, which
     * asked Windows for every process on the machine three times to answer one question about one
     * card, and the whole read is on the path the owner waits on when he asks whether a card can be
     * restarted.
     */
    const script =
      '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; ' +
      `$ids = @(${pid}); $out = @(); ` +
      'for ($i = 0; $i -lt 3; $i++) { ' +
      '  $next = @($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId }); ' +
      '  $next = @($next | Where-Object { $out -notcontains $_ }); ' +
      '  if ($next.Count -eq 0) { break }; $out += $next; $ids = $next } ' +
      '$out -join ","'
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
    })
    return out.split(',').map((part: string) => Number(part.trim())).filter((n: number) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

/**
 * Whether this card could be restarted right now, or the one reason it could not.
 *
 * Gathers the facts and hands them to `boundaryFrom`, which does the deciding and lives in
 * `update.ts` so it can be tested without a board. Nothing here acts: no process is signalled, no
 * card is stopped, and the answer is a message.
 *
 * Silence is deliberately not one of the facts. Canon 21 is explicit that a quiet terminal may be a
 * build, a test, an import or a deployment, so what is asked instead is whether the CLI said the
 * turn was over, whether a tool call is still open, and what is actually running underneath.
 */
function safeBoundaryFor(s: TerminalSession): BoundaryResult {
  const live = ptys.isLive(s.id)
  const pid = live ? s.pid : null

  /*
   * Four hundred events is far more than one turn and far less than a card's history. The three
   * questions below all concern the newest turn, and `listEvents` returns the newest rows.
   */
  const events = store.listEvents(s.id, 400)
  let lastInputAt: number | null = null
  let lastStopAt: number | null = null
  for (const e of events) {
    if (e.type === 'UserPromptSubmit') lastInputAt = Math.max(lastInputAt ?? 0, e.ts)
    if (e.type === 'Stop') lastStopAt = Math.max(lastStopAt ?? 0, e.ts)
  }
  /*
   * A tool call with no result recorded, counted only since the last input, because a card that has
   * been through fifty turns has fifty pairs and only the newest one can still be open.
   */
  const since = lastInputAt ?? 0
  let openTools = 0
  for (const e of events) {
    if (e.ts < since) continue
    if (e.type === 'PreToolUse') openTools += 1
    if (e.type === 'PostToolUse' && openTools > 0) openTools -= 1
  }

  const claims: string[] = []
  for (const [key, held] of fileClaims) {
    if (held.cardId !== s.id) continue
    // A lease that has run out is not a claim. The same fifteen minutes the write path enforces.
    if (Date.now() - held.at > CLAIM_TTL_MS) continue
    claims.push(key)
  }

  const facts: BoundaryFacts = {
    pid,
    children: live ? liveChildren(pid) : [],
    lastInputAt,
    lastStopAt,
    openTools,
    claims,
    composerDirty: live && ptys.composerDirty(s.id),
    /*
     * A prompt on screen is the CLI's own answer, taken from the status it reports rather than from
     * anything drawn in the terminal. `waitingFor` is copied from the CLI's session file, so this is
     * the CLI saying what it is waiting for rather than Garden reading its screen.
     */
    promptOpen:
      s.status === 'needs-input' && /permission|auth|dialog|approve|trust/i.test(s.waitingFor ?? ''),
  }
  return boundaryFrom(facts)
}

/**
 * Write one card's checkpoint, and record the same facts in the store.
 *
 * Called only by the socket read that asks for it. Nothing automatic calls this, and writing a
 * checkpoint does nothing to the card: it is a description of where the work is, which is exactly
 * what would be needed before a restart and is worth being able to read on its own.
 */
function checkpointFor(s: TerminalSession): { path: string; fields: string[] } | null {
  const dir = cardDirFor(s.id)
  if (!dir) return null

  const project = store.getProject(s.projectId)
  const task = project ? store.listTasks(project.id).find((t) => t.ownerId === s.id && t.state !== 'closed') : undefined
  const running = s.adapterId === 'claude'
    ? runningVersionForConversation(s.claudeSessionId, configDirFor(s))
    : null

  const facts = checkpointFactsFrom(s, {
    executable: s.adapterId,
    runningVersion: running,
    installedVersion: installedVersionFor(s.adapterId),
    configDir: configDirFor(s),
    taskId: task?.id ?? null,
    taskState: task?.state ?? null,
    acceptanceRef: task?.acceptanceRef ? `${task.acceptanceRef.path} sha256 ${task.acceptanceRef.sha256}` : null,
    /*
     * What the card should do next, in its own words rather than Garden's. There is no field
     * anywhere that holds this today, so it is null and says so: inventing a next action from the
     * newest event would be Garden telling a card what it was doing, which is the one thing a
     * checkpoint must not get wrong.
     */
    nextAction: null,
    changedPaths: [],
    openClaims: [...fileClaims].filter(([, held]) => held.cardId === s.id).map(([key]) => key),
    operations: [],
    pendingMailIds: mailWaiting.get(s.id) ? [`${mailWaiting.get(s.id)} unread in INBOX.md`] : [],
    uncertainInput: ptys.isLive(s.id) && ptys.composerDirty(s.id)
      ? 'the composer has had keystrokes since the last submit'
      : null,
  })

  const written = writeCheckpoint(dir, facts)
  const event = {
    id: randomUUID(),
    sessionId: s.id,
    ts: Date.now(),
    type: 'CheckpointWritten',
    provenance: 'structured' as const,
    payload: checkpointRecord(facts, written.path),
  }
  store.insertEvent(event)
  broadcast({ t: 'event', event })
  return written
}

/** The whole board, plus everything task ownership has recorded about it. */
function stateMessage(): ServerMessage {
  return {
    t: 'state',
    projects: store.listProjects(),
    profiles: store.listProfiles(),
    sessions: store.listSessions(),
    docs: store.listDocs(),
    channels: store.listChannels(),
    wires: store.listWires(),
    defaultAccount: readAccount(defaultConfigDir()),
    build: BUILD,
    tasks: store.listAllTasks(),
    reassignments: store.listAllReassignments(),
    /*
     * Flat across every project rather than nested under one, because each event names the card it
     * happened on and the card names its project, so nesting would be a second copy of a fact the
     * page can already derive. Capped per project so one noisy board cannot crowd the others out of
     * the load message.
     */
    refusals: store.listProjects().flatMap((p) => store.listTaskRefusals(p.id, 200)),
  }
}

// ---------------------------------------------------------------------------
// The task operations, shared by POST /task and the task.* socket messages
// ---------------------------------------------------------------------------

type OpResult =
  | { ok: true; task?: TaskContract; row?: TaskReassignment; text?: string }
  | { ok: false; code: number; reason: string }

/**
 * Whether this actor may change a task contract at all.
 *
 * `null` is the owner at the board, who is a dispatcher by definition. Everyone else needs a role
 * whose powers say `hires`, which is the same bit `/hire` reads, so the answer cannot differ
 * between the two doors.
 */
function dispatcherCheck(actor: TerminalSession | null): { ok: true } | { ok: false; code: number; reason: string } {
  if (!actor) return { ok: true }
  if (isDispatcher(actor)) return { ok: true }
  return {
    ok: false,
    code: 403,
    reason:
      `creating, binding, reassigning and splitting work belong to a dispatcher, and a ` +
      `${actor.roleClass ?? 'card with no role'} is not one. Ask the card that assigned your work.`,
  }
}

/** A card on this project, by id or by title, preferring one still on the board. */
function cardOnProject(projectId: string, wanted: string): TerminalSession | undefined {
  const inProject = store.listSessions().filter((x) => x.projectId === projectId)
  const open = inProject.filter((x) => x.closedAt === null)
  const byName = (list: TerminalSession[]) => list.find((x) => x.title.toLowerCase() === wanted.toLowerCase())
  return inProject.find((x) => x.id === wanted) ?? byName(open) ?? byName(inProject)
}

/**
 * Read the acceptance criteria off disk and hash them, so they cannot drift under the work.
 *
 * The hash is taken at the moment of assignment and stored beside the path. Whether the file has
 * since changed is then a fact anybody can check, rather than an argument about what the work order
 * said when it was handed over. This is why `acceptanceRef` is a pair and not a path.
 */
function acceptanceRefFor(projectPath: string, rel: string): { path: string; sha256: string } | null {
  try {
    const abs = safeJoin(projectPath, rel)
    if (!abs || !existsSync(abs)) return null
    return { path: rel, sha256: sha256(readFileSync(abs, 'utf8')) }
  } catch {
    return null
  }
}

function taskCreate(actor: TerminalSession | null, projectId: string, input: any): OpResult {
  const gate = dispatcherCheck(actor)
  if (!gate.ok) return gate
  const project = store.getProject(projectId)
  if (!project) return { ok: false, code: 404, reason: 'unknown project' }

  const id = String(input?.id ?? '').trim().slice(0, 60)
  if (!id) return { ok: false, code: 400, reason: 'a task needs an id. Pass --task <id>.' }
  if (store.getTask(projectId, id)) {
    const held = store.getTask(projectId, id)!
    if (held.state !== 'unbound') {
      return {
        ok: false,
        code: 409,
        reason: `task ${id} already exists on this board, owned by ${titleOf(held.ownerId)}.`,
      }
    }
  }

  const owner = cardOnProject(projectId, String(input?.ownerId ?? '').trim())
  if (!owner) {
    return {
      ok: false,
      code: 400,
      reason:
        'a task needs an owner: the card that will be accountable for it. Pass --owner <card>. ' +
        'Garden will not open a task without one, because an ownerless task is what this whole ' +
        'guard exists to stop.',
    }
  }

  /*
   * The assigner is the card that handed the work out, and it has to be somebody, because
   * `confirm` comes back to it and `done` goes to it. The acting card is it whenever a card is
   * acting; when the owner creates a task from the board there is no card, so he names one.
   */
  const assigner = actor ?? (input?.assignerId ? cardOnProject(projectId, String(input.assignerId)) : undefined)
  if (!assigner) {
    return {
      ok: false,
      code: 400,
      reason:
        'a task needs an assigner: the card that hands the work out and that the report comes back ' +
        'to. A card creating a task is the assigner; from the board, name one with --assigner.',
    }
  }
  if (assigner.id === owner.id) {
    return {
      ok: false,
      code: 400,
      reason:
        'the assigner and the owner cannot be the same card. Confirmation is the assigner saying it ' +
        'looked at the owner\'s work, and a card confirming itself is the blind hand-off this chain ' +
        'exists to stop.',
    }
  }

  const acceptance = input?.acceptance ? String(input.acceptance) : null
  const refPath = input?.acceptanceRef?.path ? String(input.acceptanceRef.path) : null
  const acceptanceRef = refPath ? acceptanceRefFor(project.path, refPath) : null
  if (refPath && !acceptanceRef) {
    return { ok: false, code: 400, reason: `there is no file at ${refPath} in this project to hash as the acceptance criteria.` }
  }
  if (!acceptance && !acceptanceRef) {
    return {
      ok: false,
      code: 400,
      reason:
        'a task needs acceptance criteria: either --acceptance-file <path in this project>, which ' +
        'Garden hashes so it cannot be edited under the work, or --acceptance with the text. Work ' +
        'with no stated finish line cannot be verified by anybody, which is the point of a verifier.',
    }
  }

  let verifierId: string | null = null
  if (input?.verifierId) {
    const v = cardOnProject(projectId, String(input.verifierId))
    if (!v) return { ok: false, code: 400, reason: 'that verifier is not a card on this board' }
    const bad = verifierRefusal(v.id, owner.id, assigner.id)
    if (bad) return { ok: false, code: 400, reason: bad }
    verifierId = v.id
  }

  const now = Date.now()
  const task: TaskContract = {
    id,
    projectId,
    ownerId: owner.id,
    assignerId: assigner.id,
    requiredRole: input?.requiredRole ? (String(input.requiredRole) as any) : null,
    territory: Array.isArray(input?.territory) ? input.territory.map(String) : [],
    acceptance,
    acceptanceRef,
    verifierId,
    parentId: input?.parentId ? String(input.parentId) : null,
    state: 'assigned',
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  }
  store.upsertTask(task)
  const saved = store.getTask(projectId, id)!
  broadcast({ t: 'task.updated', task: saved })
  return { ok: true, task: saved }
}

/** Why a card may not be this task's verifier, or nothing. */
function verifierRefusal(verifierId: string, ownerId: string | null, assignerId: string | null): string | null {
  if (verifierId === ownerId) {
    return (
      `${titleOf(verifierId)} owns this task, so it cannot also verify it. An independent verifier is ` +
      'a card that is neither the owner nor the assigner, and that independence is the only thing the ' +
      'role is for.'
    )
  }
  if (verifierId === assignerId) {
    return (
      `${titleOf(verifierId)} assigned this task, so it cannot also verify it: it would be checking ` +
      'whether the work it specified is the work it asked for.'
    )
  }
  return null
}

function taskBind(actor: TerminalSession | null, projectId: string, msg: any): OpResult {
  const gate = dispatcherCheck(actor)
  if (!gate.ok) return gate
  const taskId = String(msg?.taskId ?? '').trim()
  const task = store.getTask(projectId, taskId)
  if (!task) return { ok: false, code: 404, reason: `no task ${taskId} on this board` }
  if (task.state !== 'unbound') {
    return {
      ok: false,
      code: 409,
      reason:
        `${task.id} already has an owner, ${titleOf(task.ownerId)}. Binding is only for the tasks ` +
        'Garden found in its own mail history, which have never had one. Use reassign, with a reason.',
    }
  }
  const owner = cardOnProject(projectId, String(msg?.ownerId ?? ''))
  if (!owner) return { ok: false, code: 400, reason: 'that owner is not a card on this board' }
  const assigner = actor ?? cardOnProject(projectId, String(msg?.assignerId ?? ''))
  if (!assigner) {
    return { ok: false, code: 400, reason: 'a bound task needs an assigner as well as an owner' }
  }
  if (assigner.id === owner.id) {
    return { ok: false, code: 400, reason: 'the assigner and the owner cannot be the same card' }
  }

  const bound: TaskContract = {
    ...task,
    ownerId: owner.id,
    assignerId: assigner.id,
    state: 'assigned',
    updatedAt: Date.now(),
  }
  store.upsertTask(bound)
  /*
   * Even the first owner has a recorded origin. Without this row a bound legacy task would be
   * indistinguishable from one somebody declared at the time, and the whole reason `unbound` exists
   * is that those two are not the same claim.
   */
  const row: TaskReassignment = {
    id: randomUUID(),
    taskId: task.id,
    projectId,
    fromOwnerId: null,
    toOwnerId: owner.id,
    reason: 'legacy_bind',
    note: String(msg?.note ?? '').slice(0, 2000),
    byId: actor?.id ?? null,
    ts: Date.now(),
  }
  store.insertReassignment(row)
  const saved = store.getTask(projectId, task.id)!
  broadcast({ t: 'task.updated', task: saved })
  broadcast({ t: 'task.reassigned', row })
  return { ok: true, task: saved, row }
}

function taskReassign(actor: TerminalSession | null, projectId: string, msg: any): OpResult {
  const gate = dispatcherCheck(actor)
  if (!gate.ok) return gate
  const taskId = String(msg?.taskId ?? '').trim()
  const task = store.getTask(projectId, taskId)
  if (!task) return { ok: false, code: 404, reason: `no task ${taskId} on this board` }
  const to = cardOnProject(projectId, String(msg?.toOwnerId ?? ''))
  if (!to) return { ok: false, code: 400, reason: 'that card is not on this board' }

  /*
   * The line that stops a verifier quietly becoming the implementer. Ancestors included, because a
   * subtask of something you are checking is still your own work coming back to you with a
   * different id on it.
   */
  const verifiers = verifierAncestry(task, (id) => store.getTask(projectId, id))
  if (verifiers.has(to.id)) {
    return {
      ok: false,
      code: 403,
      reason:
        `${to.title} is the independent verifier of ${task.id} or of a task it belongs to, so it ` +
        'cannot be given the work as well. That is the one move this whole design exists to refuse: ' +
        'a card that checks the work and then does it has checked nothing.',
    }
  }

  const reason = String(msg?.reason ?? '')
  const note = String(msg?.note ?? '').slice(0, 2000)
  const verdict = reassignEvidence(task, factsOf(store.getSession(task.ownerId ?? '')), factsOf(to), reason, note, {
    now: Date.now(),
    silenceMinutes: store.getLimits(projectId).silenceMinutes,
    lastActivityFor: (id) => store.lastActivityFor(id),
    taskById: (id) => store.getTask(projectId, id),
    blockedBy: msg?.blockedBy ? String(msg.blockedBy).trim() : null,
    titleOf,
  })
  if (!verdict.allowed) return { ok: false, code: 403, reason: verdict.reason }

  const row: TaskReassignment = {
    id: randomUUID(),
    taskId: task.id,
    projectId,
    fromOwnerId: task.ownerId,
    toOwnerId: to.id,
    reason: reason as ReassignReason,
    note,
    // The guard's own sentence, kept apart from the note the dispatcher wrote, so a reader months
    // later can tell what Garden checked from what somebody asserted.
    evidence: verdict.reason ?? '',
    byId: actor?.id ?? null,
    ts: Date.now(),
  }
  store.insertReassignment(row)
  store.upsertTask({ ...task, ownerId: to.id, updatedAt: Date.now() })
  const saved = store.getTask(projectId, task.id)!
  broadcast({ t: 'task.updated', task: saved })
  broadcast({ t: 'task.reassigned', row })
  // An allow that came with something to say says it, rather than reading as an ordinary move. Only
  // `owner_stopped` on a card that has left the board does this today.
  return verdict.reason
    ? {
        ok: true,
        task: saved,
        row,
        text: `task ${saved.id} is ${saved.state}, owned by ${titleOf(saved.ownerId)}. ${verdict.reason}`,
      }
    : { ok: true, task: saved, row }
}

/**
 * Break a task into pieces, each with an owner of its own.
 *
 * This is the answer to criticism that crosses a boundary. A verifier that finds faults in two
 * cards' territory cannot send one remediation to whichever card is awake, because `remediation`
 * only travels to the owner; it splits instead, and each owner then gets only its own.
 *
 * A piece with no owner named goes to `paused` rather than being refused or guessed at. Refusing
 * would throw away the pieces that did have owners, and guessing would invent accountability.
 */
function taskSplit(actor: TerminalSession | null, projectId: string, msg: any): OpResult {
  const gate = dispatcherCheck(actor)
  if (!gate.ok) return gate
  const parent = store.getTask(projectId, String(msg?.taskId ?? '').trim())
  if (!parent) return { ok: false, code: 404, reason: `no task ${msg?.taskId} on this board` }
  const into = Array.isArray(msg?.into) ? msg.into : []
  if (into.length === 0) return { ok: false, code: 400, reason: 'a split needs at least one piece' }

  const verifiers = verifierAncestry(parent, (id) => store.getTask(projectId, id))
  const made: TaskContract[] = []
  const now = Date.now()
  for (const piece of into) {
    const id = String(piece?.id ?? '').trim().slice(0, 60)
    if (!id) return { ok: false, code: 400, reason: 'every piece of a split needs an id' }
    const owner = piece?.ownerId ? cardOnProject(projectId, String(piece.ownerId)) : undefined
    if (owner && verifiers.has(owner.id)) {
      return {
        ok: false,
        code: 403,
        reason:
          `${owner.title} verifies ${parent.id} or a task it belongs to, so a piece of it cannot be ` +
          'given to that card. Splitting a task and handing a piece to its verifier is the same loss ' +
          'of independence taken one step at a time.',
      }
    }
    made.push({
      id,
      projectId,
      ownerId: owner?.id ?? null,
      // The parent's assigner carries down, so `done` on a piece goes to the card that broke the
      // work up rather than to nobody.
      assignerId: owner ? parent.assignerId : null,
      requiredRole: parent.requiredRole,
      territory: Array.isArray(piece?.territory) ? piece.territory.map(String) : parent.territory,
      acceptance: parent.acceptance,
      acceptanceRef: parent.acceptanceRef,
      verifierId: parent.verifierId,
      parentId: parent.id,
      state: owner ? 'assigned' : 'paused',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    })
  }

  for (const t of made) {
    store.upsertTask(t)
    const saved = store.getTask(projectId, t.id)!
    broadcast({ t: 'task.updated', task: saved })
  }
  const paused = made.filter((t) => t.state === 'paused').map((t) => t.id)
  return {
    ok: true,
    task: store.getTask(projectId, parent.id)!,
    text:
      `${parent.id} split into ${made.map((t) => t.id).join(', ')}.` +
      (paused.length
        ? ` ${paused.join(', ')} named no owner, so ${paused.length === 1 ? 'it is' : 'they are'} paused ` +
          'rather than assigned. Garden does not pick an owner for work nobody named one for.'
        : ''),
  }
}

function taskVerifier(actor: TerminalSession | null, projectId: string, msg: any): OpResult {
  const gate = dispatcherCheck(actor)
  if (!gate.ok) return gate
  const task = store.getTask(projectId, String(msg?.taskId ?? '').trim())
  if (!task) return { ok: false, code: 404, reason: `no task ${msg?.taskId} on this board` }

  if (msg?.verifierId === null || msg?.verifierId === undefined || msg?.verifierId === '') {
    store.upsertTask({ ...task, verifierId: null, updatedAt: Date.now() })
    const cleared = store.getTask(projectId, task.id)!
    broadcast({ t: 'task.updated', task: cleared })
    return { ok: true, task: cleared }
  }

  const v = cardOnProject(projectId, String(msg.verifierId))
  if (!v) return { ok: false, code: 400, reason: 'that card is not on this board' }
  const bad = verifierRefusal(v.id, task.ownerId, task.assignerId)
  if (bad) return { ok: false, code: 403, reason: bad }
  store.upsertTask({ ...task, verifierId: v.id, updatedAt: Date.now() })
  const saved = store.getTask(projectId, task.id)!
  broadcast({ t: 'task.updated', task: saved })
  return { ok: true, task: saved }
}

/** The contract as a card reads it, plus how it got here and what it has refused. */
function taskShow(projectId: string, taskId: string): OpResult {
  const task = store.getTask(projectId, taskId)
  if (!task) return { ok: false, code: 404, reason: `no task ${taskId} on this board` }
  const rows = store.listReassignments(projectId).filter((r) => r.taskId === taskId)
  const refusals = store
    .listTaskRefusals(projectId, 200)
    .filter((e) => (e.payload as any)?.taskId === taskId)
  const lines = [
    `Task ${task.id}  (${task.state})`,
    `  owner     ${titleOf(task.ownerId)}`,
    `  assigner  ${titleOf(task.assignerId)}`,
    `  verifier  ${titleOf(task.verifierId)}`,
    `  territory ${task.territory.length ? task.territory.join(', ') : 'none declared'}`,
    `  required  ${task.requiredRole ?? 'any role'}`,
    `  parent    ${task.parentId ?? 'none'}`,
  ]
  if (task.acceptanceRef) lines.push(`  criteria  ${task.acceptanceRef.path}  sha256 ${task.acceptanceRef.sha256}`)
  if (task.acceptance) lines.push('', 'Acceptance criteria:', task.acceptance)
  if (rows.length) {
    lines.push('', 'How it changed hands:')
    for (const r of rows) {
      lines.push(`  ${new Date(r.ts).toISOString()}  ${titleOf(r.fromOwnerId)} -> ${titleOf(r.toOwnerId)}  ${r.reason}  ${r.note}`)
      // Kept on its own line and attributed, so what Garden checked is never read as part of what the
      // dispatcher wrote in the note above it.
      if (r.evidence) lines.push(`      Garden found: ${r.evidence}`)
    }
  }
  if (refusals.length) {
    lines.push('', 'What ownership stopped, newest first:')
    for (const e of refusals.slice(0, 20)) {
      const p = e.payload as any
      lines.push(`  ${new Date(e.ts).toISOString()}  ${e.type}  ${p?.rule}  ${p?.reason}`)
    }
  }
  return { ok: true, task, text: lines.join('\n') }
}

/**
 * Read or set how hard ownership bites, from a terminal.
 *
 * This setting used to be two radio buttons in the sidebar and the owner asked for them to go. It is
 * board policy rather than one card's business, so it is not open to a dispatcher the way creating
 * and reassigning are: the owner's own key, or the orchestrator, which is the card canon puts in
 * charge of the control plane. Everything else is refused in the same shape `dispatcherCheck` uses,
 * naming the role that asked.
 *
 * `enforce` is allowed from the orchestrator's token as well as the key, which is a deliberate
 * difference from `limits.set` over the socket. That rule exists because a browser window that
 * enforced without having presented the key would have locked itself out of turning it off again. A
 * terminal cannot lock itself out: the owner's key is on disk and this same command reads it.
 */
function taskAuthorityOp(
  actor: TerminalSession | null,
  projectId: string,
  keyed: boolean,
  msg: any,
): OpResult {
  const asked = msg?.authority === null || msg?.authority === undefined ? null : String(msg.authority)
  const held = store.getLimits(projectId)

  if (asked === null) {
    const floor = process.env.GARDEN_TASK_AUTHORITY === 'enforce' && held.taskAuthority !== 'enforce'
    return {
      ok: true,
      text:
        `task ownership on this project is ${held.taskAuthority}` +
        (floor ? ', and GARDEN_TASK_AUTHORITY=enforce in this server\'s environment raises it to enforce' : ''),
    }
  }

  if (!keyed && actor?.roleClass !== 'orchestrator') {
    return {
      ok: false,
      code: 403,
      reason:
        'how hard ownership bites is board policy, not one card\'s setting, so it belongs to the ' +
        `owner or to the orchestrator, and a ${actor?.roleClass ?? 'card with no role'} is neither. ` +
        'Ask the orchestrator, and it will answer along a wire.',
    }
  }

  if (asked !== 'off' && asked !== 'shadow' && asked !== 'enforce') {
    return {
      ok: false,
      code: 400,
      reason: `"${asked}" is not a setting. They are off, shadow and enforce.`,
    }
  }

  store.setLimits(projectId, { ...held, taskAuthority: asked })
  // Every window, for the same reason `limits.set` does it: two clients disagreeing about this is
  // how one of them starts showing refusals it cannot explain.
  announceLimits(projectId)
  return { ok: true, text: `task ownership on this project is now ${asked}` }
}

/**
 * Read or set what may authorize an update restart, from a terminal.
 *
 * The same door, the same two identities and the same refusal shape as `authority` above, because
 * it is the same kind of decision: board policy, per project, with no panel. `when-safe` is the
 * owner saying in advance that a card may be restarted once it reaches a safe boundary, and
 * `manual` is nothing being allowed to.
 *
 * Nothing consumes the setting yet. This stage knows and records; the stage that acts is ordered
 * separately, and storing the policy before anything reads it is deliberate: the owner can set it,
 * see it on the board, and change his mind, all before a single card is ever restarted.
 */
function updatePolicyOp(
  actor: TerminalSession | null,
  projectId: string,
  keyed: boolean,
  msg: any,
): OpResult {
  const asked = msg?.policy === null || msg?.policy === undefined ? null : String(msg.policy)
  const held = store.getLimits(projectId)

  if (asked === null) {
    return {
      ok: true,
      text:
        `update policy on this project is ${held.updatePolicy}` +
        (held.updatePolicy === 'manual'
          ? ', so nothing authorizes a restart and each one is the owner\'s'
          : ', so a card may be restarted once it reaches a safe boundary') +
        '. Nothing acts on it yet.',
    }
  }

  if (!keyed && actor?.roleClass !== 'orchestrator') {
    return {
      ok: false,
      code: 403,
      reason:
        'whether cards may restart themselves for an update is board policy, not one card\'s ' +
        `setting, so it belongs to the owner or to the orchestrator, and a ${actor?.roleClass ?? 'card with no role'} ` +
        'is neither. Ask the orchestrator, and it will answer along a wire.',
    }
  }

  if (asked !== 'manual' && asked !== 'when-safe') {
    return {
      ok: false,
      code: 400,
      reason: `"${asked}" is not a policy. They are manual and when-safe.`,
    }
  }

  store.setLimits(projectId, { ...held, updatePolicy: asked })
  announceLimits(projectId)
  return { ok: true, text: `update policy on this project is now ${asked}. Nothing acts on it yet.` }
}

/** Everything the board should know about one project's tasks, in one place. */
function taskStateMessage(projectId: string): ServerMessage {
  return {
    t: 'task.state',
    projectId,
    tasks: store.listTasks(projectId),
    reassignments: store.listReassignments(projectId),
    refusals: store.listTaskRefusals(projectId),
  }
}

/**
 * How many finished-task reports an orchestrator keeps as their own cards, once the "Reports" pill
 * is opened. Beyond this, older ones roll into one archive card, the same "N rolled up, here's
 * what's in it" shape `history.ts` already uses for turns. Nothing on disk is deleted, only taken
 * off the board.
 */
const REPORT_CAP = 6
const REPORT_COLS = 2
const REPORT_W = 420
const REPORT_H = 300

/**
 * Write a finished task's report to disk, and nothing else.
 *
 * This used to also put a card on the board immediately, no click involved — every "done" a worker
 * sent shoved every earlier report card further away, unconditionally: two survivors on the owner's
 * real board ended up 36,412 pixels apart. His answer, once the drift itself was fixed, was that he
 * did not want the auto-appearing part either: "i dont want it to auto open history." So this now
 * only keeps the file current. It shows up the same way a day of turns does — a pill, opened by
 * hand, drawing nothing until then.
 */
function openCompletionReport(orchestrator: TerminalSession, taskId: string): void {
  const project = store.getProject(orchestrator.projectId)
  if (!project) return
  const hops = hopsForTask(store, project.id, taskId)
  const dir = historyDirFor(orchestrator.id)
  const abs = join(dir, `task-${taskId.replace(/[^a-zA-Z0-9-]/g, '-')}.md`)
  writeFileSync(abs, completionReport(store, taskId, hops, project.id), 'utf8')
}

/**
 * Every task id that has reported home to this orchestrator, newest first.
 *
 * Read from the delivery events Garden already recorded for real (`MailDelivered`, kind `done` or
 * `assessment`, carrying a task id) rather than from anything drawn on the board, the same way a
 * day's turn count comes from the work table rather than from cards that may or may not be open.
 * A task that reported twice (a `done`, later an `assessment`) counts once, at its latest hop.
 */
function reportTaskIdsFor(orchestrator: TerminalSession): Array<{ taskId: string; latest: number }> {
  const byTask = new Map<string, number>()
  // Every delivery rather than a page of events, for the same reason `hopsForTask` reads them that
  // way: an orchestrator is the busiest card on any board, so its finished work is exactly what a
  // cap loses, and a report missing from the board is indistinguishable from work nobody did.
  for (const e of store.listMailDelivered(orchestrator.id)) {
    const p = e.payload as { taskId?: string; kind?: string } | undefined
    if (!p?.taskId || (p.kind !== 'done' && p.kind !== 'assessment')) continue
    byTask.set(p.taskId, Math.max(byTask.get(p.taskId) ?? 0, e.ts))
  }
  return [...byTask.entries()].map(([taskId, latest]) => ({ taskId, latest })).sort((a, b) => b.latest - a.latest)
}

/**
 * Put the kept set of task reports on the board, fresh, the way opening a day of turns already
 * works: delete whatever was there for this group and redraw from the current facts, rather than
 * nudging on top of whatever a previous open left behind. That is what keeps this from drifting —
 * a block computed fresh every time converges to a stable footprint instead of climbing with every
 * task that finishes, which is what happened when this ran automatically on every completion.
 */
function openReportsPill(orchestrator: TerminalSession, projectId: string): void {
  const taskIds = reportTaskIdsFor(orchestrator)
  const kept = taskIds.slice(0, REPORT_CAP)
  const overflow = taskIds.slice(REPORT_CAP)

  const dir = historyDirFor(orchestrator.id)
  const toPlace: DocCard[] = []

  if (overflow.length) {
    const lines = [
      `# Earlier task reports for ${orchestrator.title}`,
      '',
      `${overflow.length} older report${overflow.length === 1 ? '' : 's'}, rolled up here instead of ` +
        `kept as ${overflow.length} separate cards. Nothing was deleted: each one's full report is ` +
        'still the file named below.',
      '',
    ]
    // Oldest to newest, so the list reads in the order the tasks actually finished.
    ;[...overflow].reverse().forEach(({ taskId, latest }) => {
      const abs = join(dir, `task-${taskId.replace(/[^a-zA-Z0-9-]/g, '-')}.md`)
      lines.push(`- ${stamp(latest)} — task ${taskId} (${abs})`)
    })
    const archivePath = join(dir, '_reports-archive.md')
    writeFileSync(archivePath, lines.join('\n'), 'utf8')
    toPlace.push({
      id: randomUUID(),
      projectId,
      relPath: archivePath,
      external: true,
      ownerId: orchestrator.id,
      web: 'history',
      kind: 'text',
      size: 'normal',
      fontSize: null,
      group: 'reports',
      title: `${orchestrator.title}: earlier reports`,
      x: orchestrator.x,
      y: orchestrator.y,
      width: REPORT_W,
      height: REPORT_H,
      collapsed: true,
      manualPos: true,
      images: [],
      createdAt: Date.now(),
    })
  }

  for (const { taskId, latest } of kept) {
    const abs = join(dir, `task-${taskId.replace(/[^a-zA-Z0-9-]/g, '-')}.md`)
    toPlace.push({
      id: randomUUID(),
      projectId,
      relPath: abs,
      external: true,
      ownerId: orchestrator.id,
      web: 'history',
      kind: 'text',
      size: 'normal',
      fontSize: null,
      group: 'reports',
      title: `task ${taskId}: what came back`,
      x: orchestrator.x,
      y: orchestrator.y,
      width: REPORT_W,
      height: REPORT_H,
      collapsed: true,
      manualPos: true,
      images: [],
      createdAt: latest,
    })
  }

  if (toPlace.length === 0) return

  const GAP = BOARD.GAP
  const ROW_PITCH = BOARD.COLLAPSED_H + BOARD.WEB_ROW_GAP
  const cols = Math.min(REPORT_COLS, toPlace.length)
  const rows = Math.max(1, Math.ceil(toPlace.length / REPORT_COLS))
  const totalWidth = cols * REPORT_W + (cols - 1) * GAP
  const originX = orchestrator.x + orchestrator.width / 2 - totalWidth / 2
  const originY = orchestrator.y - BOARD.GAP - BOARD.PORT_REACH - BOARD.FRAME_PAD - BOARD.COLLAPSED_H
  const blockHeight = (rows - 1) * ROW_PITCH + BOARD.COLLAPSED_H

  const room = insertBand(
    projectId,
    orchestrator.y,
    blockHeight + FRAME_HEADROOM + BOARD.FRAME_PAD + BOARD.GAP + BOARD.PORT_REACH,
    new Set<string>([orchestrator.id]),
    'up',
  )
  roomMade.set(`${orchestrator.id}:history`, room.pushed)
  announceMoved(room.moved)

  toPlace.forEach((d, i) => {
    const placed: DocCard = {
      ...d,
      x: originX + (i % REPORT_COLS) * (REPORT_W + GAP),
      y: originY - Math.floor(i / REPORT_COLS) * ROW_PITCH,
    }
    store.upsertDoc(placed)
    broadcast({ t: 'doc.added', card: placed })

    const wire: Wire = {
      id: randomUUID(),
      projectId,
      sourceId: orchestrator.id,
      targetId: placed.id,
      label: '',
      kind: 'history',
      bidirectional: false,
      createdAt: Date.now(),
    }
    store.upsertWire(wire)
    broadcast({ t: 'wire.added', wire })
  })

  resolveOverlaps(projectId, new Set<string>([orchestrator.id]))
}

function snapshotLayout(
  projectId: string,
  name: string,
  automatic: boolean,
  basedOn: string | null = null,
): void {
  const positions = [
    ...store.listSessions().filter((s) => s.projectId === projectId).map((s) => ({ id: s.id, x: s.x, y: s.y })),
    ...store.listDocs().filter((d) => d.projectId === projectId).map((d) => ({ id: d.id, x: d.x, y: d.y })),
  ]
  if (positions.length === 0) return
  store.saveLayout({
    id: randomUUID(),
    projectId,
    name,
    automatic,
    basedOn,
    positions,
    savedAt: Date.now(),
  })
}

/**
 * Move a card's roots and history by the same distance the card just moved.
 *
 * A web is not a thing that happens to be near a card, it is that card's own files and that card's
 * own past, and the only reason anyone can tell whose they are is that they sit against it. Left
 * behind by a drag they become a block attached to nothing, or worse, a block sitting against
 * somebody else's card and reading as theirs.
 */
function moveWebsBy(ownerId: string, dx: number, dy: number): void {
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
  for (const web of ['context', 'history'] as const) {
    for (const card of store.listWebDocs(ownerId, web)) {
      const updated = { ...card, x: card.x + dx, y: card.y + dy, manualPos: true }
      store.upsertDoc(updated)
      broadcast({ t: 'doc.updated', card: updated })
    }
  }
}

/**
 * Put a card's webs back where they belong after the card changed shape.
 *
 * This is the one the owner diagnosed himself: the roots are placed against the bottom edge of the
 * card at the moment they are opened, so a card later dragged taller grows straight down over its
 * own block, and one made wider slides out from under it sideways. The block never moved because
 * nothing was watching the card's size, only its position.
 *
 * Roots hang from the bottom edge and follow it. History stands on the top edge and follows that.
 * Both are centred on the card, so both follow half of any width change. Then the ordinary pass
 * runs with this card held still, since it is the one he is resizing and the last thing he wants is
 * for it to jump away under the pointer.
 */
function refitWebs(before: TerminalSession, after: TerminalSession): void {
  const boxOf = (s: TerminalSession) => ({
    top: s.y,
    bottom: s.y + (s.collapsed ? BOARD.COLLAPSED_H : s.height),
    centre: s.x + s.width / 2,
  })
  const was = boxOf(before)
  const now = boxOf(after)
  const dx = now.centre - was.centre

  for (const card of store.listWebDocs(after.id, 'context')) {
    const updated = { ...card, x: card.x + dx, y: card.y + (now.bottom - was.bottom), manualPos: true }
    store.upsertDoc(updated)
    broadcast({ t: 'doc.updated', card: updated })
  }
  for (const card of store.listWebDocs(after.id, 'history')) {
    const updated = { ...card, x: card.x + dx, y: card.y + (now.top - was.top), manualPos: true }
    store.upsertDoc(updated)
    broadcast({ t: 'doc.updated', card: updated })
  }
  resolveOverlaps(after.projectId, new Set<string>([after.id]))
}

function resolveOverlaps(projectId: string, anchors: Set<string>): void {
  const PAD = BOARD.GAP

  /**
   * One thing that has to stay clear of every other thing.
   *
   * A web is one of these, not several. Its cards are laid out against each other deliberately, in
   * columns and rows that mean something, so nudging one of them individually to escape a
   * collision breaks the block it belongs to; and the frame painted round the whole web is what
   * the eye reads as its edge, so the block that has to clear its neighbours is the frame, not the
   * cards inside it. Treating the cards separately let a web straddle a card: half of it above,
   * half below, and the card in the middle of somebody else's roots.
   */
  type Rect = { x: number; y: number; w: number; h: number }
  /**
   * A card and everything that belongs to it, moved as one.
   *
   * The owner settled this in two sentences: a card that overlaps a roots or history block snaps
   * away from its parent, and roots and history move with their session. Both are the same
   * statement, that a session's webs are part of that session, so this is one block holding the
   * card plus its two webs. Anything else has to clear all of it, and when it moves, all of it goes.
   *
   * Several rectangles rather than one box around the lot, because history sits above a card and
   * roots below, and the box enclosing all three would reserve two web heights of empty space to
   * either side of a card whose webs are both shut.
   */
  type Block = { members: string[]; rects: Rect[]; top: number; dy: number }

  const heightOf = (c: { collapsed: boolean; height: number }) => (c.collapsed ? BOARD.COLLAPSED_H : c.height)

  /** The frame as it is actually drawn: padding all round, title bar and labels above the top row. */
  const frameAround = (cards: DocCard[]): Rect => {
    const left = Math.min(...cards.map((d) => d.x))
    const top = Math.min(...cards.map((d) => d.y))
    const right = Math.max(...cards.map((d) => d.x + d.width))
    const bottom = Math.max(...cards.map((d) => d.y + heightOf(d)))
    return {
      x: left - BOARD.FRAME_PAD,
      y: top - FRAME_HEADROOM,
      w: right - left + BOARD.FRAME_PAD * 2,
      h: bottom - top + FRAME_HEADROOM + BOARD.FRAME_PAD,
    }
  }

  const blocks: Block[] = []
  const claimed = new Set<string>()

  for (const s of store.listSessions().filter((x) => x.projectId === projectId)) {
    const members = [s.id]
    /*
     * The card plus the arrows and labels that hang off its top and bottom edge. Those are the
     * controls for opening its two webs, and a neighbour parked against the border covers them.
     */
    const rects: Rect[] = [
      { x: s.x, y: s.y - BOARD.PORT_REACH, w: s.width, h: heightOf(s) + BOARD.PORT_REACH * 2 },
    ]
    for (const web of ['context', 'history'] as const) {
      const cards = store.listWebDocs(s.id, web).filter((d) => d.projectId === projectId)
      if (cards.length === 0) continue
      rects.push(frameAround(cards))
      for (const d of cards) {
        members.push(d.id)
        claimed.add(d.id)
      }
    }
    blocks.push({ members, rects, top: Math.min(...rects.map((r) => r.y)), dy: 0 })
  }

  // Anything not attached to a card stands on its own.
  for (const d of store.listDocs().filter((x) => x.projectId === projectId && !claimed.has(x.id))) {
    const rect = { x: d.x, y: d.y, w: d.width, h: heightOf(d) }
    blocks.push({ members: [d.id], rects: [rect], top: rect.y, dy: 0 })
  }

  /*
   * The cards that are not allowed to move go down first, then everything else in board order.
   *
   * An anchor is whatever the owner is touching: the card he is resizing, the web he just opened.
   * Taking blocks strictly top to bottom meant a block above an anchor settled before the anchor
   * was even considered, and by the time the anchor arrived and refused to move, the collision had
   * nowhere left to go. Settling the immovable ones first gives everything else something real to
   * clear.
   */
  blocks.sort((a, b) => a.top - b.top)
  const held = (b: Block) => b.members.some((id) => anchors.has(id))
  const ordered = [...blocks.filter(held), ...blocks.filter((b) => !held(b))]

  const clash = (a: Rect, b: Rect, shift: number) =>
    a.x < b.x + b.w + PAD &&
    a.x + a.w + PAD > b.x &&
    a.y + shift < b.y + b.h + PAD &&
    a.y + shift + a.h + PAD > b.y

  const settled: Block[] = []
  for (const block of ordered) {
    if (held(block)) {
      settled.push(block)
      continue
    }
    let shift = 0
    // Walk down past anything already settled that this would land on. Bounded because each step
    // clears at least one block and a board is finite.
    for (let guard = 0; guard < 400; guard++) {
      let worst = 0
      for (const other of settled) {
        for (const mine of block.rects) {
          for (const theirs of other.rects) {
            if (!clash(mine, theirs, shift)) continue
            worst = Math.max(worst, theirs.y + theirs.h + PAD - (mine.y + shift))
          }
        }
      }
      if (worst <= 0) break
      shift += worst
    }
    block.dy = shift
    settled.push({ ...block, rects: block.rects.map((r) => ({ ...r, y: r.y + shift })) })
  }

  // A card and its webs move by the same distance, which is what keeps them one card.
  for (const block of blocks) {
    if (Math.abs(block.dy) <= 0.5) continue
    for (const id of block.members) {
      const session = store.getSession(id)
      if (session) {
        const updated = { ...session, y: session.y + block.dy, manualPos: true }
        store.upsertSession(updated)
        broadcast({ t: 'session.updated', session: updated })
        continue
      }
      const doc = store.getDoc(id)
      if (!doc) continue
      const updated = { ...doc, y: doc.y + block.dy, manualPos: true }
      store.upsertDoc(updated)
      broadcast({ t: 'doc.updated', card: updated })
    }
  }
}

function clearBlock(
  projectId: string,
  block: Rect,
  keep: Set<string>,
  direction: 'down' | 'up',
  key: string,
): void {
  const pad = 28
  const moved: Array<TerminalSession | DocCard> = []
  const pushed: Array<{ id: string; dy: number }> = []

  const hits = (x: number, y: number, w: number, h: number) =>
    x < block.x + block.w + pad && x + w + pad > block.x && y < block.y + block.h + pad && y + h + pad > block.y

  for (const session of store.listSessions().filter((x) => x.projectId === projectId)) {
    if (keep.has(session.id)) continue
    const h = session.collapsed ? BOARD.COLLAPSED_H : session.height
    if (!hits(session.x, session.y, session.width, h)) continue
    const y = direction === 'down' ? block.y + block.h + pad : block.y - h - pad
    const updated = { ...session, y, manualPos: true }
    store.upsertSession(updated)
    moved.push(updated)
    pushed.push({ id: session.id, dy: y - session.y })
  }

  for (const doc of store.listDocs().filter((x) => x.projectId === projectId)) {
    if (keep.has(doc.id)) continue
    const h = doc.collapsed ? BOARD.COLLAPSED_H : doc.height
    if (!hits(doc.x, doc.y, doc.width, h)) continue
    const y = direction === 'down' ? block.y + block.h + pad : block.y - h - pad
    const updated = { ...doc, y, manualPos: true }
    store.upsertDoc(updated)
    moved.push(updated)
    pushed.push({ id: doc.id, dy: y - doc.y })
  }

  if (pushed.length) roomMade.set(key, [...(roomMade.get(key) ?? []), ...pushed])
  announceMoved(moved)
}

function placeUnder(
  owner: TerminalSession,
  width: number,
  height: number,
  key: string,
): { x: number; y: number } {
  const ownerH = owner.collapsed ? BOARD.COLLAPSED_H : owner.height
  const spot = {
    x: owner.x + owner.width / 2 - width / 2,
    y: owner.y + ownerH + 90,
  }
  const room = insertBand(owner.projectId, spot.y, height + 60, new Set<string>([owner.id]), 'down')
  if (room.pushed.length) {
    const existing = roomMade.get(key) ?? []
    roomMade.set(key, [...existing, ...room.pushed])
  }
  announceMoved(room.moved)
  return spot
}

/**
 * The mirror of placeUnder, for a card that belongs above.
 *
 * Top is history and bottom is roots, and that is all those two edges mean. A transcript and a
 * completion report are both records of what a card did, both are created with web: 'history',
 * and both were being put underneath it. Canvas draws one frame per owner and web, so a
 * transcript below a card whose turns were already unfolded above gave one History frame running
 * past the card in both directions, with the card sitting inside its own history.
 */
function placeAbove(
  owner: TerminalSession,
  width: number,
  height: number,
  key: string,
): { x: number; y: number } {
  const spot = {
    x: owner.x + owner.width / 2 - width / 2,
    y: owner.y - height - 90,
  }
  const room = insertBand(owner.projectId, owner.y, height + 60, new Set<string>([owner.id]), 'up')
  if (room.pushed.length) {
    const existing = roomMade.get(key) ?? []
    roomMade.set(key, [...existing, ...room.pushed])
  }
  announceMoved(room.moved)
  return spot
}

/**
 * The conversation to resume this card into, or null to start a new one.
 *
 * Two columns describe a card's conversation and they can disagree, so which one is trusted is the
 * whole of this function. `claudeSessionId` is rewritten from every hook event that carries one, so
 * after a `/clear` or an earlier resume it holds the newest id the CLI has announced.
 * `transcriptPath` is written by a separate conditional over the same payload, so an event carrying
 * an id and no path moves one and not the other. That leaves the path as the staler of the two, and
 * a stale path that still exists on disk names a real file full of the wrong conversation.
 *
 * So the id decides, and the file is only ever asked to confirm it: resume `claudeSessionId`, and
 * only when a transcript named for that exact id is on disk. Preferring the filename instead would
 * silently reopen a pre-`/clear` history while the card claimed to be carrying on, which is the one
 * thing this project refuses to do. A miss starts a new conversation, which is honest and visible.
 *
 * The check is a filesystem check rather than a trust exercise because `claude --resume` on an id
 * that names nothing does not fall back: it prints "No conversation found" and leaves the card
 * sitting at a bare shell prompt, looking exactly like a crash.
 */
/** Where this card's CLI keeps its conversations and its registry of what is running. */
function configDirFor(s: TerminalSession): string {
  const boundId = store.getProjectProfile(s.projectId, s.adapterId)
  const profile = boundId ? store.getProfile(boundId) : undefined
  if (profile) return getAdapter(s.adapterId).configDirFor(profile)
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function resumeIdFor(s: TerminalSession): string | null {
  if (s.adapterId !== 'claude') return null
  /*
   * Only a card that owns a conversation. A subagent card holds a sidechain transcript and its
   * parent's session id, so resuming one would open the parent's conversation under the child's
   * name: two cards claiming the same history, and neither of them saying so.
   */
  if (s.kind !== 'session') return null
  const id = s.claudeSessionId
  if (!id || !/^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(id)) return null

  // The reported path, but only if it is this conversation's and not a leftover from a previous one.
  if (s.transcriptPath && basename(s.transcriptPath).replace(/\.jsonl$/i, '') === id && existsSync(s.transcriptPath)) {
    return id
  }
  /*
   * Otherwise look where the CLI would have put it. Same derivation the context gauge already uses
   * in ingest.ts: the working directory with every non-alphanumeric character replaced by a dash.
   */
  const guess = join(homedir(), '.claude', 'projects', s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
  return existsSync(guess) ? id : null
}

/**
 * Cards that have mail and have not been told about it yet, by card id, with a count.
 *
 * Delivery already worked in both directions: a card runs the send shim, the server checks the
 * wire, and the text is appended to the other card's INBOX.md. What did not exist was the other
 * half. Nothing ever told the receiving card that anything had arrived, `readInbox` was never
 * called from anywhere, and the only thing that reaches a session's context is the SessionStart
 * hook. So a message to a card that was already running was a file nobody read: the sender was
 * told "delivered", the wire pulsed on the board, and the recipient never heard it.
 *
 * The owner's rule for fixing it is that a card may be woken, but he may not be interrupted. So
 * this never touches the dock, the focus or anything he is typing into; it writes one line into
 * the card's own process, the same way that card's own operator would.
 */
const mailWaiting = new Map<string, number>()

/**
 * How many times this has tried to start each card for mail, and when it may try again.
 *
 * It was a plain set: one attempt, ever, and a card that failed to start was never tried again for
 * the rest of the run. That is too unforgiving for the case it actually meets. A card is most
 * likely to refuse a start in the seconds around a restart, which is exactly when mail is most
 * likely to be sent to it, so the single attempt was regularly spent on the one moment guaranteed
 * to fail and the card then sat with unread mail forever.
 *
 * A few tries on a widening delay instead. Bounded, because a card that has refused four times over
 * a minute is broken rather than busy, and hammering it helps nobody. The mail is never lost either
 * way: it is in the inbox, and the card reads it whenever it next opens.
 */
const wakeAttempted = new Map<string, { tries: number; nextAt: number }>()

/** Four tries, roughly two seconds apart and doubling, so the last is about half a minute out. */
const WAKE_TRIES = 4
const WAKE_BACKOFF_MS = 2000

/**
 * When each card's terminal last produced a byte.
 *
 * Used to tell a CLI that has finished drawing from one that is still starting up. A fixed delay
 * would be a guess about how long Claude takes to boot on this machine today; silence after output
 * is the thing actually being waited for.
 */
const lastByteAt = new Map<string, number>()

/**
 * When each card's process was actually spawned.
 *
 * Kept because `statusSince` is not this, and using it as though it were is a mistake worth writing
 * down rather than quietly correcting. It is the time of the LAST STATUS CHANGE, so it moves every
 * time a card goes from idle to working and back. Anything asking "has this card printed since it
 * launched" against that number is really asking "has it printed since it last changed status",
 * which for a card that went quiet and was then marked busy is false while the card is perfectly
 * ready. Measured: it cost `test-work-cap.mjs` one check, a message reported as filed and mid-turn
 * when the card was up and idle.
 */
const spawnedAt = new Map<string, number>()

/**
 * Files a card is currently working on, so a second card is told rather than colliding.
 *
 * Keyed by lowercased path with forward slashes, because the same file arrives spelled several ways
 * from a Windows tool call and a flag that misses half of them is worse than none: it would let two
 * cards through while reporting that it was guarding the file.
 */
const fileClaims = new Map<string, { cardId: string; title: string; at: number }>()

/**
 * How long a flag stands without being renewed.
 *
 * Every write refreshes it, so a card actively working a file keeps it. Fifteen minutes is long
 * enough to cover a card thinking between edits and short enough that a card which wandered off
 * does not hold a file until the server restarts.
 */
const CLAIM_TTL_MS = 15 * 60 * 1000

/** Let go of every file a card was holding. Called when its process ends, for any reason. */
function releaseClaims(cardId: string): void {
  for (const [key, held] of fileClaims) if (held.cardId === cardId) fileClaims.delete(key)
}

/**
 * How long a launched CLI has to say anything before Garden stops believing in it.
 *
 * Generous, because a cold Claude start on a large project is not instant and calling a slow start
 * a failure would be its own kind of lie. What is being waited for is the first hook of any kind,
 * which arrives as soon as the CLI is really running.
 */
/*
 * Raised from 30 seconds after a real incident tonight: the Orchestrator (0.5 project, a long
 * `--resume` conversation) was watched directly. It came up, drew its prompt, and was genuinely
 * running two real subagents on real work — then this watchdog killed it anyway, because its first
 * hook event still had not arrived. The CLI was not stuck; the grace period was just short for a
 * heavy resumed conversation on a machine already busy reviving fourteen other cards. Three
 * restarts in a row lost the same handful of cards (all the heaviest ones, always the same set),
 * which is a card that needs longer, not a card that is broken.
 */
const LAUNCH_GRACE_MS = 60_000

/** Cards whose CLI never reported in, so the exit handler can call it a failure and not a stop. */
const launchFailed = new Set<string>()

/**
 * Watch a launch actually take.
 *
 * A card runs its CLI inside a shell, and the shell stays up when the CLI does not. So when the
 * account shim refused to launch in this folder, the process table showed a live pid, Garden called
 * the card idle, and the board displayed a perfectly ordinary agent card with no agent behind it.
 * The owner found it by typing into the card and getting a PowerShell prompt.
 *
 * The proof that a CLI is really running is its first hook event, which Garden already receives for
 * every card it launches. No event inside the grace period means the launch did not take, whatever
 * the pid says. The shell is then ended rather than left sitting there, because a card that reads
 * "off" while an orphan shell holds its slot cannot be turned on again: `session.start` returns
 * early for anything already live, so the button would do nothing.
 *
 * Only Claude cards. A shell card has no CLI to report in and is exactly what it appears to be.
 */
function watchLaunch(id: string, at: number, pid: number | null): void {
  setTimeout(() => {
    const cur = store.getSession(id)
    if (!cur || !ptys.isLive(id)) return
    /*
     * The process this timer was set for, and not whatever is running now.
     *
     * The timer outlives the launch that armed it. A card started, stopped and started again inside
     * the grace period left the first timer still pending, and it would then judge the second
     * process by the first one's silence and kill a launch that was seconds old and perfectly
     * healthy. The pid recorded at spawn is what says whether this is still the same run.
     */
    if (pid === null || cur.pid !== pid) return
    /*
     * Asked as a yes or no against the newest rows, never through a page of events. The page
     * `listEvents` used to return was the OLDEST rows under its cap, so a card with more history
     * than the cap never showed this watchdog its fresh SessionStart, and fifteen of the owner's
     * cards were ended sixty seconds after every launch, mid-turn, with "Resume this session" as
     * the last thing on screen. Found 2026-09-05; `hasEventSince` is one indexed lookup.
     */
    if (store.hasEventSince(id, at)) return

    /*
     * Before calling it a failed launch, check that hooks are reaching Garden at all.
     *
     * Silence has two causes and they need opposite treatment. If the CLI never started, killing
     * the leftover shell is right. If the hook path itself is broken, then every card is silent,
     * the CLI is running perfectly well, and killing it would destroy the owner's live work to
     * report a problem that is Garden's own. This cannot tell those apart from one card, so it
     * asks whether anything at all has reported in recently. Nothing from anyone means Garden is
     * the one that is deaf, and in that case it says so in the log and leaves the card alone.
     *
     * Erring this way costs a card that reads idle when its CLI never launched, which is the bug
     * this function exists to fix. Erring the other way costs a working session, which is worse.
     */
    const heardFromAnyone = store.hasEventSince(null, at - LAUNCH_GRACE_MS, id)
    if (!heardFromAnyone) {
      console.error(
        `[garden] "${cur.title}" reported nothing, and neither has any other card. Leaving it alone: ` +
          'this looks like Garden not receiving hooks rather than a launch that failed.',
      )
      return
    }

    // The last few lines it printed, stripped of escapes, so the reason is in the log rather than
    // only in a terminal the owner has to think to open.
    const tail = ptys
      .scrollback(id)
      .data.replace(/\[[0-9;?]*[A-Za-z]/g, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' | ')
      .slice(0, 300)

    launchFailed.add(id)
    console.error(`[garden] "${cur.title}" never reported in after launch. Last output: ${tail || '(nothing)'}`)
    ptys.kill(id)
  }, LAUNCH_GRACE_MS).unref()
}

/**
 * Tell a card it has mail, now rather than later.
 *
 * Waiting for the card to finish what it is doing was the obvious design and it is the wrong one.
 * A message can be the thing that changes the work: stop, do this instead, that branch is dead. A
 * card that only hears about it after finishing has already spent the turn the message was sent to
 * redirect. So the line goes in as soon as the process exists, and it lands in the card's own queue
 * to be picked up at its next turn boundary rather than being held here.
 *
 * The one state still worth waiting out is `starting`, where there is a process but no prompt drawn
 * yet, so a line written into it is typed at nothing. That resolves in seconds and the sweep below
 * picks it up.
 */
/**
 * What actually became of a wake-up, in the sender's terms.
 *
 * `typed` is the only one that means the card has been told on screen. `starting` means a process
 * is coming up and the brief will carry the message. `queued` means the card is live but busy, and
 * the sweep will type as soon as it goes quiet. `filed` means the card is closed or has no process
 * to start, so the message is in its inbox and will be read whenever it next opens.
 *
 * The distinction exists because all four used to be reported as "delivered". A card the owner had
 * put down, a card that had crashed, and a card that read the message and replied were the same
 * sentence in SENT.md, which made the record worthless exactly when something had gone wrong.
 */
type WakeOutcome = 'typed' | 'starting' | 'queued' | 'filed'

/** The short form that goes beside the entry in the sender's own SENT.md. */
const SENT_NOTE: Record<WakeOutcome, string> = {
  typed: 'the card was told on screen',
  starting: 'the card was started for it',
  queued: 'the card is busy and will be told when it goes quiet',
  filed: 'filed in its inbox, nothing is reading it',
}

/**
 * What the sending agent is told, which has to be the truth rather than the word "delivered".
 *
 * An agent reads this answer and decides what to do next, so the difference between "it has been
 * told" and "it is not running" is the difference between waiting for a reply that is coming and
 * waiting for one that is not.
 */
const ANSWER_FOR: Record<WakeOutcome, (title: string) => string> = {
  typed: (t) => `delivered to ${t}, and it has been told on screen.`,
  starting: (t) =>
    `filed for ${t} and the card is starting. It reads its inbox as part of coming up, so expect ` +
    'a reply once it is on its feet rather than immediately.',
  queued: (t) =>
    `filed for ${t}. It is mid-turn, so it will be told as soon as it goes quiet rather than being ` +
    'interrupted.',
  filed: (t) =>
    `filed in ${t}'s inbox, but nothing is reading it: the card has no process running and could ` +
    'not be started. It will see this when it is next turned on. If it is needed now, start the ' +
    'card from the board.',
}

/**
 * How long after the text the Enter follows.
 *
 * Sixty milliseconds because Claude's prompt reads a burst ending in a newline as pasted text and
 * submits nothing, so the two have to arrive as two events. The environment variable exists for one
 * reason: the guard below can then be watched rather than raced. A test that has to restart a card
 * inside sixty milliseconds is a test that passes or fails on scheduling, and this board has already
 * shipped one assertion that passed for the wrong reason. Unset is exactly today's behaviour.
 */
const INPUT_DELAY_MS = Number(process.env.GARDEN_INPUT_DELAY_MS) || 60

/**
 * Type this into a card a moment from now, unless the card has been relaunched meanwhile.
 *
 * Every automatic input Garden sends arrives in two pieces, the text and then the Enter sixty
 * milliseconds later, because Claude's prompt reads a single burst ending in a newline as pasted
 * text and submits nothing. That gap is small and it is real, and a restart inside it puts the
 * Enter into a process that never saw the text: a keystroke nobody sent, in a conversation nobody
 * chose. The same hole is wider for anything scheduled further out.
 *
 * The guard is the generation rather than a timer handle. Handles live in whichever code path
 * scheduled them, and a restart is exactly the moment that path is not looking; the generation is
 * on the row, so a delayed action can ask the store whether the card it was meant for is still the
 * card that is there. A drop is recorded rather than silent, because an input that vanished with no
 * trace is indistinguishable from one that was typed and ignored.
 *
 * Nothing here restarts anything. It is the guard the stage that does will need, and it is worth
 * having on its own: the restart button and a card that exits and is started again both bump the
 * generation today.
 */
function writeLater(sessionId: string, generation: number, text: string, ms: number = INPUT_DELAY_MS): void {
  setTimeout(() => {
    const now = store.getSession(sessionId)
    if (!now || now.generation !== generation) {
      const event = {
        id: randomUUID(),
        sessionId,
        ts: Date.now(),
        type: 'InputDropped',
        provenance: 'structured' as const,
        payload: {
          reason: 'the card was relaunched between scheduling this input and sending it',
          scheduledUnder: generation,
          nowAt: now?.generation ?? null,
          // The text itself, because a dropped Enter and a dropped sentence are different losses
          // and the owner has to be able to tell which one happened.
          text,
        },
      }
      store.insertEvent(event)
      broadcast({ t: 'event', event })
      return
    }
    ptys.write(sessionId, text)
  }, ms).unref?.()
}

function wakeForMail(sessionId: string): WakeOutcome {
  mailWaiting.set(sessionId, (mailWaiting.get(sessionId) ?? 0) + 1)
  return flushMailWake(sessionId)
}

function flushMailWake(sessionId: string): WakeOutcome {
  const waiting = mailWaiting.get(sessionId)
  if (!waiting) return 'filed'
  const s = store.getSession(sessionId)
  if (!s) return 'filed'

  /*
   * A closed card stays closed. Mail waits in its inbox for whenever it comes back.
   *
   * Closing is the owner putting a card down. Starting it again because something wrote to it would
   * spend money on an agent he had deliberately taken off the board, and it would show up in two
   * places at once that disagree: under "Running now" because it has a process, and under "Closed
   * cards" because it is closed. The message is not lost; the startup brief carries the inbox when
   * he brings the card back.
   */
  if (s.closedAt !== null) return 'filed'

  /*
   * A card with no process is started, rather than left holding unread mail.
   *
   * The owner's rule is that cards talk to each other without him in the loop, and the first real
   * pair test is what showed the gap: the message reached the other card's file, the sender was
   * told "delivered", and the recipient card sat on the board reading inactive with nothing on it.
   * Delivered to a card that cannot read is not delivered. Starting it is the honest completion of
   * the send, and the message is not typed in here: the SessionStart hook hands over the inbox as
   * part of the card's opening brief, so it arrives the same way its role does.
   *
   * Only a card that owns a process. A subagent card is a record of something that already ran, and
   * starting one would spawn a fresh CLI wearing a finished agent's name.
   */
  if (!ptys.isLive(sessionId)) {
    /*
     * A subagent card is a record of something that already ran, so there is nothing to start and
     * the message can only be filed. A card already coming up will be caught by the sweep.
     */
    if (s.kind !== 'session') return 'filed'
    if (s.status === 'starting') return 'starting'
    /*
     * One start attempt per card, and the mail stays on the waiting list.
     *
     * The launch does deliver this mail, through the brief, so typing at the card once it is up is
     * strictly a second telling. It earns its place by being the only one the owner can see: the
     * brief is injected as hook context and the CLI never echoes it, so a card woken purely by its
     * brief comes up thinking about a message that appears nowhere on the board. The typed line is
     * what puts the exchange in the card's own terminal, which is where he looks.
     *
     * The attempt is tracked separately so a card that refuses to start is not retried on every
     * sweep forever. Its mail still sits in its inbox and is read whenever it next opens.
     */
    const attempt = wakeAttempted.get(sessionId) ?? { tries: 0, nextAt: 0 }
    if (attempt.tries >= WAKE_TRIES) return 'filed'
    if (Date.now() < attempt.nextAt) return 'starting'
    wakeAttempted.set(sessionId, {
      tries: attempt.tries + 1,
      nextAt: Date.now() + WAKE_BACKOFF_MS * 2 ** attempt.tries,
    })
    try {
      broadcast({ t: 'session.updated', session: startSession({ ...s, status: 'starting' }) })
      return 'starting'
    } catch (err) {
      console.error(`[garden] could not wake "${s.title}" for mail:`, (err as Error).message)
      return 'filed'
    }
  }
  if (s.status === 'starting') return 'starting'

  /*
   * Wait for the CLI to be genuinely ready, not merely for the shell to exist.
   *
   * This is what made the whole feature look broken. `startSession` stamps `idle` the instant the
   * shell spawns, so a card woken from cold was typed at about a second and a half later, while
   * Claude was still booting. The text landed in a composer that was not listening yet and the
   * Enter sent sixty milliseconds after it was swallowed, so the notice sat on screen unsubmitted
   * and the card never read its mail. The owner saw exactly that: a boss that started, showed
   * nothing, and answered nobody.
   *
   * Two conditions, and both are observations rather than delays. The first hook event of this run
   * is proof the CLI itself is running, since nothing else posts one. Then the byte stream going
   * quiet is proof it has finished drawing and is waiting on a keystroke. A card that is still busy
   * is left alone and picked up by the next sweep.
   */
  const launchedAt = spawnedAt.get(sessionId) ?? s.statusSince ?? 0
  /*
   * Proof that something is running in there, taken from the one place that cannot lie about it.
   *
   * This used to be "has any event been recorded for this card since it launched", on the reasoning
   * written just above: a hook event is posted by the CLI and by nothing else, so it proves the CLI
   * itself is up rather than merely the shell. The reasoning is wrong, and the counter-example is in
   * this same file. `MailDelivered` is written by Garden, with `sessionId` set to the RECIPIENT, at
   * the moment mail is filed. So delivering the message satisfied the test that decides whether the
   * card is ready to be told about that message. On a card that had never posted a real hook event,
   * the arrival of the mail was the whole of the evidence that it was safe to type.
   *
   * It happened to work, which is why nothing caught it: Claude prints while it boots, so the quiet
   * check underneath usually held the line back anyway. "Usually" is the problem. The failure it
   * would produce is the exact one the paragraph above records as having already cost a day, a
   * notice typed into a composer that is not listening yet and an Enter swallowed after it.
   *
   * So the proof is the byte stream, for every adapter equally. Bytes since launch mean a program
   * is drawing in there, and the quiet gap underneath means it has stopped and is waiting on a key.
   * Neither depends on which CLI it is or on Garden's own bookkeeping, which is what makes this the
   * same answer for a Codex card as for a Claude one.
   */
  const cliUp = (lastByteAt.get(sessionId) ?? 0) >= launchedAt
  if (!cliUp) return 'queued'
  const lastByte = lastByteAt.get(sessionId) ?? 0
  if (Date.now() - lastByte < 1500) return 'queued'

  // It is up, so the one-shot start guard has done its job. Released here rather than on exit so a
  // card that is woken, stopped and written to again can be woken again.
  wakeAttempted.delete(sessionId)
  mailWaiting.delete(sessionId)
  /*
   * Read it now, decide before acting on it.
   *
   * This used to say "read your INBOX.md before you continue: it may change or replace what you
   * are currently doing. Act on it." Three separate pushes toward interruption in one sentence,
   * and the owner caught it: "are they interrupting their own work even if they shouldnt because
   * of a minor spec change?" A card mid-measurement would abandon it for an acknowledgement.
   *
   * Reading still happens immediately, because a card cannot judge a message it has not read and
   * the read is cheap. Only the ACTING is deferred, and the default flipped: finish the step
   * unless the message actually supersedes it.
   *
   * It stops there on purpose. The opposite failure has already cost this board more: a card's
   * warning that the wrong operators had been rebaked sat unread as ordinary content for nineteen
   * hours. Softening the READ as well would buy that back.
   */
  const line =
    waiting === 1
      ? 'A message arrived on one of your wires. Read your INBOX.md now. If it changes or cancels what you are working on, follow it; otherwise finish the step you are on and reply when you reach a stopping point. Do not drop work in progress for a message that did not ask you to.'
      : `${waiting} messages arrived on your wires. Read your INBOX.md now. If they change or cancel what you are working on, follow them; otherwise finish the step you are on and reply when you reach a stopping point. Do not drop work in progress for messages that did not ask you to.`
  /*
   * The text and the Enter go separately, and this is not a style choice. Claude's prompt watches
   * how input arrives and reads a burst ending in a newline as pasted text, so a single write put
   * the line in the composer with a blank line under it and sent nothing at all. The card's own
   * input line learned this the same way.
   */
  if (!ptys.write(sessionId, line)) {
    /*
     * The process went between `isLive` above and this write. Nothing was typed, so the message is
     * left on the waiting list and the card is put back in the queue to be started, rather than
     * being reported as told. This is the race the old silent write hid completely.
     */
    mailWaiting.set(sessionId, waiting)
    wakeAttempted.delete(sessionId)
    return 'filed'
  }
  writeLater(sessionId, s.generation, '\r')
  return 'typed'
}

/*
 * A card that was still launching when mail landed gets it as soon as it has a prompt. A sweep
 * rather than a hook: the status this depends on is written from several places, and a timer that
 * reads the same store they write cannot miss an edge one of those paths forgot to announce.
 */
setInterval(() => {
  for (const id of [...mailWaiting.keys()]) flushMailWake(id)
}, 1500).unref()

/**
 * Tell every window the count moved.
 *
 * The ceiling only used to be sent when it was asked for or changed, so the "4 of 12" beside it went
 * stale the moment a card was created or deleted and stayed stale until something touched the
 * setting. A number that is only sometimes current is worse than no number: it is the board
 * asserting something it has not checked, which is the one thing this app is not allowed to do.
 *
 * Broadcast rather than answered, because the count is a property of the board and not of whoever
 * asked, and two windows disagreeing about how full it is means one of them starts showing refusals
 * it cannot explain.
 */
function announceLimits(projectId: string): void {
  broadcast(limitsMessage(projectId))
}

/** The ceiling and what stands against it right now, in the shape the board draws. */
function limitsMessage(projectId: string): ServerMessage {
  return {
    t: 'limits',
    projectId,
    limits: store.getLimits(projectId),
    /*
     * Subagents travel beside the counts rather than inside `cards`, because the panel draws them
     * differently: a figure with a ceiling and a figure that is only watched are different claims.
     */
    counted: {
      cards: store.countCards(projectId),
      running: store.countRunning(projectId),
      subagents: store.countSubagents(projectId),
    },
  }
}

/** Which count stopped a card being made, and the sentence the asker is told. */
interface Ceiling {
  which: 'running' | 'cards' | 'children' | 'role'
  said: string
}

/**
 * Whether this board has room for one more, or the reason it does not.
 *
 * Three separate counts, because they fail differently. `running` is what costs money and machine:
 * a board can hold thirty cards and only ever have four switched on. `cardsPerProject` is what
 * stops the board becoming unreadable, and is the one that would have refused the thirty-eight.
 * `childrenPerCard` is the first time a parent's own `teamSize` is consulted at all: it was written
 * onto every card at creation and never read, so a manager told to keep two helpers brought up six
 * and nothing said no.
 *
 * Returns null when there is room. Every refusal names the count and the current figure, because
 * "refused" without a number is something the owner has to go and measure himself.
 */
function overCeiling(projectId: string, parent: TerminalSession | null, starting: boolean): Ceiling | null {
  const limits = store.getLimits(projectId)

  const cards = store.countCards(projectId)
  if (cards >= limits.cardsPerProject) {
    return {
      which: 'cards',
      said:
        `This board is at its limit of ${limits.cardsPerProject} cards and holds ${cards}. ` +
        'Delete one, or raise the ceiling from the board.',
    }
  }

  if (starting) {
    const running = store.countRunning(projectId)
    if (running >= limits.running) {
      return {
        which: 'running',
        said:
          `${running} cards are already running and the limit is ${limits.running}. Stop one, ` +
          'create this one switched off, or raise the ceiling from the board.',
      }
    }
  }

  if (parent) {
    // A parent that has set no figure of its own falls back to the board's, rather than to no limit.
    const allowed = parent.teamSize ?? limits.childrenPerCard
    /*
     * Cards on the board that answer to this one. A subagent card is a record of something that
     * already ran, not a helper holding a seat: counting them refused the orchestrator its fifth
     * helper on 2026-09-04 because seven finished subagents from earlier days still stood under
     * it, and the owner raising the board's ceiling changed nothing. The same rule the board's own
     * card count has used since the concurrency cap landed.
     */
    const children = store
      .childSessions(parent.id)
      .filter((c) => c.kind === 'session' && c.closedAt === null).length
    if (children >= allowed) {
      return {
        which: 'children',
        said:
          `"${parent.title}" already has ${children} cards answering to it and is allowed ${allowed}. ` +
          'Give the work to one of those, or raise what that card is allowed.',
      }
    }
  }

  return null
}

/**
 * A card that was not made, recorded where the owner can see it.
 *
 * An attempt that is merely blocked is invisible, and the interesting thing about the runaway was
 * never a single card: it was the shape of the asking. `structured` because every field here was
 * read off the request and the store rather than matched out of prose.
 */
function recordCeilingRefusal(by: string | null, parent: TerminalSession | null, wanted: string, refusal: Ceiling) {
  /*
   * An event belongs to a card, so it is filed against whoever asked, or failing that against the
   * card the new one would have answered to. When it is neither, the owner clicked the menu himself
   * with nothing selected, and the error frame he is already looking at is the record. Inventing a
   * card to hang it on would be worse than not recording it.
   */
  const asker = by ? store.getSession(by) : null
  const on = asker?.id ?? parent?.id ?? null
  if (!on) return

  const event: AgentEvent = {
    id: randomUUID(),
    sessionId: on,
    ts: Date.now(),
    type: 'hire.refused',
    provenance: 'structured',
    payload: {
      by: asker?.title ?? (by ? 'a card that is no longer here' : 'the owner'),
      byId: by,
      wanted,
      which: refusal.which,
      said: refusal.said,
    },
  }
  store.insertEvent(event)
  broadcast({ t: 'event', event })
}

/**
 * Everything a card runs from, on disk, before anything can read it.
 *
 * This used to live inside the ingest dependency literal, which meant it only ran when a hook
 * event arrived from the card's own SessionStart. A card therefore had no CLAUDE.md of its own
 * until it had already started talking, and a session with no instructions of its own reads only
 * the project's and the machine's, which is exactly the "it inherited everything" complaint. It is
 * a plain function now so both creation branches and the launch path can call it.
 *
 * Returns the directory so the caller does not recompute it.
 */
function ensureCardMemory(session: TerminalSession, roots?: string): string | null {
  const project = store.getProject(session.projectId)
  if (!project) return null
  const dir = memoryDirFor(project.name, session.id, session.title)
  ensureMemory(dir)
  // Its own instructions, saying what it is and where it sits, which is the difference between a
  // card on a team and another session in the same project.
  writeCardBrief(
    dir,
    session,
    session.reportsTo ? store.getSession(session.reportsTo)?.title ?? null : null,
    project.name,
    roots,
  )
  /*
   * Make the directory a plugin, so `--plugin-dir` can hand this card its own skills, agent
   * definitions and hooks. Composed in full the first time and left alone after that: see
   * `ensureCardRoots`. Canon: docs/canonical/12-how-a-card-is-hired.md.
   */
  ensureCardRoots(
    dir,
    session,
    {
      hirerDir: session.reportsTo ? cardDirFor(session.reportsTo) : null,
      projectPath: project.path,
    },
    new Date().toISOString().slice(0, 10),
  )
  return dir
}

/**
 * The file a message card and its bound session both append to.
 *
 * In the card's own mail directory, beside INBOX.md and PEERS.md, for three reasons that all point
 * the same way. The card already knows that directory, so it needs no new path handed to it. The
 * territory guard in `garden-hook.mjs` already exempts it, so a card given owned paths can still
 * answer the owner rather than being cut off by a setting meant to protect other people's files.
 * And it is per card, which is what a channel is: this is the owner talking to one card, not a
 * board-wide noticeboard.
 */
function channelPathFor(sessionId: string): string {
  return join(mailDirFor(sessionId), 'NOTES.md')
}

/**
 * Bind a message card to a session, when a wire has just joined the two.
 *
 * Either way round, because a wire has a direction and this does not: the owner drawing from the
 * card to the message box means exactly what drawing it the other way means.
 *
 * A channel that is already bound stays bound. Rebinding on a second wire would move the
 * conversation to another card silently, and the file it was reading would stop being the file it
 * is shown, which is the sort of quiet mismatch this app exists to refuse. Unwiring and rewiring is
 * the way to change it, and that is visible.
 */
function bindChannel(a: string, b: string) {
  const pairs: Array<[string, string]> = [
    [a, b],
    [b, a],
  ]
  for (const [maybeChannel, maybeSession] of pairs) {
    const channel = store.getChannel(maybeChannel)
    const session = store.getSession(maybeSession)
    if (!channel || !session || channel.sessionId) continue
    const path = channelPathFor(session.id)
    if (!existsSync(path)) {
      writeFileSync(
        path,
        `# Notes between the owner and "${session.title}"\n\n` +
          'Only what the two of you say to each other, and nothing else reads it. Append your ' +
          'replies to the end of this file with your ordinary file writing tools.\n',
        'utf8',
      )
    }
    const bound: Channel = { ...channel, sessionId: session.id, path }
    store.upsertChannel(bound)
    broadcast({ t: 'channel.updated', channel: bound })
    pushChannelText(bound)
  }
}

/** Read the file and hand it to every window, which is the only way a channel's text ever moves. */
function pushChannelText(channel: Channel) {
  if (!channel.path) return
  let text = ''
  let at = 0
  try {
    text = readFileSync(channel.path, 'utf8')
    at = statSync(channel.path).mtimeMs
  } catch {
    // Not written yet, which is the ordinary state of a channel nobody has said anything in.
  }
  channelSeen.set(channel.id, at)
  broadcast({ t: 'channel.text', channelId: channel.id, text, at })
}

/**
 * The mtime each channel's file was last read at, so a change can be noticed without a watcher.
 *
 * Polled rather than watched on purpose. `fs.watch` on Windows reports a directory change without
 * saying which file, fires twice for one save often enough to matter, and misses a write made by a
 * process that replaces the file rather than appending to it, which is what a file writing tool
 * usually does. A channel holds a handful of exchanges, so a stat once a second costs nothing and
 * cannot miss one.
 */
const channelSeen = new Map<string, number>()

/**
 * The day a turn belongs to, and the label that day is drawn under.
 *
 * By day because a turn carries nothing else to group it by. A work record has who asked, what was
 * asked, when it started and which files it touched, and no identifier that ties several turns
 * together into a piece of work. The owner asked for "one pill per task"; a task is not a thing this
 * data knows about, and inventing one by matching prose would be the guessing this app exists to
 * refuse. A day is real, it is countable, and for a card that has been working for a week it is the
 * division he would draw himself.
 *
 * The key sorts, the label reads. Keeping them apart means the pills can be ordered newest first
 * without parsing what is written on them.
 */
function dayOf(at: number): { key: string; label: string } {
  const d = new Date(at)
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = new Date()
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const yesterday = new Date(today.getTime() - 86_400_000)
  const label = sameDay(d, today)
    ? 'Today'
    : sameDay(d, yesterday)
      ? 'Yesterday'
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return { key, label }
}

/** Every day this card has turns for, newest first, with what is currently on the board. */
function historyGroupsFor(session: TerminalSession): {
  groups: Array<{ group: string; label: string; count: number; latest: number }>
  open: string[]
} {
  const byDay = new Map<string, { label: string; count: number; latest: number }>()
  /*
   * Counted with the same rule that decides what gets written, not with a count of every record.
   *
   * A turn that called no tool and touched no file is dropped by `writeHistory` as noise, so
   * counting records put "Today 3" on a pill that opened a single card. The pill has to promise what
   * it will deliver.
   */
  for (const r of store.listWork(session.id).filter(hasSubstance)) {
    const { key, label } = dayOf(r.startedAt)
    const seen = byDay.get(key)
    if (seen) {
      seen.count += 1
      seen.latest = Math.max(seen.latest, r.startedAt)
    } else {
      byDay.set(key, { label, count: 1, latest: r.startedAt })
    }
  }
  const groups = [...byDay.entries()]
    .map(([group, v]) => ({ group, ...v }))
    .sort((a, b) => b.latest - a.latest)

  /*
   * A card with no work records but a transcript gets one group of its own.
   *
   * Work records are built from the hook events of a session Garden launched, and a spawned agent is
   * not one: it runs inside its parent, so it has none, and its history is read from its transcript
   * instead. Grouping by day would leave exactly those cards with nothing to open, which is the case
   * the original handler went out of its way to support. One group, named for what it is.
   */
  if (groups.length === 0 && session.kind !== 'session' && session.transcriptPath) {
    groups.push({ group: 'conversation', label: 'Conversation', count: 0, latest: session.statusSince ?? 0 })
  }

  /*
   * "Reports" is a pill too, for an orchestrator, offering what came home from finished tasks the
   * same way a day offers its turns: nothing drawn until it is opened by hand. This used to draw
   * itself the moment a task finished, no click involved, which the owner asked to stop: "i dont
   * want it to auto open history." Pinned first, ahead of the days, since it is the thing an
   * orchestrator's owner is most often checking for.
   */
  if (session.roleClass === 'orchestrator') {
    const reports = reportTaskIdsFor(session)
    if (reports.length > 0) {
      groups.unshift({ group: 'reports', label: 'Reports', count: reports.length, latest: reports[0]!.latest })
    }
  }

  const open = [
    ...new Set(store.listWebDocs(session.id, 'history').map((d) => d.group).filter((g): g is string => !!g)),
  ]
  return { groups, open }
}

function sendHistoryGroups(ws: WebSocket, session: TerminalSession) {
  const { groups, open } = historyGroupsFor(session)
  send(ws, { t: 'history.groups', sessionId: session.id, groups, open })
}

/** Where another card's roots live, for snapshotting out of the card that is doing the hiring. */
function cardDirFor(sessionId: string): string | null {
  const s = store.getSession(sessionId)
  if (!s) return null
  const p = store.getProject(s.projectId)
  return p ? memoryDirFor(p.name, s.id, s.title) : null
}

function startSession(s: TerminalSession): TerminalSession {
  const project = store.getProject(s.projectId)
  if (!project) throw new Error('unknown project')
  // The project owns the account, not the session. Enforced here so a session can never run on
  // the wrong one, which for two separately billed accounts is a money question, not a nicety.
  const boundId = store.getProjectProfile(project.id, s.adapterId)
  const profile = boundId ? store.getProfile(boundId) ?? null : null

  // Every card gets its own notes directory, keyed by the card rather than the process, so what
  // a role learns survives being turned off and on. The path is handed to the session as an
  // environment variable, which is how the agent finds it without Garden brokering anything.
  const memoryDir = ensureCardMemory(s) ?? memoryDirFor(project.name, s.id, s.title)

  // The shared root and this role's, seeded if they are not there yet and never overwritten.
  const rootsFor = ensureRoots(s.roleClass ?? null)

  const resumeId = resumeIdFor(s)
  /*
   * A conversation another live process is already in cannot be joined, only branched.
   *
   * Checked here rather than inside `resumeIdFor` because the answer is not "resume or do not". It
   * is "resume, or resume from a copy", and losing the history was never one of the options.
   */
  const forkResume = resumeId ? conversationHeldElsewhere(resumeId, configDirFor(s)) : false
  if (forkResume) {
    console.log(
      `[garden] ${s.title}: conversation ${resumeId} is open in another live process, so this card ` +
        'branches a copy of it rather than starting empty',
    )
  }
  /*
   * Which launch of this card this is, counted from the row rather than from anything in memory.
   *
   * Everything Garden schedules to happen to a card a moment from now carries this number, and a
   * delayed action whose number is no longer the card's is dropped. The case it exists for is an
   * Enter queued sixty milliseconds before a restart, which without this lands in whatever process
   * is there when the timer fires: a keystroke nobody sent, in a conversation nobody chose.
   * Cancelling by timer handle cannot cover it, because the handles live in whichever path
   * scheduled them and a restart is exactly when that path is not looking.
   */
  const generation = (Number.isInteger(s.generation) ? s.generation : 0) + 1

  const adapter = getAdapter(s.adapterId)
  const spec = adapter.launch(project.path, profile, {
    GARDEN_MEMORY_DIR: memoryDir,
    GARDEN_CARD: s.title,
    GARDEN_PROJECT: project.name,
    /*
     * Handed to the session as well as kept on the row, so anything the card itself schedules can
     * say which launch it belonged to. Nothing reads it back yet; it is here because a value that
     * appears later is a value nothing older can be compared against.
     */
    GARDEN_GENERATION: String(generation),
    /*
     * The two roots above this card's own: the shared one and its role's.
     *
     * Paths rather than contents, because the hook reads them off disk at the moment the session
     * starts. That matters when it matters most, which is a card restarting while the server is
     * restarting too, and it means editing a role's file changes what every card of that role is
     * told next time it starts without anything having to be rebuilt or redeployed.
     */
    GARDEN_ROOTS_ALL: rootsFor.shared,
    ...(rootsFor.role ? { GARDEN_ROOTS_ROLE: rootsFor.role } : {}),
    /*
     * The thread that ties every hook this CLI fires back to this card. It is inherited by the
     * shell, by the CLI, and by each hook process the CLI runs, which is why attribution never
     * has to be guessed from a pid or a working directory. Two cards open on the same folder is
     * the normal case on this board, and nothing matched on cwd could tell them apart.
     */
    GARDEN_SESSION_ID: s.id,
    GARDEN_PORT: String(port),
    /*
     * A fresh value for this launch, and the only thing in here that a descendant cannot fake by
     * being handed it.
     *
     * Every other GARDEN_ variable is inherited all the way down, which is the point: a hook five
     * processes deep still knows which card it belongs to. It is also the hole. A `claude` started
     * from inside a card inherits the card's id, its title and its mailbox, so it was briefed as
     * that card and its events were filed under it. No environment variable can separate them,
     * because a descendant inherits whatever is put in one.
     *
     * What a descendant cannot be is first. The card's own CLI is necessarily the first process of
     * a launch, since anything nested is started from it, so the hook claims this value on the first
     * SessionStart it sees and treats a later, different session presenting the same value as
     * something the card started. New on every spawn rather than the card id, which is stable for
     * the card's life: a restarted card would have found its own stale claim and decided it was a
     * descendant of itself.
     */
    GARDEN_LAUNCH: randomUUID(),
    /*
     * The card's own conversation, when it still has one. Absent rather than empty when there is
     * nothing to resume, so the adapter adds no flag at all and the card starts fresh.
     */
    ...(resumeId ? { GARDEN_RESUME: resumeId } : {}),
    /*
     * Branch rather than continue, because continuing is not on offer: the CLI refuses `--resume`
     * outright when another live process holds the conversation, and the card lands on a shell
     * prompt with nothing in it. A branch keeps every turn up to this moment, which is the thing
     * worth keeping, and the CLI gives the copy a new id that its own hooks then report back, so
     * the card's `claudeSessionId` follows the conversation it is actually in.
     */
    ...(forkResume ? { GARDEN_RESUME_FORK: '1' } : {}),
    /*
     * The files this card is responsible for, so its own hook can refuse a write outside them.
     *
     * This travels in the environment rather than in the settings file because the settings file
     * cannot express it. The CLI evaluates deny before allow and a deny rule cannot carry
     * exceptions, so "edit only these paths" has no rule form, and `Write(...)` path rules are
     * accepted and then never consulted. Writing one would have given the card a restriction the
     * CLI silently ignores, which is worse than no restriction at all.
     *
     * Absent when the card owns everything, so a hook with nothing to enforce does not have to
     * distinguish "no limit" from "an empty list", which mean opposite things.
     */
    ...(s.ownedPaths?.length ? { GARDEN_OWNED_PATHS: JSON.stringify(s.ownedPaths) } : {}),
    /*
     * Where this session's wires deliver. Handed over the same way the notes directory is, so an
     * agent can find who it is connected to without Garden brokering anything or injecting
     * anything into its prompt.
     */
    GARDEN_MAIL_DIR: mailDirFor(s.id),
    /*
     * How this session hands work along a wire.
     *
     * Without it, a wire permitted a message that nothing could send: deliveries arrive over the
     * WebSocket, which only the owner's hands reach, so a manager had no way to give its worker
     * anything and the chain was drawn but could not be walked.
     */
    GARDEN_SEND: sendShimPath(),
    /*
     * How this session asks for a card to exist. See hireShimPath: every card gets it, because for
     * most of them the verb is "ask" rather than "create".
     */
    GARDEN_HIRE: hireShimPath(),
    /*
     * How this session reads and changes a task contract. See taskShimPath.
     */
    GARDEN_TASK: taskShimPath(),
    /*
     * This card's secret for as long as this server is up, known to the server only as a hash.
     *
     * The three shims send it as a bearer header, and the server resolves the sender from it rather
     * than from the `from` field in the body. That field was filled honestly by the shims and
     * believed unconditionally by the server, so any card that could run node could send as any
     * other card, and every wire check and every guard was then applied to the forged sender.
     *
     * It is inherited by descendants like everything else here, and canon 20 says so rather than
     * claiming otherwise: this makes a card's identity forgeable only by something running inside
     * that card, which is a much smaller hole than the one it closes.
     */
    GARDEN_SESSION_TOKEN: tokenFor(s.id),
    /*
     * What this card is, so its own hook can enforce the parts of its role that the CLI's deny list
     * cannot express. Only `verifier` reads it today: that role keeps Write, Edit and Bash from the
     * CLI, because a reviewer denied them cannot write a report or run the shim that sends it, and
     * loses them at the hook in the two shapes it actually needs.
     */
    ...(s.roleClass ? { GARDEN_ROLE: s.roleClass } : {}),
    /*
     * This card's own settings file, carrying its hooks and whatever it is not allowed to do.
     * Written at launch because that is when the CLI reads permissions, so changing a card's
     * powers takes effect the next time it is turned on rather than mid-turn.
     */
    GARDEN_SESSION_SETTINGS: installSessionHooks(port, s.id, {
      canSpawnAgents: s.canSpawnAgents,
      canUseTeams: s.canUseTeams,
      teamSize: s.teamSize,
      model: s.modelChoice,
      effort: s.effortChoice,
      roleClass: s.roleClass,
    }),
  })
  /*
   * The brief goes on disk before the process starts, not the first time a setting is touched.
   *
   * POWERS.md and PEERS.md were only written from the role handler, so a card the owner never
   * edited had neither, and a session launched with nothing to read about what it was for or who
   * it may talk to. The files are what make a role more than a label on a card.
   *
   * The row goes in first because `refreshMail` looks the card up in the store and returns silently
   * when it is not there yet. A card created with `start: true` came straight here with no row, so
   * it launched with no PEERS.md at all: wired on the board, and told by its own files that it had
   * nobody to talk to. The upsert below at the end of the launch still stamps the pid and status.
   */
  store.upsertSession({ ...s, generation })
  writePowers(s, s.reportsTo ? store.getSession(s.reportsTo)?.title ?? null : null)
  refreshMail(s.id)

  const pid = ptys.spawn(s.id, spec, project.path)
  // Stamped here, which is the only moment that means "this process began". Everything downstream
  // that asks whether a card has drawn anything since it started is asking about this instant.
  spawnedAt.set(s.id, Date.now())

  /*
   * Launched, not working. The process is alive and that is all this knows: the CLI itself says
   * whether it is busy, idle or waiting on the owner, and until it does, claiming "working"
   * would be the exact kind of painted-on green this app exists to refuse.
   */
  const updated: TerminalSession = {
    ...s,
    generation,
    pid,
    status: 'idle',
    waitingFor: null,
    statusSince: Date.now(),
    exitedAt: null,
    exitCode: null,
    /*
     * What this process was actually told it is, recorded at the only moment it is true.
     *
     * The settings file and POWERS.md were both written from `s.roleClass` a few lines above, and
     * that is the last time the two are guaranteed to agree: the owner can change the role a second
     * later and nothing reaches the running session, which was briefed once and never re-reads. So
     * the launch stamps what it handed over, and the card can then show a newer choice as pending
     * rather than asserting a role the agent inside has never heard of.
     */
    roleClassRunning: s.roleClass,
  }
  store.upsertSession(updated)
  if (s.adapterId === 'claude') watchLaunch(s.id, updated.statusSince ?? Date.now(), pid)
  return updated
}

/**
 * Make a card, from the one place that decides whether a card may be made.
 *
 * Lifted out of the message handler so the hiring endpoint runs exactly this and not a copy. Two
 * copies of card creation is the same arrangement that once had Garden telling managers in writing
 * about a denial it had not written, and it would drift here faster: the ceiling, the role check,
 * the reporting wire and the roots all live in this function and all four would have to be
 * remembered twice.
 *
 * Answers on the socket the way it always did. The endpoint passes a small capturing stand-in, so a
 * refusal reaches an agent as text on stderr and reaches the renderer as an error frame, without
 * this function knowing or caring which it is talking to.
 *
 * Returns the card, or null when it refused, having already said why.
 */
function createSession(
  msg: Extract<ClientMessage, { t: 'session.create' }>,
  ws: WebSocket,
  roots?: string,
): TerminalSession | null {
      const project = store.getProject(msg.projectId)
      if (!project) { fail(ws, 'unknown project', msg.t); return null }
      if (!isAdapterId(msg.adapterId)) { fail(ws, 'unknown adapter', msg.t); return null }

      /*
       * The grid slot is a starting guess, not a placement.
       *
       * It counts how many cards a project has and picks the next cell, which says nothing about
       * whether that cell is free: a card moved by hand, a web unfolded, or a card deleted from
       * the middle all leave the count and the board disagreeing. Every new card goes through the
       * same free-space search a dropped card does, so nothing can spawn on top of anything.
       */
      /*
       * Who this card answers to, checked before anything is created.
       *
       * Only a session on the same board, and never a card that already answers to this one, which
       * cannot happen yet on a card that does not exist but keeps the rule in one shape.
       */
      const parent = msg.reportsTo ? store.getSession(msg.reportsTo) : null
      const reportsTo = parent && parent.projectId === project.id && parent.kind === 'session' ? parent.id : null
      if (msg.reportsTo && !reportsTo) { fail(ws, 'that card cannot be answered to', msg.t); return null }

      /*
       * The ceiling, before a position is chosen and before anything is written.
       *
       * Here rather than only at the hiring endpoint on purpose. A scratch script sending raw
       * `session.create` over the socket, an agent that went around the shim, and the owner's own
       * right-click all arrive at this line, and a ceiling with an exception for whoever is in the
       * biggest hurry is not a ceiling. Refusing before `nearestFree` runs also means a refused
       * card never takes a position, so nothing on the board moves because of a create that failed.
       */
      const refusal = overCeiling(project.id, parent ?? null, msg.start !== false)
      if (refusal) {
        recordCeilingRefusal(msg.by ?? null, parent ?? null, msg.title ?? 'a card', refusal)
        fail(ws, refusal.said, msg.t)
        return null
      }

      /*
       * Who asked, when it was not the owner's own hands.
       *
       * Set by the hiring endpoint from `GARDEN_SESSION_ID` and never read off a request body, so a
       * card cannot name itself something it is not. Absent means the renderer, which is the owner,
       * and the owner is above the funnel. Present has to be a live card whose role may create.
       */
      if (msg.by) {
        const asker = store.getSession(msg.by)
        const may = asker && asker.closedAt === null && asker.roleClass && ROLE_POWERS[asker.roleClass]?.creates
        if (!may) {
          recordCeilingRefusal(msg.by, parent ?? null, msg.title ?? 'a card', {
            which: 'role',
            said: 'only the orchestrator creates cards',
          })
          fail(
            ws,
            'Only the orchestrator may create a card. Ask it with GARDEN_HIRE and it will answer ' +
              'along the wire.',
            msg.t,
          )
          return null
        }
      }

      /*
       * Where he pointed, if he pointed. A card made from a right-click belongs where the menu was
       * opened; anything else lands wherever the automatic placement finds room. Either way it is
       * then nudged clear, since the rule that cards do not cover each other has no exceptions.
       */
      const asked =
        Number.isFinite(msg.x) && Number.isFinite(msg.y)
          ? { x: Number(msg.x), y: Number(msg.y) }
          : nextPosition(project.id)
      const pos = nearestFree(project.id, '', { x: asked.x, y: asked.y, w: CARD_W, h: CARD_H })
      const adapter = getAdapter(msg.adapterId)
      const count = store.listSessions().filter((s) => s.projectId === project.id).length + 1

      const draft: TerminalSession = {
        id: randomUUID(),
        projectId: project.id,
        profileId: store.getProjectProfile(project.id, msg.adapterId),
        adapterId: msg.adapterId,
        kind: 'session',
        title: msg.title?.trim() || `${adapter.label} ${count}`,
        cwd: project.path,
        pid: null,
        status: 'starting',
        waitingFor: null,
        statusSince: Date.now(),
        agentId: null,
        /*
         * The card that made this one, recorded at the moment it is made.
         *
         * Hard-coded null while `reportsTo` below was handed the same fact, so a card hired
         * through the board had a reporting line and no recorded maker, and childSessions(),
         * which queries parentId, could not find one of them. Nothing is inferred here: this is
         * the value this handler was already given and has already validated against the board.
         */
        parentId: reportsTo,
        transcriptPath: null,
        claudeSessionId: null,
        // On the board, not in the closed list. A card is only closed once the owner closes it.
        closedAt: null,
        // Nothing launched yet, so no role is in effect.
        roleClassRunning: null,
        /*
         * Only paths the renderer sent, trimmed, and only if there are any. An empty list is stored
         * as null rather than as an empty array: null means no limit and an empty array would mean
         * this card may write nowhere, which are opposite things and one of them locks a card out
         * of its own work.
         */
        ownedPaths:
          Array.isArray(msg.ownedPaths) && msg.ownedPaths.length
            ? msg.ownedPaths.map((p) => String(p).trim()).filter(Boolean).slice(0, 40)
            : null,
        // Nothing has been launched yet. The first start writes 1, and every delayed input carries
        // the number it was scheduled under.
        generation: 0,
        model: null,
        permissionMode: null,
        managed: true,
        x: pos.x,
        y: pos.y,
        width: CARD_W,
        height: CARD_H,
        renderState: 'preview',
        pinned: false,
        manualPos: false,
        collapsed: false,
        color: null,
        role: null,
        size: 'normal',
        contextUsed: null,
        tokensUsed: null,
        contextSource: null,
        // A new card is a worker until the owner says otherwise, but nothing is taken away from
        // it: both permissions start allowed so a fresh session behaves exactly as it always did.
        /*
         * The role is set here, before the session is launched, because that is the only moment it
         * can take effect. Everything downstream reads it: the deny list in the settings file, the
         * brief written to disk, and what the card says it is for.
         */
        roleClass: msg.roleClass && ROLE_POWERS[msg.roleClass] ? msg.roleClass : null,
        canSpawnAgents: msg.roleClass ? (ROLE_POWERS[msg.roleClass]?.hires ?? true) : true,
        canUseTeams: true,
        effort: null,
        modelChoice: typeof msg.modelChoice === 'string' ? msg.modelChoice : null,
        effortChoice: typeof msg.effortChoice === 'string' ? msg.effortChoice : null,
        teamSize:
          typeof msg.teamSize === 'number' && msg.teamSize >= 0 && msg.teamSize <= 20
            ? Math.round(msg.teamSize)
            : null,
        // A card the owner started himself answers to him, which is what a null parent means.
        reportsTo: reportsTo,
      baseWidth: null,
      baseHeight: null,
        fontSize: null,
        // Not chosen yet, so the card opens on whatever its kind suits: a session on its terminal,
        // an agent on its conversation. See TerminalSession.bodyView.
        bodyView: null,
        createdAt: Date.now(),
        exitedAt: null,
        exitCode: null,
      }

      /*
       * The token belongs to the card from the moment the card exists, whether or not it is about
       * to start. A blueprint card created switched off can then be given work by anything the owner
       * hands its token to, and `session.token` has an answer for it before it has ever run.
       */
      tokenFor(draft.id)

      try {
        /*
         * The wire before the launch, so the card's own PEERS.md names its boss from the first
         * turn rather than after the next time something touches it.
         */
        if (reportsTo) {
          const wire: Wire = {
            id: randomUUID(),
            projectId: project.id,
            sourceId: reportsTo,
            targetId: draft.id,
            label: 'reports to',
            kind: 'manual',
            bidirectional: true,
            createdAt: Date.now(),
          }
          store.upsertWire(wire)
          broadcast({ t: 'wire.added', wire })
        }

        /*
         * Laid out but not spending anything.
         *
         * A blueprint of six cards is worth drawing before any of them costs a token, so a card
         * can be created off. It reads as stopped, which is exactly what it is, and turning it on
         * is the same button every other stopped card uses.
         */
        if (msg.start === false) {
          const off: TerminalSession = { ...draft, status: 'stopped', pid: null }
          store.upsertSession(off)
          // Its brief too, not only its powers. A card laid out now and started days later was
          // reaching its first turn with no CLAUDE.md of its own, because the only thing that wrote
          // one ran on a hook the card had not fired yet.
          ensureCardMemory(off, roots)
          writePowers(off, reportsTo ? store.getSession(reportsTo)?.title ?? null : null)
          refreshMail(off.id)
          if (reportsTo) refreshMail(reportsTo)
          broadcast({ t: 'session.added', session: off })
          announceLimits(project.id)
          return off
        }

        /*
         * The roots go on disk before the process exists, whether or not it is starting now.
         *
         * They were only written in the branch above, the one for a card created switched off, so a
         * card created and started in one call had its creator's brief accepted, validated, and then
         * dropped. `startSession` calls `ensureCardMemory` with no roots, which writes the generated
         * half and leaves the creator's half empty. Now that the shared instruction files no longer
         * reach a card, that brief is the only thing it would have had.
         */
        ensureCardMemory(draft, roots)
        const started = startSession(draft)
        if (reportsTo) refreshMail(reportsTo)
        broadcast({ t: 'session.added', session: started })
        announceLimits(project.id)
        return started
      } catch (err) {
        fail(ws, `could not start session: ${(err as Error).message}`, msg.t)
        return null
      }
}

function handle(ws: WebSocket, msg: ClientMessage) {
  /*
   * Who this connection is, before anything acts on what it asked for.
   *
   * Deliberately the first thing in the function rather than a check inside each case. There are
   * about a hundred message types here and the ones that matter were added over months; a rule that
   * has to be remembered at each new case is a rule that holds until somebody is in a hurry.
   */
  const may = socketMaySend(ws, msg.t)
  if (!may.ok) {
    /*
     * A refusal at this door is recorded the way its HTTP twin is.
     *
     * This gate runs before the op, so a card turned away here never reached `taskCreate` and the
     * refusal it got was never written down, while the same refusal of the same operation arriving
     * over HTTP was. The owner reading the panel would see one door's refusals and not the other's,
     * which is worse than seeing neither: an incomplete record reads as a complete one. Only task
     * operations, because those are the ones the panel accounts for; a guest turned away from
     * `session.create` is a different question and canon 20 does not claim it.
     */
    if (msg.t.startsWith('task.') && msg.t !== 'task.list') {
      const who = identityOf(ws)
      const actor = who.kind === 'card' ? store.getSession(who.cardId) ?? null : null
      const asked = msg as any
      const taskId = String(asked?.taskId ?? asked?.task?.id ?? '').trim() || null
      recordTaskPlaneRefusal(actor, msg.t.slice('task.'.length), taskId, may.reason)
    }
    return fail(ws, may.reason, msg.t)
  }

  switch (msg.t) {
    // Answered and nothing else. The page uses the round trip to tell a live socket from a
    // half-open one, which it cannot do with a protocol-level ping because the browser answers
    // those below JavaScript and never tells the page.
    case 'pulse':
      send(ws, { t: 'pulse' })
      return
    case 'hello': {
      refreshProfiles()
      const identity = identify(ws, msg.key, msg.token)
      send(ws, {
        t: 'hello.ok',
        identity:
          identity.kind === 'card' ? { cardId: identity.cardId } : identity.kind === 'owner' ? 'owner' : 'guest',
      })
      send(ws, stateMessage())
      return
    }

    case 'doc.list': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      send(ws, { t: 'doc.list', projectId: project.id, files: listMarkdown(project.path) })
      return
    }

    case 'doc.open': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      // Opening the same file twice should raise the existing card, not stack duplicates.
      const existing = store.findDoc(project.id, msg.relPath)
      if (existing) {
        broadcast({ t: 'doc.updated', card: existing })
        return
      }
      try {
        safeJoin(project.path, msg.relPath)
      } catch (err) {
        return fail(ws, (err as Error).message, msg.t)
      }
      const card: DocCard = {
        id: randomUUID(),
        projectId: project.id,
        relPath: msg.relPath,
        title: msg.relPath.split('/').pop() || msg.relPath,
        x: 0,
        y: 0,
        width: CARD_W,
        height: CARD_H,
        collapsed: false,
        manualPos: false,
        external: false,
        images: [],
        ownerId: null,
        web: null,
        kind: kindOf(msg.relPath),
        size: 'normal',
        fontSize: null,
        group: null,
        createdAt: Date.now(),
      }
      store.upsertDoc(card)
      broadcast({ t: 'doc.added', card })
      return
    }

    /** Create a new file in the project and open it, so a note can start on the board. */
    case 'doc.create': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      let abs: string
      try {
        abs = safeJoin(project.path, msg.relPath)
      } catch (err) {
        return fail(ws, (err as Error).message, msg.t)
      }
      if (existsSync(abs)) return fail(ws, 'a file with that name already exists', msg.t)
      const name = msg.relPath.split('/').pop() ?? msg.relPath
      try {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, msg.relPath.endsWith('.md') ? `# ${name.replace(/\.md$/, '')}

` : '', 'utf8')
      } catch (err) {
        return fail(ws, `could not create the file: ${(err as Error).message}`, msg.t)
      }
      /*
       * Where he was pointing, then nudged clear of anything already there.
       *
       * This was `x: 0, y: 0`, unconditionally, and it skipped the free-space search that every
       * session card goes through. On a fresh board that was invisible, because auto-packing tidied
       * everything up anyway. On a real board it was not: packing switches off for good the moment
       * one card is dragged by hand, so from that point every new file card was made at the origin
       * and stacked on top of the last one, off-screen from wherever he was working.
       */
      const asked =
        Number.isFinite(msg.x) && Number.isFinite(msg.y)
          ? { x: Number(msg.x), y: Number(msg.y) }
          : nextPosition(project.id)
      const spot = nearestFree(project.id, '', { x: asked.x, y: asked.y, w: CARD_W, h: CARD_H })

      const card: DocCard = {
        id: randomUUID(),
        projectId: project.id,
        relPath: msg.relPath,
        external: false,
        ownerId: null,
        web: null,
        images: [],
        kind: 'text',
        size: 'normal',
        fontSize: null,
        group: null,
        title: name,
        x: spot.x,
        y: spot.y,
        width: CARD_W,
        height: CARD_H,
        collapsed: false,
        manualPos: false,
        createdAt: Date.now(),
      }
      store.upsertDoc(card)
      broadcast({ t: 'doc.added', card })
      send(ws, { t: 'doc.list', projectId: project.id, files: listMarkdown(project.path) })
      return
    }

    case 'channel.create': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      const channel: Channel = {
        id: randomUUID(),
        projectId: project.id,
        // Bound by a wire, not at creation. A message card with nobody on the other end is a real
        // and useful state: it is what the owner is looking at while he decides who to wire it to.
        sessionId: null,
        path: null,
        x: typeof msg.x === 'number' ? msg.x : 0,
        y: typeof msg.y === 'number' ? msg.y : 0,
        width: 420,
        height: 420,
        fontSize: null,
        createdAt: Date.now(),
      }
      store.upsertChannel(channel)
      broadcast({ t: 'channel.added', channel })
      return
    }

    /**
     * What the owner just said, on disk and then announced.
     *
     * Two halves and both matter. The append is the record: it goes in the same file the card reads
     * and writes, so there is one copy of the conversation and it is the one on disk. The wake is
     * what makes it a conversation rather than a noticeboard, and it is the same single line Garden
     * types for mail, under the same rule: a card may be woken, the owner may not be interrupted.
     *
     * The card is told where to look rather than told what was said. The text is already in the file
     * and typing it into a terminal would put a second copy of it somewhere that scrolls away.
     */
    case 'channel.send': {
      const channel = store.getChannel(msg.channelId)
      if (!channel) return fail(ws, 'unknown message card', msg.t)
      if (!channel.sessionId || !channel.path) {
        return fail(ws, 'that message card is not wired to a card yet, so there is nobody to tell', msg.t)
      }
      const text = String(msg.text ?? '').trim()
      if (!text) return

      const stamp = new Date().toLocaleString('en-GB', { hour12: false })
      try {
        appendFileSync(channel.path, `\n## Owner, ${stamp}\n\n${text}\n`, 'utf8')
      } catch (err) {
        return fail(ws, `could not write ${channel.path}: ${(err as Error).message}`, msg.t)
      }
      pushChannelText(store.getChannel(channel.id) ?? channel)

      const session = store.getSession(channel.sessionId)
      const live = session ? ptys.isLive(session.id) : false
      if (live) {
        ptys.write(channel.sessionId, `The owner wrote to you in ${channel.path.replace(/\\/g, '/')}. Read it and reply by appending to that same file.`)
        // The return goes separately and a beat later, for the reason written where mail does it:
        // a composer handed the text and the return in one burst reads it as a paste and leaves it
        // sitting unsent. Under the generation this card is on now, so a restart inside those sixty
        // milliseconds drops it rather than typing it into a process that never saw the sentence.
        writeLater(channel.sessionId, session?.generation ?? -1, '\r')
      }
      /*
       * Said plainly either way. A card that is switched off cannot be told, and the note is still
       * in the file for whenever it starts, so this is filed rather than delivered. Reporting it as
       * sent would be the exact shape of failure this app exists to refuse.
       */
      send(ws, {
        t: 'error',
        message: live
          ? `Told ${session?.title ?? 'the card'} to read it.`
          : `Written to the file. ${session?.title ?? 'That card'} is not running, so it will see it when it next starts.`,
      })
      return
    }

    /**
     * The file as the owner just edited it on the card.
     *
     * Writes and tells nobody, which is the whole difference between this and `channel.send`. He is
     * correcting the record rather than saying something, and typing a line into a card's terminal
     * because he fixed his own spelling would be an interruption he did not ask for.
     *
     * Refuses rather than overwrites when the file has moved underneath him. The card at the other
     * end writes into this same file whenever it answers, so an edit begun before a reply arrived
     * would otherwise erase that reply and report success. `channel.text` goes back either way, so a
     * refusal leaves him looking at what is actually on disk rather than at what he typed.
     */
    case 'channel.save': {
      const channel = store.getChannel(msg.channelId)
      if (!channel) return fail(ws, 'unknown message card', msg.t)
      if (!channel.path) return fail(ws, 'that message card is not wired to a card yet', msg.t)
      if (typeof msg.text !== 'string') return fail(ws, 'text required', msg.t)

      const answer = (error?: string) =>
        send(ws, { t: 'channel.saved', channelId: channel.id, at: Date.now(), ...(error ? { error } : {}) })

      try {
        if (typeof msg.baseMtime === 'number' && existsSync(channel.path)) {
          const now = statSync(channel.path).mtimeMs
          // A second of slack, because a filesystem timestamp and a browser's clock are not the same
          // clock and a save is not worth refusing over rounding.
          if (now - msg.baseMtime > 1000) {
            pushChannelText(channel)
            return answer(
              'The card wrote to this file while you were typing, so your edit was not saved over ' +
                'its reply. What is on screen now is what is on disk.',
            )
          }
        }
        writeFileSync(channel.path, msg.text, 'utf8')
      } catch (err) {
        return answer(`Could not write ${channel.path}: ${(err as Error).message}`)
      }
      pushChannelText(store.getChannel(channel.id) ?? channel)
      answer()
      return
    }

    case 'channel.read': {
      const channel = store.getChannel(msg.channelId)
      if (!channel) return
      pushChannelText(channel)
      return
    }

    case 'channel.move': {
      const channel = store.getChannel(msg.channelId)
      if (!channel) return
      const moved: Channel = { ...channel, x: msg.x, y: msg.y }
      store.upsertChannel(moved)
      broadcast({ t: 'channel.updated', channel: moved })
      return
    }

    case 'channel.setBox': {
      const channel = store.getChannel(msg.channelId)
      if (!channel) return
      const sized: Channel = {
        ...channel,
        width: Math.max(280, Math.round(msg.width)),
        height: Math.max(220, Math.round(msg.height)),
      }
      store.upsertChannel(sized)
      broadcast({ t: 'channel.updated', channel: sized })
      return
    }

    case 'channel.setFontSize': {
      const channel = store.getChannel(msg.channelId)
      if (!channel) return
      const sized: Channel = { ...channel, fontSize: msg.fontSize }
      store.upsertChannel(sized)
      broadcast({ t: 'channel.updated', channel: sized })
      return
    }

    /*
     * The card goes, the conversation stays.
     *
     * NOTES.md is left exactly where it is, for the same reason closing a session card keeps its
     * history: the file is what was actually said, it lives in the card's own directory, and
     * removing a board decoration is not a reason to destroy a record. Wiring a new message card to
     * the same card picks the conversation straight back up.
     */
    case 'channel.delete': {
      const channel = store.getChannel(msg.channelId)
      if (!channel) return
      store.deleteChannel(channel.id)
      channelSeen.delete(channel.id)
      for (const w of store.listWires()) {
        if (w.sourceId === channel.id || w.targetId === channel.id) {
          store.deleteWire(w.id)
          broadcast({ t: 'wire.removed', wireId: w.id })
        }
      }
      broadcast({ t: 'channel.removed', channelId: channel.id })
      return
    }

    case 'doc.read': {
      const card = store.getDoc(msg.cardId)
      if (!card) return fail(ws, 'unknown card', msg.t)
      const project = store.getProject(card.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      try {
        const content = card.external
          ? readExternalDoc(card.relPath)
          : readDoc(project.path, card.relPath)
        // The card remembers when it read the file, so a later save can refuse to overwrite work
        // an agent did in between.
        send(ws, {
          t: 'doc.content',
          cardId: card.id,
          content,
          mtime: mtimeOf(project.path, card.relPath, card.external),
        })
      } catch (err) {
        send(ws, { t: 'doc.content', cardId: card.id, content: '', error: (err as Error).message })
      }
      return
    }

    case 'doc.save': {
      const card = store.getDoc(msg.cardId)
      if (!card) return fail(ws, 'unknown card', msg.t)
      const project = store.getProject(card.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      if (typeof msg.content !== 'string') return fail(ws, 'content required', msg.t)
      /*
       * A save says whether it worked, on both paths.
       *
       * It said nothing at all before. The bytes reached disk and the card sat on a pending badge
       * until its own four-second timer gave up and drew "no answer", so a save that had completely
       * succeeded was indistinguishable from one that had never arrived, on every single save. The
       * owner stopped trusting the button and went to a terminal to check the file by hand, which is
       * exactly the guessing this app exists to replace.
       *
       * A failure has to come back as `doc.saved` carrying the reason rather than as a generic
       * error frame, because the card resolves its state by id and a frame with no `cardId` cannot
       * reach it. That is why the failure badge existed and had never once been drawn.
       *
       * `baseMtime` is passed through now as well. The client has always sent it and the handler
       * dropped it, so `guardUnchanged` was reached with nothing to compare against and the refusal
       * of a file that moved underneath, which this app claims to do, never happened once.
       */
      try {
        const mtime = card.external
          ? writeExternalDoc(card.relPath, msg.content, msg.baseMtime)
          : writeDoc(project.path, card.relPath, msg.content, msg.baseMtime)
        return send(ws, { t: 'doc.saved', cardId: card.id, mtime })
      } catch (err) {
        return send(ws, {
          t: 'doc.saved',
          cardId: card.id,
          mtime: 0,
          error: (err as Error).message,
        })
      }
    }

    case 'doc.close': {
      for (const wireId of store.deleteWiresForCard(msg.cardId)) {
        broadcast({ t: 'wire.removed', wireId })
      }
      store.deleteDoc(msg.cardId)
      broadcast({ t: 'doc.removed', cardId: msg.cardId })
      return
    }

    case 'doc.move': {
      const card = store.getDoc(msg.cardId)
      if (!card) return
      const spot = nearestFree(card.projectId, card.id, {
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        w: card.width,
        h: card.collapsed ? BOARD.COLLAPSED_H : card.height,
      })
      const updated = { ...card, x: spot.x, y: spot.y, manualPos: true }
      store.upsertDoc(updated)
      broadcast({ t: 'doc.updated', card: updated })
      return
    }

    /**
     * Attach a loose card to a session.
     *
     * A document opened by hand lands wherever there is room and belongs to nothing. Attaching it
     * gives it an owner, wires it, and moves it into clear space beneath that session, so the
     * board says which terminal the file belongs to instead of leaving it floating.
     */
    case 'doc.attach': {
      const card = store.getDoc(msg.cardId)
      const session = store.getSession(msg.sessionId)
      if (!card || !session) return fail(ws, 'unknown card or session', msg.t)
      if (card.projectId !== session.projectId) return fail(ws, 'that card belongs to another project', msg.t)

      const spot = placeUnder(
        session,
        card.width,
        card.collapsed ? BOARD.COLLAPSED_H : card.height,
        `${session.id}:context`,
      )
      const updated: DocCard = {
        ...card,
        ownerId: session.id,
        web: 'context',
        manualPos: true,
        x: spot.x,
        y: spot.y,
      }
      store.upsertDoc(updated)
      broadcast({ t: 'doc.updated', card: updated })

      if (!store.findWire(session.id, card.id)) {
        const wire: Wire = {
          id: randomUUID(),
          projectId: session.projectId,
          sourceId: session.id,
          targetId: card.id,
          label: '',
          kind: 'context',
          bidirectional: false,
          createdAt: Date.now(),
        }
        store.upsertWire(wire)
        broadcast({ t: 'wire.added', wire })
      }
      return
    }

    case 'doc.detach': {
      const card = store.getDoc(msg.cardId)
      if (!card) return
      for (const wireId of store.deleteWiresForCard(card.id)) {
        broadcast({ t: 'wire.removed', wireId })
      }
      const updated: DocCard = { ...card, ownerId: null, web: null }
      store.upsertDoc(updated)
      broadcast({ t: 'doc.updated', card: updated })
      return
    }

    case 'doc.setSize': {
      const card = store.getDoc(msg.cardId)
      if (!card) return
      const size: DocCard['size'] = msg.size === 'large' || msg.size === 'full' ? msg.size : 'normal'
      const updated: DocCard = { ...card, size, collapsed: size === 'normal' ? card.collapsed : false }
      store.upsertDoc(updated)
      broadcast({ t: 'doc.updated', card: updated })
      return
    }

    case 'doc.setBox': {
      const card = store.getDoc(msg.cardId)
      if (!card) return
      const width = Math.max(200, Math.min(4000, Math.round(Number(msg.width) || card.width)))
      const height = Math.max(110, Math.min(3000, Math.round(Number(msg.height) || card.height)))
      const updated = { ...card, width, height, size: 'normal' as const, manualPos: true }
      store.upsertDoc(updated)
      broadcast({ t: 'doc.updated', card: updated })
      return
    }

    case 'doc.setFontSize': {
      const card = store.getDoc(msg.cardId)
      if (!card) return
      const fontSize =
        msg.fontSize === null ? null : Math.max(7, Math.min(28, Math.round(Number(msg.fontSize) || 12)))
      const updated = { ...card, fontSize }
      store.upsertDoc(updated)
      broadcast({ t: 'doc.updated', card: updated })
      return
    }

    /**
     * The owner moving a whole web himself.
     *
     * Every card in it travels the same distance, so the block keeps its shape and its columns.
     * Afterwards the ordinary pass runs with the web held where he put it, which means anything it
     * now lands on moves aside rather than the block springing back to where it was placed
     * automatically. He asked for this precisely because automatic placement can be wrong, and a
     * manual move that gets silently undone would be worse than not having it.
     */
    case 'web.move': {
      const session = store.getSession(msg.sessionId)
      if (!session) return fail(ws, 'unknown session', msg.t)
      const web = msg.web === 'history' ? 'history' : 'context'
      const cards = store.listWebDocs(session.id, web)
      if (cards.length === 0) return
      const dx = Number(msg.dx) || 0
      const dy = Number(msg.dy) || 0
      const moved = new Set<string>()
      for (const card of cards) {
        const updated = { ...card, x: card.x + dx, y: card.y + dy, manualPos: true }
        store.upsertDoc(updated)
        broadcast({ t: 'doc.updated', card: updated })
        moved.add(card.id)
      }
      resolveOverlaps(session.projectId, moved)
      return
    }

    case 'doc.setCollapsed': {
      const card = store.getDoc(msg.cardId)
      if (!card) return
      const updated = { ...card, collapsed: !!msg.collapsed }
      store.upsertDoc(updated)
      broadcast({ t: 'doc.updated', card: updated })
      /*
       * Opening a card makes it several times taller, downward, into whatever was under it.
       *
       * The space a web was given is the space its collapsed cards needed, so the moment one is
       * opened that reservation is wrong. This is the case the owner hit from the history arrow: a
       * turn opened to be read grew straight down over the session it belongs to. The card that was
       * just opened is the anchor, since it is the one he is looking at, so everything else moves
       * instead of it.
       */
      resolveOverlaps(card.projectId, new Set<string>([card.id]))
      return
    }

    /**
     * What a card is for, and what it is allowed to do.
     *
     * The powers are written into the session's settings file at launch, so changing them on a
     * running card takes effect the next time it is turned on. Garden says that plainly rather
     * than implying it changed something mid-turn, because a card that looked restricted while
     * still able to hire would be worse than no control at all.
     */
    case 'session.setRole': {
      const s = store.getSession(msg.sessionId)
      if (!s) return fail(ws, 'unknown session', msg.t)
      // The roles the table knows about, so there is one list rather than two that can disagree.
      const valid = Object.keys(ROLE_POWERS)
      /*
       * Only a card on the same board, and never itself.
       *
       * Reporting to a card in another project would draw a wire that cannot exist, and a card
       * reporting to itself would make the hierarchy arrangements walk in a circle. Both are
       * rejected rather than corrected, since neither can be what was meant.
       */
      let reportsTo = s.reportsTo
      if (msg.reportsTo !== undefined) {
        const target = msg.reportsTo ? store.getSession(msg.reportsTo) : null
        /*
         * A reporting line has to go somewhere, and it has to stop.
         *
         * Rejecting only "itself" was not enough: A answers to B answers to A is a loop, and
         * while the layout has a cycle guard so nothing crashes, the arrangement silently comes
         * out wrong and there is nothing on screen to explain why. A card that has finished is
         * also not somewhere to report to, since it has no process to report to.
         */
        const loops = (from: TerminalSession | undefined, seek: string, depth = 0): boolean => {
          if (!from || depth > 16) return false
          if (from.id === seek) return true
          return loops(from.reportsTo ? store.getSession(from.reportsTo) : undefined, seek, depth + 1)
        }
        const usable =
          target &&
          target.projectId === s.projectId &&
          target.id !== s.id &&
          target.kind === 'session' &&
          !loops(target, s.id)
        reportsTo = msg.reportsTo === null ? null : usable ? target!.id : s.reportsTo
        if (msg.reportsTo !== null && !usable) {
          fail(ws, 'that card cannot be answered to: it is not a session on this board, or it already answers to this one', msg.t)
        }
      }

      const updated: TerminalSession = {
        ...s,
        roleClass:
          msg.roleClass === null || (typeof msg.roleClass === 'string' && valid.includes(msg.roleClass))
            ? (msg.roleClass as TerminalSession['roleClass'])
            : s.roleClass,
        canSpawnAgents: typeof msg.canSpawnAgents === 'boolean' ? msg.canSpawnAgents : s.canSpawnAgents,
        canUseTeams: typeof msg.canUseTeams === 'boolean' ? msg.canUseTeams : s.canUseTeams,
        teamSize:
          msg.teamSize === null
            ? null
            : typeof msg.teamSize === 'number' && msg.teamSize >= 0 && msg.teamSize <= 20
              ? Math.round(msg.teamSize)
              : s.teamSize,
        modelChoice: msg.modelChoice === undefined ? s.modelChoice : msg.modelChoice,
        effortChoice: msg.effortChoice === undefined ? s.effortChoice : msg.effortChoice,
        reportsTo,
        /*
         * Written with the reporting line, so the two cannot drift apart again.
         *
         * Only on a session card. An agent card's parentId came from a dispatch Garden watched,
         * and the owner rewiring an org chart is not that event, so overwriting it here would
         * throw away the only record of what actually spawned the thing.
         */
        parentId: s.kind === 'session' ? reportsTo : s.parentId,
      }

      /*
       * Who reports to whom is a thing on the board, so changing it moves the wire.
       *
       * The old wire goes and a new one is drawn from the card it now answers to. Marked manual
       * because the owner asserted it, which keeps it visibly different from the derived wire a
       * real dispatch draws: one is a fact Garden observed, the other is an arrangement he made.
       */
      if (reportsTo !== s.reportsTo) {
        const oldParent = s.reportsTo
        if (oldParent) {
          const stale = store.findWire(oldParent, s.id)
          if (stale) {
            store.deleteWire(stale.id)
            broadcast({ t: 'wire.removed', wireId: stale.id })
          }
        }
        if (reportsTo && !store.findWire(reportsTo, s.id)) {
          const wire: Wire = {
            id: randomUUID(),
            projectId: s.projectId,
            sourceId: reportsTo,
            targetId: s.id,
            label: 'reports to',
            kind: 'manual',
            bidirectional: true,
            createdAt: Date.now(),
          }
          store.upsertWire(wire)
          broadcast({ t: 'wire.added', wire })
        }
        refreshMail(s.id)
        if (oldParent) refreshMail(oldParent)
        if (reportsTo) refreshMail(reportsTo)
      }
      store.upsertSession(updated)
      // Rewrite the file now as well, so a card turned on later gets the new rule even if the
      // server is restarted in between.
      installSessionHooks(port, updated.id, {
        canSpawnAgents: updated.canSpawnAgents,
        canUseTeams: updated.canUseTeams,
        teamSize: updated.teamSize,
        model: updated.modelChoice,
        effort: updated.effortChoice,
        roleClass: updated.roleClass,
      })
      // What a card was asked to keep to, written where the agent can read it. The concurrency
      // cap in the settings file is what the CLI enforces; this is the rest of the instruction.
      writePowers(updated, updated.reportsTo ? store.getSession(updated.reportsTo)?.title ?? null : null)
      /*
       * And the card's own brief, because changing a role changes what the card IS.
       *
       * POWERS.md was rewritten here and CLAUDE.md was not, so a card switched from worker to
       * reviewer went on describing itself as a worker in the one file the CLI picks up on its own.
       * Its own notes below the marker are carried across untouched, which is the whole reason that
       * marker exists: the role changing must not cost the card what it has learned.
       *
       * A running card keeps its old role until it is restarted, because the CLI reads permissions
       * once at launch. The card already shows that as pending through `roleClassRunning`, so the
       * file and the badge agree rather than the file quietly claiming a role nothing is enforcing.
       */
      ensureCardMemory(updated)
      refreshMail(updated.id)
      broadcast({ t: 'session.updated', session: updated })
      return
    }

    /**
     * Type the CLI's own command into a running session.
     *
     * The settings file is read once at launch and cannot reach a session already running, so a
     * model or effort change would otherwise sit on the card looking applied while the session
     * carried on as before. The CLI has `/model` and `/effort` for this, Garden owns the terminal,
     * so it types the line. Nothing here interprets the result: the session's own output is the
     * answer, and the card keeps reporting what the CLI says rather than what was asked for.
     */
    case 'session.applyNow': {
      const s = store.getSession(msg.sessionId)
      if (!s) return fail(ws, 'unknown session', msg.t)
      if (s.pid === null) return fail(ws, 'that session is not running', msg.t)
      if (s.adapterId !== 'claude') return fail(ws, 'only a Claude session takes these commands', msg.t)
      /*
       * Exactly two commands, checked rather than interpolated.
       *
       * The value came from stored state but the command name was whatever the caller sent, typed
       * straight into a live terminal. This is the only path that types into a session on anything
       * other than a keystroke the owner made, so it is the one worth being strict about, and it
       * is about to gain a third caller in the worker clear.
       */
      if (msg.what !== 'model' && msg.what !== 'effort') return fail(ws, 'not a command Garden types', msg.t)
      const value = msg.what === 'model' ? s.modelChoice : s.effortChoice
      if (!value) return fail(ws, `no ${msg.what} chosen for this card`, msg.t)
      /*
       * The command and the Enter go separately, which the mail wake-up path already does and this
       * one did not. Claude's prompt watches how input arrives and reads a burst ending in a newline
       * as pasted text, so a single write leaves the command sitting in the composer with a blank
       * line under it and sends nothing. The rule was written down where `flushMailWake` types, and
       * this call sat a thousand lines away doing the opposite.
       */
      if (ptys.write(s.id, `/${msg.what} ${value}`)) {
        writeLater(s.id, s.generation, '\r')
      }
      return
    }

    case 'session.setColor': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      const color = typeof msg.color === 'string' && /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : null
      const updated = { ...s, color }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      return
    }

    case 'session.setSize': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      const size: TerminalSession['size'] =
        msg.size === 'large' || msg.size === 'full' ? msg.size : 'normal'
      /*
       * Large writes its real dimensions into the row rather than leaving the canvas to substitute
       * them at draw time. The server places every web from the stored box, so a card drawn at 780
       * by 540 while stored as 340 by 260 has its roots placed for a card half its size, and they
       * end up underneath it.
       */
      const sent =
        Number.isFinite(msg.width) && Number.isFinite(msg.height)
          ? {
              width: Math.max(220, Math.min(4000, Math.round(Number(msg.width)))),
              height: Math.max(120, Math.min(3000, Math.round(Number(msg.height)))),
            }
          : null
      /*
       * Leaving Normal stamps the size it was, and coming back spends it.
       *
       * Without somewhere to keep it, stepping up to Large and back left the card at the preset's
       * dimensions, because the preset had overwritten the only box the card had.
       */
      const base =
        size !== 'normal' && s.size === 'normal'
          ? { baseWidth: s.width, baseHeight: s.height }
          : size === 'normal'
            ? { baseWidth: null, baseHeight: null }
            : {}
      const back =
        size === 'normal' && s.baseWidth && s.baseHeight ? { width: s.baseWidth, height: s.baseHeight } : {}
      const grown =
        size === 'large' ? { width: BOARD.LARGE_W, height: BOARD.LARGE_H } : size === 'full' && sent ? sent : back
      // Growing a card implies showing it, so expanding also un-compacts.
      const updated = { ...s, ...grown, ...base, size, collapsed: size === 'normal' ? s.collapsed : false }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      refitWebs(s, updated)
      return
    }

    // Exact size from dragging an edge. Clamped so a card can never be dragged to nothing.
    case 'session.setBox': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      const width = Math.max(220, Math.min(4000, Math.round(Number(msg.width) || s.width)))
      const height = Math.max(120, Math.min(3000, Math.round(Number(msg.height) || s.height)))
      const updated = { ...s, width, height, size: 'normal' as const, manualPos: true }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      // Its roots hang off the bottom edge that just moved, and its history off the top.
      refitWebs(s, updated)
      return
    }

    /**
     * Text size inside one card, from ctrl and the wheel.
     *
     * Per card rather than global: on a board this wide, the card being read and the ones only
     * being watched want different sizes.
     */
    case 'session.setFontSize': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      const fontSize =
        msg.fontSize === null ? null : Math.max(7, Math.min(28, Math.round(Number(msg.fontSize) || 11)))
      const updated = { ...s, fontSize }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      return
    }

    /*
     * Terminal or conversation, per card, stored rather than kept in the browser.
     *
     * It has to survive a reload and reach a second window for the same reason a card's size and
     * colour do: it is a decision the owner made about that card, not a state of the page he happens
     * to be looking at. Anything other than the two known values is refused rather than coerced,
     * because a card whose view is a typo would draw nothing and look broken.
     */
    case 'session.setBodyView': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      if (msg.bodyView !== 'terminal' && msg.bodyView !== 'chat') {
        return fail(ws, `not a card view: ${String(msg.bodyView)}`, msg.t)
      }
      const updated = { ...s, bodyView: msg.bodyView }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      return
    }

    case 'session.setCollapsed': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      const updated = { ...s, collapsed: !!msg.collapsed }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      // Folding a card to its header moves its bottom edge a long way up, and its roots with it.
      refitWebs(s, updated)
      return
    }

    case 'wire.create': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      if (msg.sourceId === msg.targetId) return
      // A wire must join two cards that exist, or it is a line to nowhere.
      const known = (id: string) => !!store.getSession(id) || !!store.getDoc(id) || !!store.getChannel(id)
      if (!known(msg.sourceId) || !known(msg.targetId)) return fail(ws, 'unknown card', msg.t)
      const existing = store.findWire(msg.sourceId, msg.targetId)
      if (existing) return

      const wire: Wire = {
        id: randomUUID(),
        projectId: project.id,
        sourceId: msg.sourceId,
        targetId: msg.targetId,
        label: (msg.label ?? '').slice(0, 80),
        kind: msg.kind === 'blind' || msg.kind === 'derived' ? msg.kind : 'manual',
        /*
         * Two-way unless asked otherwise. A wire the owner draws is him adding a connection the
         * spawn tree never made, and it used to be born one-way whatever the caller wanted, so the
         * card at the far end could be spoken to and could not answer until he found the toggle in
         * a right-click menu. A drawn line that refuses the reply is the kind of thing that reads
         * as the app being broken.
         */
        bidirectional: msg.bidirectional !== false,
        createdAt: Date.now(),
      }
      store.upsertWire(wire)
      broadcast({ t: 'wire.added', wire })
      /*
       * Drawing the wire is what binds a message card to a card, at the owner's own description of
       * how it should work: "when i add wire to the text box the card can read and edit the file".
       * Nothing else in this handler cares what kind of card is on each end, so the binding is the
       * only thing that has to notice.
       */
      bindChannel(wire.sourceId, wire.targetId)
      refreshMail(wire.sourceId)
      refreshMail(wire.targetId)
      return
    }

    /**
     * Send something along a wire.
     *
     * This is the whole difference between a drawn line and a connection. The message lands in
     * the target's mailbox as a file, and the wire lights because something really moved. What it
     * does not do is type into the other session or interrupt its turn: an agent picks its
     * mailbox up when it chooses to, which is what keeps a wire from being able to hijack a run.
     */
    case 'wire.send': {
      const wire = store.getWire(msg.wireId)
      if (!wire) return fail(ws, 'unknown wire', msg.t)
      const from = store.getSession(wire.sourceId)
      const to = store.getSession(wire.targetId)
      if (!from || !to) return fail(ws, 'a wire between cards that are not both sessions', msg.t)
      const text = String(msg.text ?? '').trim()
      if (!text) return

      postMessage(to, from.title, text)
      broadcast({ t: 'wire.pulse', wireId: wire.id, kind: wire.kind })
      const event = {
        id: randomUUID(),
        sessionId: to.id,
        ts: Date.now(),
        // The owner sent this through Garden, so Garden knows it happened first hand. This is the
        // one event in the system that does not come from a hook, and it is still not a guess.
        type: 'MailDelivered',
        provenance: 'structured' as const,
        payload: { from: from.id, fromTitle: from.title, wireId: wire.id, text: text.slice(0, 2000) },
      }
      store.insertEvent(event)
      broadcast({ t: 'event', event })
      return
    }

    case 'wire.label': {
      const wire = store.getWire(msg.wireId)
      if (!wire) return
      const updated = { ...wire, label: String(msg.label ?? '').slice(0, 80) }
      store.upsertWire(updated)
      broadcast({ t: 'wire.updated', wire: updated })
      return
    }

    case 'wire.setDirection': {
      const wire = store.getWire(msg.wireId)
      if (!wire) return fail(ws, 'unknown wire', msg.t)
      const updated = { ...wire, bidirectional: !!msg.bidirectional }
      store.upsertWire(updated)
      broadcast({ t: 'wire.updated', wire: updated })
      // Both ends are told, since who a card may hand work to is written into its mailbox.
      refreshMail(updated.sourceId)
      refreshMail(updated.targetId)
      return
    }

    case 'wire.setKind': {
      const wire = store.getWire(msg.wireId)
      if (!wire) return
      const kind: WireKind = msg.kind === 'blind' || msg.kind === 'derived' ? msg.kind : 'manual'
      const updated: Wire = { ...wire, kind }
      store.upsertWire(updated)
      broadcast({ t: 'wire.updated', wire: updated })
      return
    }

    case 'wire.delete': {
      const gone = store.getWire(msg.wireId)
      store.deleteWire(msg.wireId)
      broadcast({ t: 'wire.removed', wireId: msg.wireId })
      // Both ends forget each other, so a deleted wire cannot leave an agent believing it still
      // has somewhere to hand work to.
      if (gone) {
        refreshMail(gone.sourceId)
        refreshMail(gone.targetId)
      }
      return
    }

    /**
     * Unfold the files a session runs from as their own cards, fanned out below it and wired
     * back to it. Folding removes exactly these cards, never anything opened by hand.
     */
    /**
     * What this session runs from, as a list rather than as cards.
     *
     * A real project answers with dozens of files: 0.5 alone yields 68. Dropping all of them on
     * the board at once is not an answer to "what does this run from", it is a mess. The picker
     * groups them and opens only what is chosen.
     */
    case 'context.list': {
      const session = store.getSession(msg.sessionId)
      if (!session) return fail(ws, 'unknown session', msg.t)
      const project = store.getProject(session.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      const profile = session.profileId ? store.getProfile(session.profileId) : undefined
      const configDir = profile ? getAdapter(session.adapterId).configDirFor(profile) : undefined
      const memoryDir = memoryDirFor(project.name, session.id, session.title)
      ensureMemory(memoryDir)
      const openPaths = new Set(store.listWebDocs(session.id, 'context').map((d) => d.relPath))
      send(ws, {
        t: 'context.list',
        sessionId: session.id,
        // The card's own area, so a specialist's roots open with its own code rather than the
        // project's generic instructions. Absent for a card that owns nothing, which is every card
        // by default, and the scan is then byte-identical to what it always produced.
        entries: scanContext(project.path, configDir, memoryDir, undefined, session.ownedPaths, session.roleClass).map((e) => ({
          group: e.group,
          title: e.title,
          display: e.external ? e.abs : e.display,
          usage: e.usage,
          open: openPaths.has(e.external ? e.abs : e.display),
        })),
      })
      return
    }

    case 'context.open': {
      const session = store.getSession(msg.sessionId)
      if (!session) return fail(ws, 'unknown session', msg.t)
      const project = store.getProject(session.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      // Whatever is already unfolded is skipped, rather than bailing out entirely. The old guard
      // returned as soon as anything was open, so choosing a second group did nothing at all and
      // said nothing either.
      const already = new Set(store.listWebDocs(session.id, 'context').map((d) => d.relPath))

      const profile = session.profileId ? store.getProfile(session.profileId) : undefined
      const configDir = profile ? getAdapter(session.adapterId).configDirFor(profile) : undefined
      const memoryDir = memoryDirFor(project.name, session.id, session.title)
      ensureMemory(memoryDir)
      const all = scanContext(project.path, configDir, memoryDir, undefined, session.ownedPaths, session.roleClass)

      // Three ways to narrow the same scan, so no second code path can disagree about what a
      // session runs from: an explicit list from the picker, a whole group, or everything.
      const only = Array.isArray(msg.only) ? new Set(msg.only) : null
      const wanted = only
        ? all.filter((e) => only.has(e.external ? e.abs : e.display))
        : msg.group
          ? all.filter((e) => e.group === msg.group)
          : all
      if (wanted.length === 0) return fail(ws, `nothing found for ${msg.group ?? 'this session'}`, msg.t)

      const entries = wanted.filter((e) => !already.has(e.external ? e.abs : e.display))
      if (entries.length === 0) return

      /*
       * Lay the files out in columns, one per group, in the order they actually apply.
       *
       * A single run of cards tells you nothing about what kind of file each one is. A column of
       * instructions beside a column of settings beside a column of guards is the same
       * information arranged so it can be read: 0.5 puts 68 files here, and the difference
       * between six labelled columns and one long line is the difference between a diagram and a
       * pile.
       */
      /*
       * Every group the scan can produce, and `hooks` is here because it was missing.
       *
       * The layout builds its columns by filtering this list, so a group absent from it is silently
       * dropped: the files were found, the request was accepted, and nothing appeared on the board.
       * `hooks` is this card's own hooks, from the settings file Garden wrote for it, as against
       * `guards`, which is the machine's shared registry. Two different things, two columns, and one
       * of them could not be opened at all. The owner's report: "'its own hooks' doesnt open".
       */
      const GROUP_ORDER = ['instructions', 'memory', 'research', 'settings', 'skills', 'agents', 'hooks', 'guards']
      const byGroup = new Map<string, typeof entries>()
      for (const e of entries) {
        const list = byGroup.get(e.group) ?? []
        list.push(e)
        byGroup.set(e.group, list)
      }
      const columns = GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({
        group: g,
        // Alphabetical inside a column, so a named file can be found rather than hunted for.
        files: byGroup.get(g)!.slice().sort((a, b) => a.title.localeCompare(b.title)),
      }))

      const W = 260
      const H = 200
      const GAP_X = BOARD.GAP
      /*
       * Row to row, from the height a collapsed card really draws plus the gap every card keeps.
       *
       * A web is moved as a single block now, which is what stops it straddling a card, and the
       * cost of that is that nothing spreads its rows out afterwards. The stride used to be 54 for
       * cards that draw up to 52, and the collision pass quietly widened it to 64 on the way past.
       */
      const ROW_PITCH = BOARD.COLLAPSED_H + BOARD.WEB_ROW_GAP

      const tallest = Math.max(...columns.map((c) => c.files.length))
      const totalWidth = columns.length * W + (columns.length - 1) * GAP_X
      const totalHeight = (tallest - 1) * ROW_PITCH + BOARD.COLLAPSED_H

      /*
       * Directly beneath the card, with the board pushed apart to fit.
       *
       * These files belong to this session, so their block belongs under this session and nowhere
       * else. Searching for free space put it wherever the board happened to have room, which
       * could be a screen away from the card it describes. Making the room instead means the
       * block always lands in the one place that says whose files these are, and closing the blip
       * takes the space back.
       */
      const ownerH = session.collapsed ? BOARD.COLLAPSED_H : session.height
      /*
       * Enough room for the block, its border and the labels above it, and then a clear gap.
       *
       * The band inserted has to cover more than the cards: the frame drawn around them reaches
       * above the top row for its own title and the column labels, and the owner asked for real
       * space between the bottom of a web and whatever card sits under it. Without that trailing
       * gap the next card butted straight up against the border and the two read as one block.
       */
      const TRAILING_GAP = 150
            /*
       * Where the caller asked, when it asked for one column, and centred under the card otherwise.
       *
       * Centring is right for a whole web. It is wrong for a single column opened from its own pill,
       * because the pills are a header row and a column's rows belong under its own header.
       */
      const asked = msg.group && msg.at && Number.isFinite(msg.at.x) && Number.isFinite(msg.at.y) ? msg.at : null
      const spot = {
        x: asked ? asked.x : session.x + session.width / 2 - totalWidth / 2,
        /*
         * Far enough down that the frame clears the card, not just the cards inside it.
         *
         * This was a flat 90, and the frame reaches FRAME_HEADROOM above the first row, so the top
         * border of the web was drawn four pixels inside the card it belongs to. From the owner's
         * side that is the roots and the session overlapping with no padding, which is exactly what
         * he reported and exactly what the stored coordinates denied, because the frame is not a
         * stored card.
         */
        y: asked ? asked.y : session.y + ownerH + FRAME_HEADROOM + BOARD.GAP + BOARD.PORT_REACH,
      }
      /*
       * A card's own roots are never pushed aside by its own roots.
       *
       * Opening a column makes room by moving everything below the line down, and the columns already
       * open sit below that line. So opening a second column shoved the first one down, opening a
       * third shoved both, and a header row that is supposed to be a row walked into a diagonal
       * staircase. A blind reviewer put it exactly: "Each time you open another item in that first
       * cluster, the previously-opened one gets bumped further down and to the left, while the newest
       * stays in the row."
       *
       * Excluding them is right rather than convenient. They are part of the same block, they were
       * placed deliberately under their own headers, and nothing about opening a neighbour should
       * move them. Everything that is not this card's roots is still pushed clear.
       */
      const ownWeb = new Set<string>([session.id, ...store.listWebDocs(session.id, 'context').map((d) => d.id)])
      const room = insertBand(
        project.id,
        spot.y - FRAME_HEADROOM,
        totalHeight + FRAME_HEADROOM + TRAILING_GAP,
        ownWeb,
        'down',
      )
      // Appended, not replaced: a file attached by hand earlier put cards aside under this same
      // key, and overwriting the record left those cards stranded when the web was folded away.
      roomMade.set(`${session.id}:context`, [...(roomMade.get(`${session.id}:context`) ?? []), ...room.pushed])
      announceMoved(room.moved)

      const layout = (originX: number, originY: number) => {
        const out: Array<{ entry: (typeof entries)[number]; x: number; y: number }> = []
        columns.forEach((col, ci) => {
          col.files.forEach((e, ri) => {
            out.push({ entry: e, x: originX + ci * (W + GAP_X), y: originY + ri * ROW_PITCH })
          })
        })
        return out
      }

      /*
       * Place the whole block, then check every card in it and move the block if any of them
       * lands on something.
       *
       * Reserving a rectangle up front was not enough: the free-area search works from stored
       * positions, and columns are far taller than the rectangle suggested, so cards at the
       * bottom of a 24-row column still overlapped. Shifting the block keeps the columns intact,
       * which nudging individual cards would not.
       */
      const placed = layout(spot.x, spot.y)

      /*
       * Last resort: nudge anything still overlapping.
       *
       * Shifting the whole block keeps the columns readable and handles the common case, but it
       * reasons about a rectangle while a 24-row column is much taller than the block estimate.
       * Rather than keep guessing, every card is checked against the live board as it is placed,
       * and moved clear if it still lands on something. Columns survive except exactly where
       * they would otherwise cover a card, which is the trade worth making: the rule that cards
       * never overlap is not negotiable.
       */
      /*
       * Anything still standing where the block went gets moved out of it.
       *
       * The band inserted above moves everything past a line, which is what keeps the structure
       * below a card intact, but it cannot catch a card straddling that line: a tall card whose
       * middle sits above it stays put and the roots open straight across it. The owner saw
       * exactly that. Measuring the block's real rectangle afterwards and clearing it is the part
       * that cannot be done in advance.
       */
      clearBlock(
        project.id,
        { x: spot.x, y: spot.y - 40, w: totalWidth, h: totalHeight + 80 },
        ownWeb,
        'down',
        `${session.id}:context`,
      )

      placed.forEach(({ entry: e, x, y }) => {
        const relPath = e.external ? e.abs : e.display

        /*
         * One card per file, and one wire per card, leaving the blip.
         *
         * A file already on the board, opened by hand earlier, was getting a second card here for
         * the same path. That is what put two wires on screen for one file: the old card still
         * carried whatever connection it was opened with, and the new one carried the web's. The
         * web adopts the existing card instead, so a file appears once, connected to the dot it
         * belongs to and to nothing else.
         */
        /*
         * This session's own card for this file, and nobody else's.
         *
         * A file is shared: the project's CLAUDE.md belongs to the roots of every card in the
         * project. Looking one up by path alone found whichever card existed and re-owned it, so
         * opening one session's roots pulled cards out of another session's block and left that
         * block with holes in it. That is what the owner saw as the roots changing when he opened a
         * different session. A loose card he opened by hand himself, belonging to no web, is still
         * adopted rather than duplicated.
         */
        const sameFile = store.findDocsByPath(project.id, relPath)
        const existing =
          sameFile.find((d) => d.ownerId === session.id) ?? sameFile.find((d) => !d.ownerId && !d.web)
        const card: DocCard = existing
          ? {
              ...existing,
              ownerId: session.id,
              web: 'context',
              group: e.group,
              size: 'normal' as const,
              x,
              y,
              width: W,
              height: H,
              collapsed: true,
              manualPos: true,
            }
          : {
              id: randomUUID(),
              projectId: project.id,
              relPath,
              external: e.external,
              ownerId: session.id,
              web: 'context',
              kind: kindOf(e.abs),
              size: 'normal' as const,
              fontSize: null,
              group: e.group,
              title: e.title,
              x,
              y,
              width: W,
              height: H,
              collapsed: true,
              manualPos: true,
              // A file a session runs from is not evidence of anything it looked at.
              images: [],
              createdAt: Date.now(),
            }
        store.upsertDoc(card)
        broadcast({ t: existing ? 'doc.updated' : 'doc.added', card })

        // Whatever this card was connected to before, its only connection now is the blip.
        for (const wireId of store.deleteWiresForCard(card.id)) {
          broadcast({ t: 'wire.removed', wireId })
        }

        const wire: Wire = {
          id: randomUUID(),
          projectId: project.id,
          sourceId: session.id,
          targetId: card.id,
          label: '',
          kind: 'context',
          bidirectional: false,
          createdAt: Date.now(),
        }
        store.upsertWire(wire)
        broadcast({ t: 'wire.added', wire })
      })

      // Whatever is left touching anything settles now. The card whose roots these are stays put.
      resolveOverlaps(project.id, new Set<string>([session.id]))
      return
    }

    /**
     * Unfold what this session has actually done, above the card.
     *
     * One card per turn, each backed by a real file on disk rather than a panel that exists only
     * while the app is open. That is deliberate: the point of a history is that it outlives the
     * thing it describes, and a file can be opened, edited, quoted in a later prompt, or read by
     * another agent without Garden being involved at all.
     */
    /*
     * Which days a card has a history for, and which of them are on the board.
     *
     * Sent whenever the set could have changed, so the pills are drawn from the server's count of
     * the turns rather than from whichever cards happen to exist. A day with its turns open is
     * still listed: its pill is replaced by the header above its cards, and the board needs to know
     * which one that is.
     */
    /**
     * Stop and come back, keeping the board.
     *
     * A process cannot restart itself, so this launches a small detached helper that waits for this
     * port to actually close and then starts the replacement. The command it starts is this one:
     * `process.argv` says how the owner launched the server, which is the only thing that knows
     * whether he is on the built app or the watched source, so it is copied rather than guessed at.
     *
     * Everything on the board goes down with it. That is not this handler being careless, it is
     * what a restart IS on Windows: a process cannot be re-parented into a new instance. `revive`
     * on the way back up starts the cards that were running and resumes their conversations, which
     * is the closest honest thing to keeping them.
     */
    case 'server.restart': {
      const helper = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'garden-restart.mjs')
      const helperPath = existsSync(helper)
        ? helper
        : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'garden-restart.mjs')
      try {
        const child = spawn(
          process.execPath,
          [
            helperPath,
            '--port', String(port),
            '--cwd', process.cwd(),
            '--exec', process.execPath,
            /*
             * `execArgv` first, and it is the whole reason this button works.
             *
             * Node splits a command line in two. The flags it consumed itself land in
             * `process.execArgv` and everything after the script lands in `process.argv`. The board
             * is started by `npm run dev:server`, which is
             *
             *   node --require .../tsx/preflight.cjs --import .../tsx/loader.mjs src/index.ts
             *
             * so both loader flags are in the half that `argv` does not contain. Rebuilding the
             * launch from `argv` alone produced `node src/index.ts`, which cannot resolve this
             * codebase at all: every import here is written `./store.js` and only the tsx loader
             * maps that to the TypeScript beside it. The replacement died with
             * ERR_MODULE_NOT_FOUND before it opened a socket, so the board went down and stayed
             * down, and the owner closed the window and reopened the shortcut every time.
             *
             * It was invisible for as long as it existed because the test started the built
             * `dist/index.js` with plain node, where `execArgv` is empty and dropping it costs
             * nothing. `scripts/test-restart-survives-a-tsx-launch.mjs` now starts a board the way
             * the launcher does, which is the only shape that can catch this.
             */
            '--args', JSON.stringify([...process.execArgv, ...process.argv.slice(1)]),
          ],
          { detached: true, stdio: 'ignore' },
        )
        child.unref()
      } catch (err) {
        return fail(ws, `could not arrange the restart: ${(err as Error).message}`, msg.t)
      }
      /*
       * Told before it happens, because the socket dies with the server and a client that was not
       * warned draws "server offline" and reads it as a fault rather than as the thing it asked for.
       */
      broadcast({ t: 'error', message: 'Restarting. Every card goes down and the ones that were running come back.' })
      console.log('[garden] restart asked for from the board')
      // A beat, so that notice is on the wire before the socket closes under it.
      setTimeout(shutdown, 250)
      return
    }

    case 'history.groups': {
      const session = store.getSession(msg.sessionId)
      if (!session) return fail(ws, 'unknown session', msg.t)
      sendHistoryGroups(ws, session)
      return
    }

    /* Fold one day back to its pill, leaving every other day where it is. */
    case 'history.closeGroup': {
      const session = store.getSession(msg.sessionId)
      if (!session) return fail(ws, 'unknown session', msg.t)
      for (const card of store.listWebDocs(session.id, 'history')) {
        if (card.group !== msg.group) continue
        for (const wireId of store.deleteWiresForCard(card.id)) broadcast({ t: 'wire.removed', wireId })
        store.deleteDoc(card.id)
        broadcast({ t: 'doc.removed', cardId: card.id })
      }
      sendHistoryGroups(ws, session)
      return
    }

    case 'history.open': {
      const session = store.getSession(msg.sessionId)
      if (!session) return fail(ws, 'unknown session', msg.t)
      const project = store.getProject(session.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)

      /*
       * The arrow on the card opens the days, not the turns.
       *
       * It used to put every turn a card had ever taken on the board in one go, which on the
       * orchestrator is dozens of cards arriving together. That is the fault the roots had before
       * they became columns, and his words for it there were "makes it too laggy the way it is right
       * now". So a bare open answers with the days available and draws nothing; a day arrives when
       * he asks for that day.
       */
      const wanted = typeof msg.group === 'string' ? msg.group : null
      if (!wanted) {
        sendHistoryGroups(ws, session)
        return
      }

      // Folding and unfolding must not stack two copies of the same day.
      for (const card of store.listWebDocs(session.id, 'history')) {
        if (card.group !== wanted) continue
        for (const wireId of store.deleteWiresForCard(card.id)) broadcast({ t: 'wire.removed', wireId })
        store.deleteDoc(card.id)
        broadcast({ t: 'doc.removed', cardId: card.id })
      }

      // Reports are not a day and carry no work records; they come from delivery events instead.
      if (wanted === 'reports') {
        openReportsPill(session, project.id)
        sendHistoryGroups(ws, session)
        return
      }

      const records =
        wanted === 'conversation' ? [] : store.listWork(session.id).filter((r) => dayOf(r.startedAt).key === wanted)
      /*
       * An agent card's history comes from its transcript, because it has no work records.
       *
       * Work records are built from the hook events of a session Garden launched, and a spawned
       * agent is not one: it runs inside its parent. So this arrow opened nothing on exactly the
       * cards whose record the owner most wanted, while their transcripts sat on disk unread. The
       * turns are shaped the same way from either source, so everything below lays them out
       * identically and an agent's history block reads like any other card's.
       */
      const fromChat =
        wanted === 'conversation' && session.transcriptPath ? readChat(session.transcriptPath, 200) : []

      if (records.length === 0 && fromChat.length === 0) {
        // Nothing recorded is not the same as nothing happened, and the difference matters: a
        // session Garden never instrumented has no history to show and should say so rather than
        // unfolding an empty web that reads as "this agent did nothing".
        send(ws, { t: 'work', sessionId: session.id, records: [] })
        return
      }

      const written = fromChat.length
        ? writeAgentHistory(session, fromChat)
        : writeHistory(
            session,
            records,
            (id) => (id ? store.getSession(id) : undefined),
            store.listEvents(session.id),
          )

      const W = 260
      const H = 120
      const GAP = 14
      /*
       * History wraps into rows rather than running off the side of the board.
       *
       * A session that has been working for a day has dozens of turns, and a single row of dozens
       * of cards is a row nobody can read: it leaves the screen long before it runs out. Wrapping
       * keeps the block roughly as wide as the card it belongs to and grows it upward, which is
       * the direction its own arrow points, and the frame drawn around it scrolls with the canvas
       * like everything else.
       *
       * Newest first, because the turn you want is almost always the last one.
       */
      const PER_ROW = 6
      /*
       * Row to row, measured from what a collapsed card really draws plus the gap every card keeps.
       *
       * A web is now moved as one block, so nothing comes along afterwards and pushes its rows
       * apart: whatever spacing is set here is the spacing he sees. The old figure was a stride of
       * 58 for cards that draw 52, which is six pixels of daylight between one row and the next.
       */
      const ROW_PITCH = BOARD.COLLAPSED_H + BOARD.WEB_ROW_GAP
      written.reverse()
      const rows = Math.max(1, Math.ceil(written.length / PER_ROW))
      const totalWidth = Math.min(written.length, PER_ROW) * W + (Math.min(written.length, PER_ROW) - 1) * GAP

      /*
       * Above the card, with the board pushed apart upward to fit.
       *
       * History is what came before, the file web already owns the space below, and both need to
       * be able to open at once without either landing somewhere that hides which card it belongs
       * to. Cards standing where this band needs to go move up, and closing the blip gives that
       * space back.
       */
      const originX = session.x + session.width / 2 - totalWidth / 2
      /*
       * Measured from what is actually drawn, not from what is stored.
       *
       * These cards are created collapsed, so each one draws at header height whatever its stored
       * height says. Placing the block by the stored 120 left it sitting about 200 pixels above
       * its card while the file web sat 90 below, and the two webs looked like they belonged to
       * different cards. The gap above and the gap below now match.
       */
      const DRAWN_H = BOARD.COLLAPSED_H
      /*
       * The bottom row sits far enough above the card that the frame's lower border clears it by
       * the same gap the roots web keeps below. What has to clear the card is the border, not the
       * cards inside it, which is the arithmetic that put a web four pixels inside its own session.
       */
      const originY = session.y - BOARD.GAP - BOARD.PORT_REACH - BOARD.FRAME_PAD - DRAWN_H
      const blockHeight = (rows - 1) * ROW_PITCH + DRAWN_H
      const room = insertBand(
        project.id,
        session.y,
        blockHeight + FRAME_HEADROOM + BOARD.FRAME_PAD + BOARD.GAP + BOARD.PORT_REACH,
        new Set<string>([session.id]),
        'up',
      )
      roomMade.set(`${session.id}:history`, room.pushed)
      announceMoved(room.moved)

      clearBlock(
        project.id,
        {
          x: originX - BOARD.FRAME_PAD,
          y: originY - (rows - 1) * ROW_PITCH - FRAME_HEADROOM,
          w: totalWidth + BOARD.FRAME_PAD * 2,
          h: blockHeight + FRAME_HEADROOM + BOARD.FRAME_PAD,
        },
        new Set<string>([session.id]),
        'up',
        `${session.id}:history`,
      )

      written.forEach((turn, i) => {
        const spot = {
          x: originX + (i % PER_ROW) * (W + GAP),
          y: originY - Math.floor(i / PER_ROW) * ROW_PITCH,
        }
        const card: DocCard = {
          id: randomUUID(),
          projectId: project.id,
          relPath: turn.abs,
          external: true,
          ownerId: session.id,
          web: 'history',
          kind: 'text',
          size: 'normal',
          fontSize: null,
          /*
           * The day, because that is what the pill above these cards says.
           *
           * It used to be the origin, `asked` or `dispatched`, which nothing on the board ever drew:
           * the column headers are derived for the roots web only. Carrying the day here is what
           * lets a day be folded back on its own without touching the rest of the history.
           */
          group: wanted,
          images: turn.images,
          title: turn.title,
          x: spot.x,
          y: spot.y,
          width: W,
          height: H,
          collapsed: true,
          manualPos: true,
          createdAt: Date.now(),
        }
        store.upsertDoc(card)
        broadcast({ t: 'doc.added', card })

        const wire: Wire = {
          id: randomUUID(),
          projectId: project.id,
          sourceId: session.id,
          targetId: card.id,
          label: '',
          kind: 'history',
          bidirectional: false,
          createdAt: Date.now(),
        }
        store.upsertWire(wire)
        broadcast({ t: 'wire.added', wire })
      })
      resolveOverlaps(project.id, new Set<string>([session.id]))
      sendHistoryGroups(ws, session)

      return
    }

    case 'transcript.open': {
      const session = store.getSession(msg.sessionId)
      if (!session) return fail(ws, 'unknown session', msg.t)
      const project = store.getProject(session.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      if (!session.transcriptPath) {
        // Never invented. A card with no transcript path was never instrumented, and saying so is
        // the honest answer to "what did this agent do".
        return fail(ws, 'this card has no transcript: Garden never saw one for it', msg.t)
      }

      const rendered = renderTranscript(session.transcriptPath)
      const dir = historyDirFor(session.id)
      const abs = join(dir, 'transcript.md')
      writeFileSync(abs, rendered.markdown, 'utf8')

      const existing = store.findDoc(project.id, abs)
      if (existing) {
        // Refresh in place rather than opening a second copy of the same conversation.
        send(ws, {
          t: 'doc.content',
          cardId: existing.id,
          content: rendered.markdown,
          mtime: mtimeOf(project.path, abs, true),
        })
        return
      }

      // A transcript is what this card did, so it opens above it like the rest of its history.
      const spot = placeAbove(session, 420, 320, `${session.id}:history`)
      const card: DocCard = {
        id: randomUUID(),
        projectId: project.id,
        relPath: abs,
        external: true,
        ownerId: session.id,
        web: 'history',
        kind: 'text',
        size: 'normal',
        fontSize: null,
        group: 'transcript',
        images: [],
        title: `${session.title}: transcript`,
        x: spot.x,
        y: spot.y,
        width: 420,
        height: 320,
        collapsed: false,
        manualPos: true,
        createdAt: Date.now(),
      }
      store.upsertDoc(card)
      broadcast({ t: 'doc.added', card })

      const wire: Wire = {
        id: randomUUID(),
        projectId: project.id,
        sourceId: session.id,
        targetId: card.id,
        label: '',
        kind: 'history',
        bidirectional: false,
        createdAt: Date.now(),
      }
      store.upsertWire(wire)
      broadcast({ t: 'wire.added', wire })
      return
    }

    /**
     * Unfold the pictures a turn reviewed, beside the turn that reviewed them.
     *
     * The owner's case is the blind review: a card that says a reviewer ran tells him a command
     * happened, and the only thing that settles whether the review was worth anything is the
     * picture it was given. Those paths are already recorded from the CLI's own Read calls, so
     * this puts them on the board where the claim is, rather than leaving him to find a file.
     *
     * To the right, because a turn's own record sits above its session and its files below, and
     * this is neither: it is what that turn looked at.
     */
    case 'evidence.open': {
      const card = store.getDoc(msg.cardId)
      if (!card) return fail(ws, 'unknown card', msg.t)
      const project = store.getProject(card.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      if (card.images.length === 0) {
        // Never invented. A turn with no recorded image opened nothing, and saying so beats
        // opening an empty frame that looks like a failure.
        return fail(ws, 'no images were recorded for this turn', msg.t)
      }

      // Folding and unfolding must not stack two copies.
      for (const existing of store.listDocs().filter((d) => d.ownerId === card.id && d.web === 'history')) {
        for (const wireId of store.deleteWiresForCard(existing.id)) broadcast({ t: 'wire.removed', wireId })
        store.deleteDoc(existing.id)
        broadcast({ t: 'doc.removed', cardId: existing.id })
      }

      const W = 300
      const H = 220
      const GAP = 16
      const cardH = card.collapsed ? BOARD.COLLAPSED_H : card.height
      card.images.forEach((abs, i) => {
        const shot: DocCard = {
          id: randomUUID(),
          projectId: project.id,
          relPath: abs,
          external: true,
          // Owned by the TURN, not by the session, so folding this turn away takes its pictures
          // with it and leaves every other turn's alone.
          ownerId: card.id,
          web: 'history',
          kind: 'image',
          size: 'normal',
          fontSize: null,
          group: 'reviewed',
          title: abs.split(/[\/]/).pop() ?? 'image',
          x: card.x + card.width + 90 + i * (W + GAP),
          y: card.y + cardH / 2 - H / 2,
          width: W,
          height: H,
          collapsed: false,
          manualPos: true,
          images: [],
          createdAt: Date.now(),
        }
        store.upsertDoc(shot)
        broadcast({ t: 'doc.added', card: shot })

        const wire: Wire = {
          id: randomUUID(),
          projectId: project.id,
          sourceId: card.id,
          targetId: shot.id,
          label: '',
          kind: 'evidence',
          bidirectional: false,
          createdAt: Date.now(),
        }
        store.upsertWire(wire)
        broadcast({ t: 'wire.added', wire })
      })
      resolveOverlaps(project.id, new Set<string>([card.id]))

      return
    }

    case 'evidence.close': {
      for (const shot of store.listDocs().filter((d) => d.ownerId === msg.cardId)) {
        for (const wireId of store.deleteWiresForCard(shot.id)) broadcast({ t: 'wire.removed', wireId })
        store.deleteDoc(shot.id)
        broadcast({ t: 'doc.removed', cardId: shot.id })
      }
      return
    }

    case 'history.close': {
      giveBackRoom(`${msg.sessionId}:history`)
      for (const card of store.listWebDocs(msg.sessionId, 'history')) {
        // A turn's pictures belong to that turn, so they go when it does rather than being left
        // on the board wired to a card that no longer exists.
        for (const shot of store.listDocs().filter((d) => d.ownerId === card.id)) {
          for (const wireId of store.deleteWiresForCard(shot.id)) broadcast({ t: 'wire.removed', wireId })
          store.deleteDoc(shot.id)
          broadcast({ t: 'doc.removed', cardId: shot.id })
        }
        for (const wireId of store.deleteWiresForCard(card.id)) {
          broadcast({ t: 'wire.removed', wireId })
        }
        store.deleteDoc(card.id)
        broadcast({ t: 'doc.removed', cardId: card.id })
      }
      return
    }

    case 'context.close': {
      /*
       * One column, or all of them.
       *
       * The room made for the block is only given back when the whole web folds away. Giving it back
       * per column would move the board while other columns are still standing in it, and the space
       * is reclaimed a moment later anyway when the last one closes.
       */
      if (msg.group) {
        for (const card of store.listWebDocs(msg.sessionId, 'context')) {
          if (card.group !== msg.group) continue
          for (const wireId of store.deleteWiresForCard(card.id)) {
            broadcast({ t: 'wire.removed', wireId })
          }
          store.deleteDoc(card.id)
          broadcast({ t: 'doc.removed', cardId: card.id })
        }
        return
      }
      giveBackRoom(`${msg.sessionId}:context`)
      for (const card of store.listWebDocs(msg.sessionId, 'context')) {
        for (const wireId of store.deleteWiresForCard(card.id)) {
          broadcast({ t: 'wire.removed', wireId })
        }
        store.deleteDoc(card.id)
        broadcast({ t: 'doc.removed', cardId: card.id })
      }
      return
    }

    /**
     * Record where the client actually drew each card.
     *
     * Auto-packed cards are positioned by the renderer, so the server's stored coordinates were
     * stale, and it placed context webs against a board that no longer existed. That is how 68
     * file cards landed on top of ten others despite a free-space search. `manualPos` is left
     * alone: this is the server catching up, not the owner arranging anything.
     */
    case 'board.layout': {
      if (!Array.isArray(msg.positions)) return
      for (const p of msg.positions.slice(0, 500)) {
        const s = store.getSession(p.id)
        if (s) {
          if (s.x !== p.x || s.y !== p.y) store.upsertSession({ ...s, x: p.x, y: p.y })
          continue
        }
        const d = store.getDoc(p.id)
        if (d && (d.x !== p.x || d.y !== p.y)) store.upsertDoc({ ...d, x: p.x, y: p.y })
      }
      return
    }

    case 'board.arrange': {
      /*
       * Applied verbatim, with no nudging.
       *
       * The client has already worked out a lattice where nothing overlaps, and it knows about
       * every card at once. Running each position through the free-space search here would check
       * it against cards still sitting at their old coordinates, which is how a laid-out board
       * came back looking like the one before it.
       */
      if (!Array.isArray(msg.positions)) return

      /*
       * Where everything was, saved before anything moves.
       *
       * The owner said he was afraid to arrange a board he had built by hand, and he was right to
       * be: the way back lived only in the browser tab that pressed the button, so a reload lost
       * it. This is written on the server, one per project, overwritten each time, so there is
       * always exactly one step back and it survives a reload, a restart and another window.
       */
      const firstArranged = msg.positions.find((p) => typeof p?.id === 'string')
      const beforeProject = firstArranged
        ? store.getSession(firstArranged.id)?.projectId ?? store.getDoc(firstArranged.id)?.projectId ?? null
        : null
      if (beforeProject) {
        snapshotLayout(beforeProject, 'Before the last arrangement', true, null)
        /*
         * Tell the rail immediately, or the way back exists and nothing offers it.
         *
         * The snapshot was being written and never announced, so Previous only appeared after a
         * reload, which is exactly the moment the owner would already have lost the board he was
         * worried about. Saving a way back that nobody can see is the same as not saving one.
         */
        broadcast({ t: 'layouts', projectId: beforeProject, layouts: store.listLayouts(beforeProject) })
      }

      const arranged: string[] = []
      for (const p of msg.positions.slice(0, 2000)) {
        if (typeof p?.id !== 'string' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
        const s = store.getSession(p.id)
        if (s) {
          store.upsertSession({ ...s, x: p.x, y: p.y, manualPos: true })
          arranged.push(p.id)
          continue
        }
        const d = store.getDoc(p.id)
        if (d) {
          store.upsertDoc({ ...d, x: p.x, y: p.y, manualPos: true })
          arranged.push(p.id)
        }
      }

      /*
       * Now that every card is where the arrangement asked, check the result and move anything
       * that still lands on something else.
       *
       * This runs after the whole set rather than per card, which is the difference that matters:
       * checking each move as it arrives compares it against cards still sitting at their old
       * coordinates and destroys the shape. Checking once at the end sees the finished board, so
       * the shape survives and the rule that no card may cover another still holds. The client
       * usually leaves nothing to do here; this is the guarantee, not the layout.
       */
      for (const id of arranged) {
        const card = store.getSession(id) ?? store.getDoc(id)
        if (!card) continue
        const h = 'collapsed' in card && card.collapsed ? BOARD.COLLAPSED_H : card.height
        const free = nearestFree(card.projectId, id, { x: card.x, y: card.y, w: card.width, h })
        if (free.x !== card.x || free.y !== card.y) {
          const session = store.getSession(id)
          if (session) store.upsertSession({ ...session, x: free.x, y: free.y })
          else {
            const doc = store.getDoc(id)
            if (doc) store.upsertDoc({ ...doc, x: free.x, y: free.y })
          }
        }
      }

      /*
       * The client's lattice does not overlap, but the board it was computed from may have gained
       * a card since, and a web opened on one of those is not in the lattice at all.
       */
      const firstId = arranged[0]
      const projectOf = firstId
        ? store.getSession(firstId)?.projectId ?? store.getDoc(firstId)?.projectId ?? null
        : null
      if (projectOf) resolveOverlaps(projectOf, new Set())

      for (const id of arranged) {
        const session = store.getSession(id)
        if (session) {
          broadcast({ t: 'session.updated', session })
          continue
        }
        const doc = store.getDoc(id)
        if (doc) broadcast({ t: 'doc.updated', card: doc })
      }
      return
    }

    /**
     * Save the board as it stands, under a name.
     *
     * The small honest half of a blueprint: it records where cards are, not which processes were
     * running, so restoring it can never pretend to bring a session back from the dead.
     */
    case 'layout.save': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      const name = String(msg.name ?? '').trim().slice(0, 60)
      if (!name) return fail(ws, 'a layout needs a name', msg.t)
      const basedOn = typeof msg.basedOn === 'string' ? msg.basedOn.slice(0, 20) : null
      snapshotLayout(project.id, name, false, basedOn)
      broadcast({ t: 'layouts', projectId: project.id, layouts: store.listLayouts(project.id) })
      return
    }

    case 'layout.restore': {
      const layout = store.getLayout(msg.layoutId)
      if (!layout) return fail(ws, 'unknown layout', msg.t)
      for (const p of layout.positions) {
        const session = store.getSession(p.id)
        if (session) {
          const updated = { ...session, x: p.x, y: p.y, manualPos: true }
          store.upsertSession(updated)
          broadcast({ t: 'session.updated', session: updated })
          continue
        }
        const doc = store.getDoc(p.id)
        if (doc) {
          const updated = { ...doc, x: p.x, y: p.y, manualPos: true }
          store.upsertDoc(updated)
          broadcast({ t: 'doc.updated', card: updated })
        }
      }
      /*
       * A card created since the layout was saved is not in it, so it stays where it is and then
       * gets settled out of anything it now covers. Restoring must not leave a card hidden.
       */
      resolveOverlaps(layout.projectId, new Set(layout.positions.map((p) => p.id)))
      return
    }

    case 'layout.delete': {
      const layout = store.getLayout(msg.layoutId)
      if (!layout) return
      store.deleteLayout(layout.id)
      broadcast({ t: 'layouts', projectId: layout.projectId, layouts: store.listLayouts(layout.projectId) })
      return
    }

    case 'layout.list': {
      send(ws, { t: 'layouts', projectId: msg.projectId, layouts: store.listLayouts(msg.projectId) })
      return
    }

    case 'board.tidy': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      store.clearManualPositions(project.id)
      for (const s of store.listSessions().filter((x) => x.projectId === project.id)) {
        broadcast({ t: 'session.updated', session: s })
      }
      for (const d of store.listDocs().filter((x) => x.projectId === project.id)) {
        broadcast({ t: 'doc.updated', card: d })
      }
      return
    }

    case 'project.pick': {
      /*
       * Windows' own folder dialog, run in an STA PowerShell because the dialog requires one.
       *
       * Two details matter and both were wrong first time. The console window must be hidden, or
       * a black box flashes up and takes focus. And the dialog needs a topmost owner window, or
       * it can open behind the app and, when it closes, Windows hands focus to whatever is
       * underneath, which looked exactly like Garden minimising itself.
       */
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$owner = New-Object System.Windows.Forms.Form;',
        '$owner.TopMost = $true;',
        '$owner.ShowInTaskbar = $false;',
        '$owner.Opacity = 0;',
        '$owner.Show();',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        "$d.Description = 'Pick a project folder for Garden';",
        '$d.ShowNewFolderButton = $true;',
        '$result = $d.ShowDialog($owner);',
        '$owner.Close();',
        'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
      ].join('')

      execFile(
        'powershell.exe',
        ['-STA', '-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 120000, windowsHide: true },
        (err, stdout) => {
          const picked = String(stdout ?? '').trim()
          if (err || !picked) {
            // Cancelling is a normal outcome, not an error worth a banner.
            send(ws, { t: 'project.picked', path: null })
            return
          }
          try {
            const project = addProject(picked)
            broadcast({ t: 'project.added', project })
            send(ws, { t: 'project.picked', path: picked })
          } catch (e) {
            fail(ws, (e as Error).message, 'project.pick')
          }
        },
      )
      return
    }

    case 'project.add': {
      if (typeof msg.path !== 'string' || !msg.path.trim()) return fail(ws, 'path required', msg.t)
      const project = addProject(msg.path, msg.name)
      broadcast({ t: 'project.added', project })
      return
    }

    /**
     * Close a tab: stop what is running in it, take it off the row, keep the board.
     *
     * The owner's words, and the distinction matters: he wants to put a project down and pick it up
     * later, so nothing is deleted. Every card stays where he left it, with its wires and its
     * history, and the sessions are marked stopped because that is what they are. A Windows process
     * does not survive being closed, and a card claiming otherwise on reopening would be the exact
     * lie this app exists to refuse.
     */
    case 'project.close': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      for (const s of store.listSessions().filter((x) => x.projectId === project.id)) {
        if (ptys.isLive(s.id)) ptys.kill(s.id)
        if (s.pid === null && s.status === 'stopped') continue
        const stopped: TerminalSession = { ...s, pid: null, status: 'stopped', waitingFor: null }
        store.upsertSession(stopped)
        broadcast({ t: 'session.updated', session: stopped })
      }
      store.setProjectArchived(project.id, true)
      broadcast({ t: 'project.removed', projectId: project.id })
      broadcast({ t: 'projects.closed', projects: store.listClosedProjects() })
      return
    }

    /** Pick a closed tab back up, with the board exactly as it was left. */
    case 'project.reopen': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      store.setProjectArchived(project.id, false)
      broadcast({ t: 'project.added', project: store.getProject(project.id)! })
      // Its cards come back with it, since nothing was ever thrown away.
      for (const s of store.listSessions().filter((x) => x.projectId === project.id)) {
        broadcast({ t: 'session.added', session: s })
      }
      for (const d of store.listDocs().filter((x) => x.projectId === project.id)) {
        broadcast({ t: 'doc.added', card: d })
      }
      for (const w of store.listWires().filter((x) => x.projectId === project.id)) {
        broadcast({ t: 'wire.added', wire: w })
      }
      broadcast({ t: 'projects.closed', projects: store.listClosedProjects() })
      return
    }

    case 'project.listClosed': {
      send(ws, { t: 'projects.closed', projects: store.listClosedProjects() })
      return
    }

    /**
     * Write this board down, into Garden's own directory.
     *
     * Closing a tab already keeps everything; this is the moment he chose, so a team can be laid
     * out, saved, taken apart, and got back. What goes in the file is honest about what it is: no
     * process ids, nothing marked running, and no suggestion that opening it revives anything.
     */
    case 'board.save': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      const board = saveBoard({
        name: String(msg.name ?? '').trim() || project.name,
        projectId: project.id,
        projectPath: project.path,
        sessions: store.listSessions().filter((s) => s.projectId === project.id),
        docs: store.listDocs().filter((d) => d.projectId === project.id),
        wires: store.listWires().filter((w) => w.projectId === project.id),
      })
      console.log(`[garden] board saved: ${board.file}`)
      broadcast({ t: 'boards', boards: listBoards() })
      return
    }

    case 'board.list': {
      send(ws, { t: 'boards', boards: listBoards() })
      return
    }

    case 'board.delete': {
      deleteBoard(String(msg.file ?? ''))
      broadcast({ t: 'boards', boards: listBoards() })
      return
    }

    /**
     * Put a saved board back on screen.
     *
     * Onto the project it was saved from, which is reopened first if he had closed it. Cards are
     * restored by their own ids, so opening the same board twice puts things back where they were
     * rather than making a second copy of every card. Every restored card is stopped, and any card
     * whose process is genuinely still running is left alone rather than being told it is not.
     */
    case 'board.open': {
      const board = readBoard(String(msg.file ?? ''))
      if (!board) return fail(ws, 'that saved board could not be read', msg.t)
      const project = store.getProject(board.projectId)
      if (!project) {
        return fail(ws, `the project this board belongs to is gone (${board.projectPath})`, msg.t)
      }
      store.setProjectArchived(project.id, false)
      broadcast({ t: 'project.added', project: store.getProject(project.id)! })

      for (const saved of board.sessions) {
        const live = store.getSession(saved.id)
        /*
         * A running card keeps everything and only moves. A stopped one takes the saved layout, but
         * not at the cost of its conversation: the row in the database knows which conversation this
         * card was last in, and the file, written earlier, does not. Letting the file win there
         * quietly cost the card its history, and the card would then start a new conversation while
         * looking exactly like the one that had been saved.
         */
        const card: TerminalSession =
          live && live.pid !== null
            ? { ...live, x: saved.x, y: saved.y }
            : live
              ? { ...saved, claudeSessionId: live.claudeSessionId, transcriptPath: live.transcriptPath }
              : saved
        store.upsertSession(card)
        broadcast({ t: live ? 'session.updated' : 'session.added', session: card })
      }
      for (const doc of board.docs) {
        store.upsertDoc(doc)
        broadcast({ t: store.getDoc(doc.id) ? 'doc.updated' : 'doc.added', card: doc })
      }
      for (const wire of board.wires) {
        if (store.getWire(wire.id)) continue
        store.upsertWire(wire)
        broadcast({ t: 'wire.added', wire })
      }
      broadcast({ t: 'projects.closed', projects: store.listClosedProjects() })
      return
    }

    /*
     * Forget a board entirely. Not what closing a tab does, and not reachable from the tab menu:
     * this is the permanent one, and it takes the cards, wires and saved layouts with it.
     */
    case 'project.remove': {
      for (const s of store.listSessions().filter((s) => s.projectId === msg.projectId)) {
        ptys.kill(s.id)
        store.deleteSession(s.id)
        broadcast({ t: 'session.removed', sessionId: s.id })
      }
      // The cards, wires and layouts belonging to it, which used to outlive it invisibly.
      for (const card of store.listDocs().filter((d) => d.projectId === msg.projectId)) {
        broadcast({ t: 'doc.removed', cardId: card.id })
      }
      store.deleteProject(msg.projectId)
      broadcast({ t: 'project.removed', projectId: msg.projectId })
      return
    }

    case 'profile.create': {
      const name = String(msg.name ?? '').trim().slice(0, 60)
      if (!name) return fail(ws, 'name required', msg.t)
      if (!isAdapterId(msg.adapterId)) return fail(ws, 'unknown adapter', msg.t)
      const id = randomUUID()
      const configDir = join(DATA_DIR, 'profiles', id, msg.adapterId)
      ensureConfigDir(configDir)
      const acct = readAccount(configDir)
      store.upsertProfile({
        id,
        name,
        adapterId: msg.adapterId,
        configDir,
        accountEmail: acct?.email ?? null,
        accountName: acct?.displayName ?? null,
        organizationName: acct?.organizationName ?? null,
        createdAt: Date.now(),
      })
      broadcast({ t: 'profiles', profiles: store.listProfiles(), defaultAccount: readAccount(defaultConfigDir()) })
      return
    }

    case 'profile.delete': {
      store.deleteProfile(msg.profileId)
      broadcast({ t: 'profiles', profiles: store.listProfiles(), defaultAccount: readAccount(defaultConfigDir()) })
      for (const p of store.listProjects()) broadcast({ t: 'project.updated', project: p })
      return
    }

    case 'profile.refresh': {
      refreshProfiles()
      broadcast({ t: 'profiles', profiles: store.listProfiles(), defaultAccount: readAccount(defaultConfigDir()) })
      return
    }

    case 'project.setProfile': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      if (msg.profileId && !store.getProfile(msg.profileId)) return fail(ws, 'unknown profile', msg.t)
      if (!isAdapterId(msg.adapterId)) return fail(ws, 'unknown adapter', msg.t)
      store.setProjectProfile(project.id, msg.adapterId, msg.profileId)
      const updated = store.getProject(project.id)!
      broadcast({ t: 'project.updated', project: updated })
      return
    }

    case 'project.open': {
      store.touchProject(msg.projectId)
      return
    }

    /*
     * The task plane over the socket.
     *
     * Each of these calls the same function `POST /task` calls, including the dispatcher check, so
     * the two doors cannot come to different answers. `socketMaySend` has already refused a card
     * connection that may not dispatch and a guest that may not write; the op checks again against
     * the acting card, because the owner's own connection reaches here too.
     */
    case 'task.list': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      return send(ws, taskStateMessage(project.id))
    }

    case 'task.create':
    case 'task.bind':
    case 'task.reassign':
    case 'task.split':
    case 'task.verifier': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      const id = identityOf(ws)
      const actor = id.kind === 'card' ? (store.getSession(id.cardId) ?? null) : null
      const result =
        msg.t === 'task.create'
          ? taskCreate(actor, project.id, msg.task)
          : msg.t === 'task.bind'
            ? taskBind(actor, project.id, msg)
            : msg.t === 'task.reassign'
              ? taskReassign(actor, project.id, msg)
              : msg.t === 'task.split'
                ? taskSplit(actor, project.id, msg)
                : taskVerifier(actor, project.id, msg)
      if (!result.ok) {
        const asked = msg.t === 'task.create' ? msg.task?.id : (msg as any).taskId
        recordTaskPlaneRefusal(actor, msg.t.slice('task.'.length), asked ? String(asked) : null, result.reason)
        return fail(ws, result.reason, msg.t)
      }
      // The whole picture rather than only the row that changed, because a split writes several and
      // a bind writes a task and a reassignment together.
      return send(ws, taskStateMessage(project.id))
    }

    /*
     * A card's own secret, for the owner alone.
     *
     * Owner connections only, and the check is here rather than only in `socketMaySend` because
     * this is the one message where a card connection asking about another card would be handing
     * one card the ability to send as another, which is the exact hole the token exists to close.
     */
    case 'session.token': {
      if (identityOf(ws).kind !== 'owner') {
        return fail(ws, 'a card token is the owner\'s to read, not another card\'s', msg.t)
      }
      /*
       * A card that exists has a token, running or not. It is minted when the card is made and kept
       * until this server exits, and a card that predates the mint gets one right here, the first
       * time anything asks. What used to happen instead was that a stopped card had no answer, so
       * the owner could not hand a switched-off card's token to a test or a script, which is the
       * exact thing canon 20's verification needs it for.
       */
      const card = store.getSession(msg.sessionId)
      if (!card) return fail(ws, 'that card is not one Garden knows', msg.t)
      // A closed card has had its token withdrawn, so minting a replacement here would undo the
      // closing in the one message that is meant to be the owner's own. Restore it first if the
      // card is supposed to be able to send again.
      if (card.closedAt !== null) {
        return fail(
          ws,
          `${card.title} is closed, and closing a card withdraws its token. Restore the card if it ` +
            'should be able to send again, and it will be given a new one.',
          msg.t,
        )
      }
      return send(ws, { t: 'session.token', sessionId: msg.sessionId, token: tokenFor(card.id) })
    }

    case 'limits.get': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      return send(ws, limitsMessage(project.id))
    }

    /*
     * Could this card be restarted right now? A question, and only a question.
     *
     * Nothing in this branch or below it ends, starts or restarts anything. The stage that acts is
     * ordered separately and will have to ask this first; until then the answer is here so it can be
     * read, argued with, and shown on the card face.
     */
    case 'update.boundary': {
      const s = store.getSession(String(msg.sessionId ?? ''))
      if (!s) return fail(ws, 'unknown session', msg.t)
      return send(ws, { t: 'update.boundary', sessionId: s.id, result: safeBoundaryFor(s) })
    }

    /*
     * Write this card's checkpoint and say where it went.
     *
     * Also only a read of the process: it opens the card's row, its events and its mailbox, writes a
     * file, and leaves the session exactly as it was. Nothing calls it automatically.
     */
    case 'update.checkpoint': {
      const s = store.getSession(String(msg.sessionId ?? ''))
      if (!s) return fail(ws, 'unknown session', msg.t)
      const written = checkpointFor(s)
      if (!written) return fail(ws, 'this card has no memory directory to write a checkpoint into', msg.t)
      return send(ws, { t: 'update.checkpoint', sessionId: s.id, path: written.path, fields: written.fields })
    }

    case 'limits.set': {
      const project = store.getProject(msg.projectId)
      if (!project) return fail(ws, 'unknown project', msg.t)
      const l = msg.limits
      const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 200
      if (!l || !whole(l.running) || !whole(l.cardsPerProject) || !whole(l.childrenPerCard)) {
        return fail(ws, 'a limit has to be a whole number between 1 and 200', msg.t)
      }
      /*
       * The work ceiling is checked when it is sent and kept when it is not.
       *
       * Absent rather than required, because a window opened before this field existed still sends
       * the three it knows about, and refusing that would break the panel outright the first time
       * anyone touched a different number. Kept rather than defaulted, because falling back to
       * `DEFAULT_LIMITS` here would quietly reset a ceiling the owner had already chosen every time
       * he edited one of the others.
       */
      const kept = store.getLimits(project.id)
      if (l.working !== undefined && !whole(l.working)) {
        return fail(ws, 'a limit has to be a whole number between 1 and 200', msg.t)
      }
      const authority = l.taskAuthority ?? kept.taskAuthority
      if (authority !== 'off' && authority !== 'shadow' && authority !== 'enforce') {
        return fail(ws, 'task authority is off, shadow or enforce', msg.t)
      }
      if (l.silenceMinutes !== undefined && !whole(l.silenceMinutes)) {
        return fail(ws, 'a limit has to be a whole number between 1 and 200', msg.t)
      }
      /*
       * The one setting that can lock the owner out of his own board, so it is the one that needs a
       * key to turn on.
       *
       * At `enforce` a connection with neither the owner key nor a card token becomes a guest and
       * may change nothing, including this setting. A window that turned enforcement on without
       * having presented the key would therefore have made itself unable to turn it back off, and
       * the way out would have been a text editor and a restart. Refusing here means the only way to
       * reach `enforce` is from a connection that has already proved it can get back.
       */
      const who = identityOf(ws)
      if (authority === 'enforce' && !(who.kind === 'owner' && who.keyed)) {
        return fail(
          ws,
          'turning enforcement on needs the owner key, because at enforce a connection without it ' +
            'reads the board and changes nothing, and this window would not be able to turn it off ' +
            'again. Open Garden from its launcher, or from the URL the server prints at start, and ' +
            'this window will have the key.',
          msg.t,
        )
      }
      /*
       * Written as asked, including below what the board already holds. That is deliberate: the
       * ceiling governs what is created next and never reaches back to something already running,
       * so lowering it is a safe thing to do mid-task rather than a destructive one.
       */
      store.setLimits(project.id, {
        running: l.running,
        cardsPerProject: l.cardsPerProject,
        childrenPerCard: l.childrenPerCard,
        working: l.working ?? kept.working,
        taskAuthority: authority,
        silenceMinutes: l.silenceMinutes ?? kept.silenceMinutes,
        /*
         * Kept rather than taken from the message. This door predates the setting and a page that
         * does not know about it would send an object without one, which would silently reset the
         * owner's policy to the default every time anybody moved a ceiling. The setting has its own
         * door, `garden-task.mjs update-policy`, the same as `authority`.
         */
        updatePolicy: kept.updatePolicy,
      })
      // Every window, because two clients disagreeing about the ceiling is how one of them starts
      // showing refusals it cannot explain.
      return broadcast(limitsMessage(project.id))
    }

    case 'session.create': {
      // The brief travels with the request, so a card made from the board can be given one the same
      // way a hired card is. `createSession` validates and stores it; nothing here interprets it.
      createSession(msg, ws, typeof msg.roots === 'string' ? msg.roots : undefined)
      return
    }

    case 'session.input': {
      if (typeof msg.data !== 'string') return
      /*
       * A write to a dead PTY is recorded, never swallowed.
       *
       * This used to `return` bare, which is the one thing this app is not allowed to do: the line
       * left the owner's keyboard, reached the server, and stopped, and nothing anywhere said so.
       * `agent.say` three cases down always answers with a reason, so of the two ways into a card
       * one explained itself and the other was mute, and the mute one is the one the board's own
       * input line uses.
       *
       * The card is not started from here on purpose. Starting belongs to the caller that can hold
       * the text until there is a prompt to receive it, which the card's input line does: it starts
       * the session, keeps the line, waits for the byte stream to go quiet and then sends. Starting
       * a CLI from inside a keystroke handler would spawn one on a stray key and then type into a
       * process that has not drawn a prompt, which is the failure `flushMailWake` above already
       * carries three paragraphs about having cost a day.
       *
       * So this records the loss and leaves the waking to the layer that can do it honestly. The
       * text goes in the event because a dropped Enter and a dropped sentence are different losses,
       * which is the same reason `writeLater` records its own.
       */
      if (!ptys.isLive(msg.sessionId)) {
        const event = {
          id: randomUUID(),
          sessionId: msg.sessionId,
          ts: Date.now(),
          type: 'InputDropped',
          provenance: 'structured' as const,
          payload: {
            reason: 'the card has no process, so there was nothing to type into',
            text: msg.data,
          },
        }
        store.insertEvent(event)
        broadcast({ t: 'event', event })
        return
      }
      ptys.write(msg.sessionId, msg.data)
      return
    }

    case 'session.resize': {
      ptys.resize(msg.sessionId, msg.cols | 0, msg.rows | 0)
      return
    }

    case 'session.scrollback': {
      const { data, seq, cols, rows } = ptys.scrollback(msg.sessionId)
      send(ws, { t: 'session.scrollback', sessionId: msg.sessionId, data, seq, cols, rows })
      return
    }

    // Turning a session off ends the process and nothing else. The card, its position and its
    // history stay exactly where they are. The exit handler writes the final status.
    case 'session.stop': {
      const s = store.getSession(msg.sessionId)
      if (!s) return fail(ws, 'unknown session', msg.t)
      if (!ptys.isLive(s.id)) return
      ptys.kill(s.id)
      return
    }

    case 'session.start': {
      const s = store.getSession(msg.sessionId)
      if (!s) return fail(ws, 'unknown session', msg.t)
      if (ptys.isLive(s.id)) return
      try {
        const started = startSession({ ...s, status: 'starting' })
        broadcast({ t: 'session.updated', session: started })
      } catch (err) {
        fail(ws, `could not start: ${(err as Error).message}`, msg.t)
      }
      return
    }

    /**
     * Take a card off the board, keeping everything.
     *
     * The owner's model, in his words: closing puts a card in a closed list underneath the running
     * ones, and deleting from that list is what removes it from the drive. So this ends the process
     * and folds away the two blocks that belong to the card, its roots and its history, because
     * those are drawn as part of it and leaving them behind would strand cards whose owner is no
     * longer on the board. That stranding is not hypothetical: it had already happened 60 times over
     * before this existed, and none of those cards could be removed by any control in the app.
     *
     * Nothing is destroyed. The row, its notes, its mailbox, its wires and its conversation are all
     * still there, which is what makes this recoverable and delete deliberate.
     */
    /**
     * What a spawned agent actually said, for its own card.
     *
     * Read on demand rather than pushed, because a transcript is a file that grows while the agent
     * works and there is no event that means "it wrote another line". The card asks again when it
     * sees the agent's status change, which is the moment there is likely something new.
     *
     * Works for any card that has a transcript, not just subagents, so a session card can show its
     * conversation the same way when its terminal is gone.
     */
    /**
     * A line typed into a spawned agent's card, delivered to that agent.
     *
     * Routed through the parent's terminal, which is the only route the CLI offers, and only after
     * Garden has read that terminal and confirmed the right agent is selected. Every failure comes
     * back as a reason the card can show, because the one thing this must never do is appear to
     * have sent something it did not.
     */
    case 'agent.say': {
      const agent = store.getSession(msg.sessionId)
      if (!agent) return
      const answer = (ok: boolean, reason?: string) =>
        send(ws, { t: 'agent.said', sessionId: agent.id, ok, ...(reason ? { reason } : {}) })
      if (agent.kind === 'session') return answer(false, 'that card has its own terminal, so type into it directly')
      if (!agent.parentId) return answer(false, 'Garden never recorded which card hired this agent')

      reachAgent({
        ptys,
        parentId: agent.parentId,
        /*
         * The list shows an agent by its type and the description it was given, and nothing else.
         *
         * A card is titled with the description when Garden saw the dispatch that named one, and
         * with the bare agent type when it did not. Passing the title as a description in that
         * second case sent Garden looking for a row whose task read "general-purpose", which no row
         * ever does, so a perfectly reachable agent came back as finished.
         */
        agentType: agent.role || agent.title,
        /*
         * The description the LIST shows, which is not always the card's title.
         *
         * A card is titled with the dispatch description when Garden saw one, and with the agent
         * type otherwise, numbered when it is not the first of that type under the same parent.
         * That numbering is Garden's own and appears nowhere on the terminal's screen, so matching
         * on the raw title would send it looking for a row reading "general-purpose 2", which no
         * row ever says. Stripping the number back off tells the two cases apart.
         */
        description: (() => {
          const type = agent.role || agent.title
          const stripped = agent.title.replace(/\s\d+$/, '')
          return stripped === type ? null : agent.title
        })(),
        text: String(msg.text ?? ''),
        // Its own age, which is the only thing that separates two rows the screen draws alike.
        startedAt: agent.createdAt,
      })
        .then((r) => answer(r.ok, r.ok ? undefined : r.reason))
        .catch((err) => answer(false, `Garden could not reach it: ${(err as Error).message}`))
      return
    }

    case 'agent.chat': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      send(ws, { t: 'agent.chat', sessionId: s.id, turns: s.transcriptPath ? readChat(s.transcriptPath) : [] })
      return
    }

    case 'session.close': {
      const s = store.getSession(msg.sessionId)
      if (!s || s.closedAt !== null) return
      if (ptys.isLive(s.id)) ptys.kill(s.id)

      for (const web of ['context', 'history'] as const) {
        giveBackRoom(`${s.id}:${web}`)
        for (const card of store.listWebDocs(s.id, web)) {
          for (const wireId of store.deleteWiresForCard(card.id)) {
            broadcast({ t: 'wire.removed', wireId })
          }
          store.deleteDoc(card.id)
          broadcast({ t: 'doc.removed', cardId: card.id })
        }
      }

      /*
       * A closed card stops being able to send, which is the point of closing one.
       *
       * Switching a card off leaves its token alone, because the owner has to be able to hand a
       * stopped card's identity to a script and because the card is coming back. Closing is the
       * deliberate "this must not send any more", and a credential that outlived that would make
       * closing a cosmetic act. Restoring the card does not give the old token back: it gets a fresh
       * one the next time anything asks, so anything still holding the old value stays refused.
       */
      withdrawToken(s.id)

      const closed = { ...s, closedAt: Date.now() }
      store.upsertSession(closed)
      broadcast({ t: 'session.updated', session: closed })
      return
    }

    /** Back on the board, stopped, where it was. Starting it again is a separate decision. */
    case 'session.restore': {
      const s = store.getSession(msg.sessionId)
      if (!s || s.closedAt === null) return
      const back = { ...s, closedAt: null }
      store.upsertSession(back)
      broadcast({ t: 'session.updated', session: back })
      return
    }

    // The single destructive path. The renderer confirms with the owner before sending this;
    // nothing else in the server removes a session row.
    case 'session.delete': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      ptys.kill(s.id)
      for (const wireId of store.deleteWiresForCard(s.id)) {
        broadcast({ t: 'wire.removed', wireId })
      }
      // A deleted card takes its history with it. Leaving orphaned turns and events behind would
      // make the database grow forever and would attribute old work to whatever id came next.
      store.deleteWorkForSession(s.id)
      store.deleteSession(s.id)
      broadcast({ t: 'session.removed', sessionId: s.id })

      // A subagent card is the only record its dispatch ever produced, so deleting the parent
      // must not silently strand children on the board with a wire to nothing.
      for (const child of store.childSessions(s.id)) {
        for (const wireId of store.deleteWiresForCard(child.id)) {
          broadcast({ t: 'wire.removed', wireId })
        }
        store.deleteWorkForSession(child.id)
        store.deleteSession(child.id)
        broadcast({ t: 'session.removed', sessionId: child.id })
      }
      // Deleting is the one thing that gives room back, so it is the moment the ceiling most needs
      // to be re-read: a refusal the owner just saw should stop being true the instant he acts on it.
      announceLimits(s.projectId)
      return
    }

    case 'pipeline.get': {
      const s = store.getSession(msg.sessionId)
      if (!s) return fail(ws, 'unknown session', msg.t)
      send(ws, { t: 'pipeline', sessionId: s.id, runs: derivePipeline(store, s.id) })
      return
    }

    case 'work.list': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      send(ws, { t: 'work', sessionId: s.id, records: store.listWork(s.id) })
      return
    }

    case 'session.rename': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      const title = String(msg.title ?? '').trim().slice(0, 80)
      if (!title) return
      const updated = { ...s, title }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      return
    }

    case 'session.move': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      // A drag is the owner taking over. Auto-tiling stops for this project from here on, and
      // the card settles beside anything it was dropped on rather than covering it.
      const spot = nearestFree(s.projectId, s.id, {
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        w: s.width,
        h: s.collapsed ? BOARD.COLLAPSED_H : s.height,
      })
      const updated = { ...s, x: spot.x, y: spot.y, manualPos: true }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      // Its roots and its history are part of the card, so they travel with it.
      moveWebsBy(s.id, spot.x - s.x, spot.y - s.y)
      return
    }

    case 'session.setRenderState': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      const updated = { ...s, renderState: msg.renderState }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      return
    }

    case 'session.setPinned': {
      const s = store.getSession(msg.sessionId)
      if (!s) return
      const updated = { ...s, pinned: !!msg.pinned }
      store.upsertSession(updated)
      broadcast({ t: 'session.updated', session: updated })
      return
    }
  }
}

ptys.on('data', (sessionId: string, data: string, seq: number) => {
  // Noted before the broadcast, so "has this terminal gone quiet" is answered from the stream
  // itself rather than from a guess about how long a CLI takes to start.
  lastByteAt.set(sessionId, Date.now())
  broadcast({ t: 'session.data', sessionId, data, seq })
})

ptys.on('exit', ({ sessionId, exitCode, intentional }) => {
  // Whatever it was holding, it is not working on it now. Released before anything else, so a card
  // that crashed cannot leave a file flagged against the next card that needs it.
  releaseClaims(sessionId)
  const s = store.getSession(sessionId)
  if (!s) return
  const updated: TerminalSession = {
    ...s,
    /*
     * A clean exit, or one Garden asked for, is a stop rather than a disappearance. Only an
     * unexpected non-zero exit is a failure worth flagging red.
     *
     * The exception is a launch that never took. Garden ends that shell itself, which would
     * otherwise read as intentional and settle the card at "off", hiding the fact that the CLI
     * never ran at all.
     */
    status: launchFailed.delete(sessionId) ? 'failed' : intentional || exitCode === 0 ? 'stopped' : 'failed',
    pid: null,
    exitedAt: Date.now(),
    exitCode,
    // Nothing is running, so no role is in effect. Cleared rather than left behind, or a stopped
    // card would go on claiming the role of a process that ended.
    roleClassRunning: null,
  }
  store.upsertSession(updated)
  broadcast({ t: 'session.updated', session: updated })
})

/**
 * The hook receiver.
 *
 * Bound to the loopback interface only, and it can do exactly one thing: record what a CLI said
 * about itself. It never spawns anything and never names an executable, so the boundary that
 * keeps terminal output from causing a command to run is untouched by adding it.
 */
const ingest = new Ingest({
  store,
  broadcast,
  placeChild: (parent, w, h) => placeSpawnedCard(parent, w, h),
  refreshMail: (cardId) => refreshMail(cardId),
  ensureCardMemory: (session) => {
    ensureCardMemory(session)
  },
})

const http = createServer((req, res) => {
  /*
   * Where an agent hands work to another card.
   *
   * Loopback only, like the hook receiver, and it can do exactly two things: append to a mailbox
   * and record that it did. It never spawns anything and never types into a terminal, so the rule
   * that terminal output cannot cause a command to run is untouched.
   *
   * Who is sending comes from the environment variable Garden set when it spawned the shell, not
   * from anything the message claims. An agent that deliberately overrode that variable could lie
   * about which card it is, and that is written down rather than pretended away.
   */
  /*
   * Where a card asks for another card to exist.
   *
   * Loopback only, like the mail endpoint and the hook receiver, and it names no executable: it can
   * create a card or file a request, and nothing else. The boundary that keeps terminal output from
   * causing a command to run is untouched by adding it.
   *
   * Two outcomes and the server picks which, from the asker's own role rather than from anything in
   * the request. The orchestrator gets a card. Everyone else gets their request filed as mail to the
   * orchestrator, which is how a funnel stays a funnel: one card decides, and the asking is visible on
   * the board instead of happening in five places that do not count each other.
   */
  if (req.method === 'POST' && req.url === '/hire') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 512 * 1024) req.destroy()
    })
    req.on('end', () => {
      const answer = (code: number, text: string) => {
        res.writeHead(code, { 'content-type': 'text/plain' })
        res.end(text)
      }
      let msg: any
      try {
        msg = JSON.parse(body)
      } catch {
        return answer(400, 'that was not a request Garden could read')
      }

      /*
       * The token decides who is asking. `garden-hire.mjs`'s own header has said for months that
       * the server believes whatever `from` the body carries, which meant any card could ask for a
       * card in the orchestrator's name and pass the `creates` check below on its behalf.
       */
      const asker = resolveSender(req, msg)
      if (!asker.ok) return answer(asker.code, asker.reason)
      const from = asker.card
      const project = store.getProject(from.projectId)
      if (!project) return answer(404, 'that card is not on a board Garden knows')

      const mayCreate = !!(from.roleClass && ROLE_POWERS[from.roleClass]?.creates)

      if (msg?.action === 'start') {
        const card = store.getSession(String(msg?.cardId ?? ''))
        if (!card || card.projectId !== project.id) return answer(404, 'no card here with that id')
        if (!mayCreate) {
          return answer(403, `only the orchestrator starts cards. Ask it, and it will answer along the wire.`)
        }
        if (ptys.isLive(card.id)) return answer(200, `"${card.title}" is already running.`)
        const refusal = overCeiling(project.id, null, true)
        if (refusal) {
          recordCeilingRefusal(from.id, null, card.title, refusal)
          return answer(409, refusal.said)
        }
        try {
          broadcast({ t: 'session.updated', session: startSession({ ...card, status: 'starting' }) })
          return answer(200, `started "${card.title}".`)
        } catch (err) {
          return answer(500, `could not start "${card.title}": ${(err as Error).message}`)
        }
      }

      const title = String(msg?.title ?? '').trim()
      const role = String(msg?.role ?? '').trim()
      const roots = String(msg?.roots ?? '').trim()
      if (!title) return answer(400, 'a card needs a title')
      if (!ROLE_POWERS[role]) {
        return answer(400, `there is no "${role}" role. Garden has: ${Object.keys(ROLE_POWERS).join(', ')}.`)
      }
      if (!roots) return answer(400, 'a card needs roots. Say what it is for, on stdin.')

      /*
       * Not the orchestrator, so this is a request rather than a creation.
       *
       * Filed as real mail rather than into a queue table, because Garden never injects anything
       * into a prompt and the only thing that already makes a card look at something is its
       * mailbox. A queue would need the waking, the starting and the quiet-check rebuilt around it,
       * all of which mail already has.
       */
      if (!mayCreate) {
        const orchestrator = store
          .listSessions()
          .find(
            (s) =>
              s.projectId === project.id &&
              s.closedAt === null &&
              s.roleClass &&
              ROLE_POWERS[s.roleClass]?.creates,
          )
        if (!orchestrator) {
          return answer(
            409,
            'Nothing was created, and there is no orchestrator card on this board to ask. ' +
              'The owner has to make one before any card can hire.',
          )
        }

        /*
         * A wire, if there is not one already. The request has to travel somewhere the owner can
         * see, and a wire is what a message travels on, so asking creates the line rather than
         * going around it.
         */
        let wire = store.findWire(from.id, orchestrator.id) ?? store.findWire(orchestrator.id, from.id)
        if (!wire) {
          wire = {
            id: randomUUID(),
            projectId: project.id,
            sourceId: from.id,
            targetId: orchestrator.id,
            label: 'hire request',
            kind: 'manual',
            bidirectional: true,
            createdAt: Date.now(),
          }
          store.upsertWire(wire)
          broadcast({ t: 'wire.added', wire })
          refreshMail(from.id)
          refreshMail(orchestrator.id)
        }

        const ticket = `H-${randomUUID().slice(0, 4)}`
        const ask =
          `Hire request ${ticket} from "${from.title}".\n\n` +
          `Title: ${title}\nRole: ${role}\n` +
          `Answers to: ${msg?.reportsTo ? store.getSession(String(msg.reportsTo))?.title ?? msg.reportsTo : from.title}\n\n` +
          `Roots it asked for:\n\n${roots}\n\n` +
          'Create it with GARDEN_HIRE if you agree, adjusting anything you disagree with, or reply ' +
          'along this wire saying why not.'
        postMessage(orchestrator, from.title, ask, { kind: 'question', fromId: from.id })
        const outcome = wakeForMail(orchestrator.id)
        recordSent(from.id, orchestrator.title, ask, { kind: 'question', outcome: SENT_NOTE[outcome] })

        const event: AgentEvent = {
          id: randomUUID(),
          sessionId: orchestrator.id,
          ts: Date.now(),
          type: 'hire.requested',
          provenance: 'structured',
          payload: { by: from.title, byId: from.id, title, role, ticket },
        }
        store.insertEvent(event)
        broadcast({ t: 'event', event })
        broadcast({ t: 'wire.pulse', wireId: wire.id, kind: wire.kind })

        return answer(
          200,
          `Filed as ${ticket}. "${orchestrator.title}" has your request and nothing has been created. ` +
            `It will answer along the wire. (${SENT_NOTE[outcome]})`,
        )
      }

      /*
       * The orchestrator, so the card is made. Switched off, always: laying it out costs nothing, and
       * starting it is a separate decision with its own line in the ceiling.
       */
      const parent = msg?.reportsTo ? store.getSession(String(msg.reportsTo)) : null
      const refusal = overCeiling(project.id, parent ?? null, false)
      if (refusal) {
        recordCeilingRefusal(from.id, parent ?? null, title, refusal)
        return answer(409, refusal.said)
      }

      /*
       * Through the same function the board's own right-click runs, with a stand-in for the socket.
       *
       * The refusal text this produces is written for whoever asked, so it is captured and handed
       * back as the endpoint's answer rather than being dropped on the floor. Nothing about card
       * creation is reimplemented here: the ceiling, the role check, the reporting wire, the brief
       * and the placement are all one code path, which is the only way they stay in agreement.
       */
      let refused: string | null = null
      const capture = {
        readyState: 1,
        send: (raw: string) => {
          try {
            const parsed = JSON.parse(raw)
            if (parsed?.t === 'error') refused = String(parsed.message)
          } catch {
            // Not something this endpoint has anything to say about.
          }
        },
      } as unknown as WebSocket

      const created = createSession(
        {
          t: 'session.create',
          projectId: project.id,
          adapterId: isAdapterId(msg?.adapterId) ? msg.adapterId : 'claude',
          title,
          roleClass: role as never,
          reportsTo: parent && parent.projectId === project.id ? parent.id : null,
          modelChoice: msg?.model ? String(msg.model) : null,
          effortChoice: msg?.effort ? String(msg.effort) : null,
          teamSize: typeof msg?.teamSize === 'number' && Number.isFinite(msg.teamSize) ? msg.teamSize : null,
          ownedPaths:
            Array.isArray(msg?.ownedPaths) && msg.ownedPaths.length ? msg.ownedPaths.map(String) : null,
          // Off, always. Laying a card out costs nothing and starting it is its own decision with
          // its own line in the ceiling, so hiring never quietly spends a context window.
          start: false,
          by: from.id,
        },
        capture,
        roots,
      )

      if (!created) return answer(409, refused ?? 'Garden refused to create that card.')

      return answer(
        200,
        `Created "${created.title}" as ${created.id}, switched off, with its roots on disk. ` +
          `Start it with --start ${created.id} when you want it working.`,
      )
    })
    return
  }

  if (req.method === 'POST' && req.url === '/mail') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 512 * 1024) req.destroy()
    })
    req.on('end', () => {
      const answer = (code: number, text: string) => {
        res.writeHead(code, { 'content-type': 'text/plain' })
        res.end(text)
      }
      let msg: any
      try {
        msg = JSON.parse(body)
      } catch {
        return answer(400, 'that was not a message Garden could read')
      }

      /*
       * Who this is from, decided by the token Garden minted rather than by the field in the body.
       * Every check below, wire included, is then applied to the card that actually ran the shim.
       */
      const sender = resolveSender(req, msg)
      if (!sender.ok) return answer(sender.code, sender.reason)
      const from = sender.card

      const wanted = String(msg?.to ?? '').trim()
      const inProject = store.listSessions().filter((x) => x.projectId === from.projectId)
      /*
       * A card on the board wins a name over one that has been closed.
       *
       * Titles are not unique and closing does not free one up, so a board that has had a "Boss"
       * closed and a new "Boss" made has two cards answering to the name. Matching in row order
       * picked whichever was older, which was the closed one, and the sender was told its message
       * had gone to a card nobody was reading while the live card of that name sat there waiting.
       * Watched happen during a live demonstration, which is the only reason it was found.
       *
       * An id still wins outright, and a closed card can still be addressed by name when it is the
       * only one with it, so nothing that used to work stops working.
       */
      const open = inProject.filter((x) => x.closedAt === null)
      const byName = (list: TerminalSession[]) => list.find((x) => x.title.toLowerCase() === wanted.toLowerCase())
      const to = inProject.find((x) => x.id === wanted) ?? byName(open) ?? byName(inProject)
      if (!to) {
        return answer(404, `no card called "${wanted}" on this board. Your PEERS.md lists who you may send to.`)
      }
      if (to.id === from.id) return answer(400, 'a card cannot send to itself')

      const rawKind = String(msg?.kind ?? 'work')
      if (!isMailKind(rawKind)) {
        return answer(
          400,
          `"${rawKind}" is not a kind of message Garden knows. Use one of: ${Object.keys(MAIL_KINDS).join(', ')}.`,
        )
      }
      const kind: MailKind = rawKind
      const taskId = msg?.taskId ? String(msg.taskId).slice(0, 60) : null
      const text = String(msg?.text ?? '').trim()
      if (!text) return answer(400, 'there was nothing in the message')

      /*
       * A closed card is one the owner has taken off the board.
       *
       * The message still goes into its inbox, because an inbox is a record and the startup brief
       * hands it over when the card comes back. What must not happen is the wake: starting a closed
       * card would spend money on an agent he had deliberately put down, and it would then appear
       * under "Running now" and under "Closed cards" at the same time, with the two disagreeing.
       * The sender is told plainly rather than left to assume somebody is reading.
       */
      if (to.closedAt !== null) {
        postMessage(to, from.title, text, { kind, taskId, fromId: from.id })
        recordSent(from.id, to.title, text, { kind, taskId, outcome: 'the card is closed, nothing is reading it' })
        return answer(
          200,
          `"${to.title}" is closed, so nobody is reading it right now. Your message is in its inbox and ` +
            'it will see it when the owner puts the card back on the board.',
        )
      }

      /*
       * A wire is what permits a message, which is the whole reason the chain is drawn rather than
       * configured. A one-way wire carries only the way its arrow points.
       */
      const forward = store.findWire(from.id, to.id)
      const backward = store.findWire(to.id, from.id)
      const wire = forward ?? (backward?.bidirectional ? backward : undefined)
      if (!wire) {
        const refusal = backward
          ? `"${to.title}" sends to you on that wire, and it is one way, so you cannot send back along it.`
          : `there is no wire from you to "${to.title}". Draw one on the board first, or send to a card in your PEERS.md.`
        recordRefusal(from, to, kind, taskId, refusal)
        return answer(403, refusal)
      }

      /*
       * Ownership: whether this card may say this about this task at all.
       *
       * After the wire check and before the two older guards, which is the order canon 20 asks for
       * and also the order that gives the most useful refusal: no wire is a fact about the board,
       * and everything below it is a fact about this particular task.
       *
       * In `shadow` the refusal is recorded and the message goes anyway, so the owner reads a list
       * of what would have stopped before anything stops. In `off` nothing here runs at all.
       */
      const authority = authorityFor(from.projectId)
      let nextState: TaskState | undefined
      if (authority !== 'off') {
        const task = taskId ? store.getTask(from.projectId, taskId) : undefined
        const verdict = ownershipGuard(task, kind, from.id, to.id, taskId, participantsFor, {
          titleOf,
          reportsToOf,
        })
        if (!verdict.allowed) {
          recordTaskEvent(from.id, authority === 'enforce' ? 'TaskRefused' : 'TaskWouldRefuse', {
            taskId,
            kind,
            rule: verdict.rule,
            reason: verdict.reason,
            to: to.id,
          })
          if (authority === 'enforce') return answer(403, verdict.reason)
        } else {
          nextState = verdict.next
        }
      }

      // The rule that stops a task going round the review loop forever.
      const hops = taskId ? hopsForTask(store, from.projectId, taskId) : []
      const guard = spiralGuard(hops, kind, MAX_REVIEW_ROUNDS)
      if (!guard.allowed) {
        recordRefusal(from, to, kind, taskId, guard.reason)
        return answer(409, guard.reason)
      }

      /*
       * And the rule that stops it travelling up unread. A card that was told something is done
       * answers the card that told it before it speaks for that work any further.
       */
      const owed = confirmGuard(hops, from.id, kind)
      if (!owed.allowed) {
        recordRefusal(from, to, kind, taskId, owed.reason)
        return answer(409, owed.reason)
      }

      /*
       * Wake first, then record, then answer, and all three say the same thing.
       *
       * The order was the other way around: the inbox was appended, SENT.md was written, the sender
       * was told "delivered to X", and only then did anything try to reach the card. So "delivered"
       * meant a file had been written, which is not what the word means to the agent reading it. A
       * card with no process, a card mid-restart, and a card that read the message and replied all
       * produced the same sentence and the same record.
       */
      postMessage(to, from.title, text, { kind, taskId, fromId: from.id })
      const outcome = wakeForMail(to.id)
      recordSent(from.id, to.title, text, { kind, taskId, outcome: SENT_NOTE[outcome] })
      const event = {
        id: randomUUID(),
        sessionId: to.id,
        ts: Date.now(),
        type: 'MailDelivered',
        provenance: 'structured' as const,
        payload: { from: from.id, fromTitle: from.title, wireId: wire.id, kind, taskId, text: text.slice(0, 4000) },
      }
      store.insertEvent(event)
      broadcast({ t: 'event', event })
      broadcast({ t: 'wire.pulse', wireId: wire.id, kind: wire.kind })

      /*
       * The task moves because a hand-off actually happened, not because anybody said it did. Only
       * written after the delivery above, so a message that was refused for any reason leaves the
       * contract exactly where it was.
       */
      if (nextState && taskId) {
        const held = store.getTask(from.projectId, taskId)
        if (held) {
          store.upsertTask({ ...held, state: nextState, updatedAt: Date.now() })
          const moved = store.getTask(from.projectId, taskId)!
          broadcast({ t: 'task.updated', task: moved })
        }
      }

      /*
       * Work coming home. When a done reaches an orchestrator, the report the owner asked for is
       * assembled and put on the board beside that card: the summary the finishing card wrote, the
       * reviewer's notes, and the files that were actually written.
       */
      if ((kind === 'done' || kind === 'assessment') && to.roleClass === 'orchestrator' && taskId) {
        try {
          openCompletionReport(to, taskId)
        } catch (err) {
          console.error('[garden] could not assemble the report:', (err as Error).message)
        }
      }

      return answer(200, ANSWER_FOR[outcome](to.title))
    })
    return
  }

  if (req.method === 'POST' && req.url === '/hook') {
    let body = ''
    let tooBig = false
    req.on('data', (chunk) => {
      body += chunk
      // A hook that tries to post a whole transcript gets dropped rather than buffered.
      if (body.length > 4 * 1024 * 1024) {
        tooBig = true
        req.destroy()
      }
    })
    req.on('end', () => {
      // Answered before the work, because a hook is holding a terminal open until this returns.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      if (tooBig) return
      try {
        ingest.handle(JSON.parse(body))
      } catch (err) {
        console.error('[garden] hook rejected:', (err as Error).message)
      }
    })
    return
  }

  /*
   * A temporary flag over a file somebody is working on.
   *
   * The owner's words: if an agent is working on a file someone else owns, put a temporary flag
   * over that work so concurrent work does not happen and cause errors. This is the in-app version
   * of the claim files he already keeps by hand in `.claude/sessions/` when he runs several
   * sessions against one checkout, and it is a better fit for a board than fencing each card into
   * a fixed list: real work reaches across several files, and what actually breaks is two cards
   * landing on the SAME file, not one card touching many.
   *
   * A claim is held by a card, not by a process, and it lapses on its own. Nothing here can tell
   * when an agent has finished with a file, so a permanent lock would slowly seize the board as
   * cards moved on and left flags behind. It expires, and it is released outright when the card
   * stops, so the failure direction is always "the flag went away too early", which costs a
   * collision that the owner can see, rather than "the flag stayed forever", which costs a board
   * nobody can work on and no way to tell why.
   *
   * Its own endpoint rather than a decision on `/hook`, because that one answers before it does its
   * work so a hook never holds a terminal open, and a decision has to be computed before replying.
   * This lookup is an in-memory map, so it costs nothing worth measuring.
   */
  /**
   * The task contract, over HTTP, for the cards.
   *
   * The twin of the `task.*` socket messages, and every op below is literally the same function, so
   * "may this card reassign a task" has one answer rather than one per door. That is the shape canon
   * 20 asks for after "only the orchestrator creates cards" turned out to hold on `/hire` and not on
   * `session.create`.
   */
  if (req.method === 'POST' && req.url === '/task') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 512 * 1024) req.destroy()
    })
    req.on('end', () => {
      const answer = (code: number, text: string) => {
        res.writeHead(code, { 'content-type': 'text/plain' })
        res.end(text)
      }
      let msg: any
      try {
        msg = JSON.parse(body)
      } catch {
        return answer(400, 'that was not a request Garden could read')
      }

      const op = String(msg?.op ?? '')

      /*
       * The owner reaching this door with his own hands, for the one setting that used to be a pair
       * of radio buttons in the sidebar.
       *
       * Only for `authority`, and only with the key the server wrote at start. Every other op here
       * acts as a card, which is the ownership plane's whole point; this one is the owner's own
       * setting, and taking the buttons off the page without leaving him a way to reach it from a
       * terminal would have removed the control rather than moved it. The key travels in a header of
       * its own so a stale card token and the owner's key can never be confused for one another.
       */
      const offeredKey = req.headers['x-garden-owner-key']
      /*
       * `update-policy` joins `authority` here for the same reason and on the same terms: it is
       * board policy rather than one card's setting, it has no panel, and the owner has to be able
       * to reach it from a terminal with the key the server printed.
       */
      const ownerSettings = op === 'authority' || op === 'update-policy'
      const keyed =
        ownerSettings && typeof offeredKey === 'string' && offeredKey.trim() === ownerKey()

      let actor: TerminalSession | null = null
      let projectId: string
      if (keyed) {
        const named = String(msg?.projectId ?? '').trim()
        const projects = store.listProjects()
        const chosen = named ? projects.find((p) => p.id === named) : projects.length === 1 ? projects[0] : undefined
        if (!chosen) {
          return answer(
            400,
            named
              ? `no project ${named} on this board`
              : `this board has ${projects.length} projects, so name the one you mean with --project <id>. ` +
                  `They are: ${projects.map((p) => `${p.id} (${p.name})`).join(', ')}`,
          )
        }
        projectId = chosen.id
      } else {
        const sender = resolveSender(req, msg)
        if (!sender.ok) return answer(sender.code, sender.reason)
        actor = sender.card
        projectId = actor.projectId
      }
      const result: OpResult =
        op === 'create'
          ? taskCreate(actor, projectId, msg.task ?? msg)
          : op === 'bind'
            ? taskBind(actor, projectId, msg)
            : op === 'reassign'
              ? taskReassign(actor, projectId, msg)
              : op === 'split'
                ? taskSplit(actor, projectId, msg)
                : op === 'verifier'
                  ? taskVerifier(actor, projectId, msg)
                  : op === 'show'
                    ? taskShow(projectId, String(msg?.taskId ?? ''))
                    : op === 'authority'
                      ? taskAuthorityOp(actor, projectId, keyed, msg)
                      : op === 'update-policy'
                        ? updatePolicyOp(actor, projectId, keyed, msg)
                        : {
                            ok: false,
                            code: 400,
                            reason:
                              `"${op}" is not something garden-task does. The ops are create, bind, reassign, ` +
                              'split, verifier, show, authority and update-policy.',
                          }

      if (!result.ok) {
        const asked = op === 'create' ? (msg.task?.id ?? msg.id) : msg?.taskId
        recordTaskPlaneRefusal(actor, op || 'unknown', asked ? String(asked) : null, result.reason)
        return answer(result.code, result.reason)
      }
      if (result.text) return answer(200, result.text)
      const t = result.task
      return answer(200, t ? `task ${t.id} is ${t.state}, owned by ${titleOf(t.ownerId)}` : 'done')
    })
    return
  }

  if (req.method === 'POST' && req.url === '/claim') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 64 * 1024) req.destroy()
    })
    req.on('end', () => {
      const reply = (obj: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      let msg: any
      try {
        msg = JSON.parse(body)
      } catch {
        // Unreadable means no opinion. A card must never be blocked by this failing to parse.
        return reply({ ok: true })
      }
      const path = String(msg?.path ?? '').trim()
      if (!path) return reply({ ok: true })

      /*
       * Which card is writing, from its token, exactly as `/mail` and `/task` decide it.
       *
       * This door used to believe `gardenSessionId` out of the body, which made the territory check
       * below it a check on whichever card the writer said it was. The hook now sends the card's
       * token with the claim, and the body id is only reached when there is no token and the project
       * is not enforcing, which is `resolveSender`'s own rule rather than a second copy of it.
       *
       * A body naming no card Garden knows still ends in silence rather than a refusal: that is the
       * ordinary state of a CLI running outside a card, and this door has never had an opinion about
       * one. A card that is known and cannot be proved is refused only under `enforce`, where being
       * unable to tell who is writing is the thing enforcement is for.
       */
      const sender = resolveSender(req, { from: String(msg?.gardenSessionId ?? ''), kind: 'write' })
      if (!sender.ok) return sender.code === 404 ? reply({ ok: true }) : reply({ deny: sender.reason })
      const card = sender.card

      /*
       * The task's own territory, checked before the two-cards-in-one-file flag below it.
       *
       * A different question from `GARDEN_OWNED_PATHS`, which is what the card is responsible for in
       * general. This is what the work it is holding right now may touch, which is narrower and
       * changes as tasks come and go. A card with no active task carrying a territory is unaffected,
       * which is every card on this board today.
       *
       * Governed by `taskAuthority` like everything else: in shadow it is recorded and allowed, so
       * the owner can see what would have been stopped before a refusal costs anybody a turn.
       */
      const active = store.activeTasksFor(card.id).filter((t) => t.territory.length > 0)
      if (active.length > 0 && !active.some((t) => pathInsideAny(path, t.territory))) {
        const t = active[0]!
        const refusal =
          `${path} is outside the territory of ${t.id}, which is ${t.territory.join(', ')}. That task ` +
          'is what this card is holding right now, so that is what it may write. If the work really ' +
          'does reach this file, ask the card that assigned it to widen the territory or to split the ' +
          'task so this part has an owner.'
        const authority = authorityFor(card.projectId)
        if (authority !== 'off') {
          recordTaskEvent(card.id, authority === 'enforce' ? 'TaskRefused' : 'TaskWouldRefuse', {
            taskId: t.id,
            kind: 'write',
            rule: 'outside-territory',
            reason: refusal,
            to: null,
          })
        }
        if (authority === 'enforce') return reply({ deny: refusal })
      }

      const key = path.replace(/\\/g, '/').toLowerCase()
      const now = Date.now()
      const held = fileClaims.get(key)

      if (held && held.cardId !== card.id && now - held.at < CLAIM_TTL_MS && ptys.isLive(held.cardId)) {
        const mins = Math.max(1, Math.round((now - held.at) / 60000))
        return reply({
          deny:
            `"${held.title}" is working on ${path} right now, and started ${mins} minute${mins === 1 ? '' : 's'} ago. ` +
            'Two cards editing one file is what this flag exists to prevent. Send that card a message on your ' +
            'wire and agree who takes it, or work on something else and come back to it.',
        })
      }

      fileClaims.set(key, { cardId: card.id, title: card.title, at: now })
      reply({ ok: true })
    })
    return
  }

  // Images are fetched by CARD ID. The server resolves the path from its own record, so the
  // renderer can no more reach an arbitrary file here than it can over the socket.
  const fileMatch = req.url && /^\/file\/([\w-]+)$/.exec(req.url)
  if (fileMatch) {
    const card = store.getDoc(fileMatch[1]!)
    if (!card) {
      res.writeHead(404)
      return res.end()
    }
    const project = store.getProject(card.projectId)
    if (!project) {
      res.writeHead(404)
      return res.end()
    }
    let abs: string
    try {
      abs = card.external ? card.relPath : safeJoin(project.path, card.relPath)
    } catch {
      res.writeHead(403)
      return res.end()
    }
    res.writeHead(200, { 'content-type': contentTypeOf(abs), 'cache-control': 'no-cache' })
    createReadStream(abs).on('error', () => res.end()).pipe(res)
    return
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessions: store.listSessions().length, app: builtAppExists(), build: BUILD }))
    return
  }

  if (serveBuiltApp(req, res)) return

  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: http, path: WS_PATH })

/**
 * Sockets that answered the last sweep. A client that misses one is dropped.
 *
 * The server's half of the same problem the page has: a half-open connection stays `OPEN` at this
 * end too, so `clients` filled up with sockets to browser windows that no longer existed, and every
 * broadcast serialised itself into them. Terminal bytes are the highest-volume thing here, so a
 * handful of ghost clients is a real per-chunk cost on the same thread that reads the PTYs.
 *
 * `ping` is right here where `pulse` was not, because Node's ws does surface the pong.
 */
const alive = new WeakSet<WebSocket>()

setInterval(() => {
  for (const ws of clients) {
    if (!alive.has(ws)) {
      clients.delete(ws)
      ws.terminate()
      continue
    }
    alive.delete(ws)
    try {
      ws.ping()
    } catch {
      // Already gone; the next sweep collects it.
    }
  }
}, 15_000).unref?.()

wss.on('connection', (ws) => {
  clients.add(ws)
  alive.add(ws)
  ws.on('pong', () => alive.add(ws))
  // A client that talks is a client that is there, so an active board never needs the pong.
  ws.on('message', () => alive.add(ws))
  ws.on('message', (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return fail(ws, 'malformed message')
    }
    if (!msg || typeof (msg as any).t !== 'string') return fail(ws, 'missing message type')
    try {
      handle(ws, msg)
    } catch (err) {
      fail(ws, (err as Error).message, (msg as any).t)
    }
  })
  ws.on('close', () => clients.delete(ws))
})

watchSessionFiles({
  store,
  // Every directory an account could be signed in to, since a project's account decides which
  // one its sessions write into.
  configDirs: () => {
    const dirs = new Set<string>([defaultConfigDir()])
    for (const p of store.listProfiles()) if (p.configDir) dirs.add(p.configDir)
    return [...dirs]
  },
  onChange: (session) => broadcast({ t: 'session.updated', session }),
})

/*
 * Keep the context gauge current on every session that is still alive.
 *
 * The transcript is the only place the CLI publishes token counts, and it is written some time
 * after the turn that produced them. So this re-reads it periodically rather than once, which is
 * the difference between a gauge that fills and one that is blank forever. Reading a file that
 * has not changed costs nothing worth measuring, and a session with no readable transcript keeps
 * a blank gauge rather than a stale one.
 */
setInterval(() => {
  for (const s of store.listSessions()) {
    if (s.pid === null || s.adapterId !== 'claude') continue
    ingest.refreshUsage(s.id)
  }
}, 20_000).unref?.()

/*
 * Read the token counter the CLI is already printing, once a second.
 *
 * The transcript is the exact source and it is written well after a turn ends, so on its own it
 * leaves the gauge blank for exactly the stretch the owner wants to watch. The CLI prints a
 * running figure on its own spinner and in its agent tree, and Garden holds the very bytes those
 * lines are drawn from, so it reads them. A second of lag is not worth engineering away.
 *
 * A number from the terminal never overwrites one from the transcript, and the card records which
 * of the two it is showing.
 */
const tallies = new Map<string, TokenTally>()

setInterval(() => {
  for (const session of store.listSessions()) {
    /*
     * A live process, checked against the process table rather than the row.
     *
     * The row's pid is what Garden last recorded, and scrollback now falls back to the copy on disk
     * so a card's terminal survives a restart. Those two together would have fed a dead card's
     * restored bytes into this reader on every tick, and the gauge would have kept reporting a
     * token count from a run that ended, climbing or frozen, with nothing saying it was history.
     */
    if (!ptys.isLive(session.id)) continue
    // The tail, not the whole buffer. The figures this looks for are drawn at the bottom of the
    // screen, so the rest never held an answer it does not already have. Measured at about 0.10 ms
    // per full-buffer scan, so this was never the stutter it looked like; see `TOKEN_TAIL_BYTES`.
    const data = ptys.tail(session.id)
    if (!data) continue

    const reading = readTokens(data)
    const tally = tallies.get(session.id) ?? new TokenTally()
    tallies.set(session.id, tally)
    const total = tally.observe(reading.turn)
    if (total === null) continue

    // The transcript is the better source when it has spoken, so this only fills a gap.
    if (session.contextSource === 'transcript') continue
    if (session.tokensUsed === total) continue

    const updated: TerminalSession = {
      ...session,
      tokensUsed: total,
      contextUsed: fractionOf(total, session.model ?? session.modelChoice),
      contextSource: 'terminal',
    }
    store.upsertSession(updated)
    broadcast({ t: 'session.updated', session: updated })

    /*
     * The agent tree names each running agent and what it has spent, so a subagent card can carry
     * its own figure rather than sharing its parent's. Matched on the card title, which is what
     * the tree prints, and skipped entirely when no row matches: a subagent whose name Garden
     * cannot find keeps a blank gauge rather than borrowing someone else's number.
     */
    for (const child of store.childSessions(session.id)) {
      const spent = reading.agents.get(child.title)
      if (spent === undefined || child.tokensUsed === spent) continue
      const c: TerminalSession = {
        ...child,
        tokensUsed: spent,
        // A hired agent runs on whatever its parent was launched under, so the parent's model is
        // the honest denominator for it. Its own row carries no model of its own to read.
        contextUsed: fractionOf(spent, session.model ?? session.modelChoice),
        contextSource: 'terminal',
      }
      store.upsertSession(c)
      broadcast({ t: 'session.updated', session: c })
    }
  }
}, 1000).unref?.()

/*
 * Notice when a card has answered in its message file.
 *
 * The card replies by appending with its ordinary file writing tools, which fires no hook and sends
 * Garden nothing, so the only way to know is to look. A stat per channel per second, and a read only
 * when the mtime has actually moved: a board with a handful of channels costs a handful of stats,
 * and the alternative is the owner refreshing to find out whether he has been answered.
 */
setInterval(() => {
  for (const channel of store.listChannels()) {
    if (!channel.path) continue
    let at = 0
    try {
      at = statSync(channel.path).mtimeMs
    } catch {
      // Deleted or not written yet. Nothing to push, and not an error worth reporting every second.
      continue
    }
    if (channelSeen.get(channel.id) === at) continue
    pushChannelText(channel)
  }
}, 1000).unref?.()

/*
 * Copy transcripts into Garden's own store before the CLI's thirty day retention deletes them.
 *
 * Every six hours, and cheap on repeat runs: it stats files and only reads one that is new or has
 * grown. The archive is the difference between a subagent card that can show what its agent did
 * and one that can only show that it existed, and that difference expires on a rolling window
 * whether or not anybody is looking.
 */
startArchiver(store, 6 * 60 * 60 * 1000)

/**
 * Keep fourteen days of events and let the rest go, a batch at a time.
 *
 * The reasoning and the cost are in `store.pruneEventsBatch` and in
 * `docs/canonical/09-what-is-stored.md`. What lives here is the pacing: batches with a gap between
 * them, capped per sweep, so the first pass over a backlog is spread across minutes of idle time
 * instead of taking one long write lock. A board that stops answering while it tidies itself is
 * worse than a large table, which is not a guess; it happened on 2026-09-08.
 */
const EVENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
async function sweepEvents() {
  let removed = 0
  // Enough to clear a normal day many times over, and a hard stop so a huge backlog drains across
  // several sweeps rather than in one sitting.
  for (let i = 0; i < 50; i++) {
    const n = store.pruneEventsBatch(EVENT_RETENTION_MS)
    removed += n
    if (n === 0) break
    await new Promise((r) => setTimeout(r, 250).unref?.())
  }
  if (removed) console.log(`[garden] pruned ${removed} events older than 14 days`)
}
// First sweep a few minutes in, so a launch is never competing with it, then once a day.
setTimeout(() => {
  void sweepEvents()
  setInterval(() => void sweepEvents(), 24 * 60 * 60 * 1000).unref?.()
}, 5 * 60 * 1000).unref?.()

// The CLI writes the account file, so Garden watches for it rather than assuming it is told.
// Signing in to a fresh profile should show up on the tab within a few seconds.
setInterval(() => {
  const before = JSON.stringify(store.listProfiles().map((p) => p.accountEmail))
  refreshProfiles()
  const after = JSON.stringify(store.listProfiles().map((p) => p.accountEmail))
  if (before !== after) broadcast({ t: 'profiles', profiles: store.listProfiles(), defaultAccount: readAccount(defaultConfigDir()) })
}, 5000)

http.listen(port, '127.0.0.1', () => {
  console.log(`[garden] server on http://127.0.0.1:${port}  ws${WS_PATH}`)
  console.log(`[garden] hooks installed at ${hookSettingsFile}`)
  /*
   * Printed once, at start, and nowhere else. This is how a browser tab proves it is the owner's
   * rather than a card's, and it is written to `~/.garden/owner.key` so it survives a restart. It is
   * not a secret from anything running on this machine, and canon 20 says so plainly: every card
   * runs as the same Windows user, so a card that goes looking can read the file. What it stops is a
   * card being the owner by omission, which is what a keyless loopback socket was doing.
   */
  /*
   * The key travels in the fragment, which is the flow canon 20 has described since revision 1 and
   * which nothing had ever built. The paste field in the sidebar was standing in for this line.
   *
   * A fragment is not sent with the request. It never reaches this server, never reaches an access
   * log and never reaches a proxy, which is what makes the URL bar an acceptable place to carry it;
   * a query string would be in every log line of the page load. The page reads it once and strips it.
   *
   * Which port serves the board is not always this one: the built app is served from here, and
   * without a build the UI is on the dev server, 5177 unless `GARDEN_WEB_PORT` says otherwise, which
   * is the port `scripts/launch.ps1` opens.
   */
  const boardPort = builtAppExists() ? port : Number(process.env.GARDEN_WEB_PORT) || 5177
  console.log(`[garden] open the board: http://localhost:${boardPort}/#key=${ownerKey()}`)
  /*
   * Say which app this is serving, because the two modes fail in opposite directions and both look
   * fine from the outside. On the build, an edit to the source changes nothing until a rebuild. On
   * the dev server, an edit restarts this process and every terminal dies with it.
   */
  if (builtAppExists()) {
    console.log(`[garden] serving the built app at http://127.0.0.1:${port}/  (edits need "npm run stable" again)`)
  } else {
    console.log('[garden] no built app found, so the UI is wherever Vite is serving it')
  }
  if (process.env.GARDEN_HOME) console.log(`[garden] workspace ${DATA_DIR}`)
  revive()
})

/**
 * Start the cards that were running when the backend went down.
 *
 * `markAllExitedOnBoot` hands back that list at the top of this file, and until now the list was
 * computed and dropped on the floor: a comment up there has been promising this function since the
 * day the owner asked for it, and there was nothing behind the promise. His words were "the only
 * thing that should kill the board is if i kill all or a major update, but u should restart it to
 * live state not just kill it leaving me hanging", and every restart left him hanging.
 *
 * What comes up is a new process resuming the old conversation, never the old process: a Windows
 * process cannot be re-parented into a new instance of this server. The distinction is the whole
 * reason `markAllExitedOnBoot` marks everything stopped first. Garden may say it brought the card
 * back. It may never say the session survived.
 *
 * Spaced out rather than fired at once. Each start writes a settings file, seeds a roots directory
 * and spawns a shell and a CLI, and doing five of those inside one tick of the event loop is a
 * second of a frozen board on the one occasion the owner is definitely watching. The stagger also
 * gives each CLI's `SessionStart` hook time to land before the next one asks the same server for
 * the same files.
 *
 * `GARDEN_REVIVE=0` turns it off, because a server that spawns processes when it boots needs a way
 * to boot without doing that, and a code change is not a way.
 */
/**
 * Which of the cards that were live are worth starting again.
 *
 * `idle` means the card is at its prompt with nothing in hand. Starting one back up buys nothing: it
 * pays a cold start, reads its roots, and sits at a prompt again. And because idle is most of a
 * mature board, reviving it is exactly what made a restart cost more every time a card was added.
 * The owner put it plainly: widening the stagger "is just going to be the same problem +1 more card
 * if u add a role and reset".
 *
 * Nothing is stranded by leaving one down. Mail wakes a card in any state, with retries, and
 * `resumeIdFor` reopens its conversation, so a card that is needed comes back the moment something
 * needs it, one at a time, spaced by real work instead of by a timer.
 *
 * Everything else may be holding something. `working` plainly is, `starting` was on its way to, and
 * `needs-input` is BLOCKED rather than empty: it can be a card stopped at a permission prompt in the
 * middle of a job, which nothing will mail because nobody is waiting on it.
 *
 * `needs-input` is the soft one. On 2026-08-24 all five cards in that state turned out to be idle at
 * a prompt rather than blocked mid-task, so this may want tightening. It is not being tightened on
 * one day's evidence: being wrong that way strands a job nobody notices, and being wrong the other
 * way costs one unnecessary start.
 */
const WORTH_REVIVING = new Set(['working', 'starting', 'needs-input'])

function revive() {
  if (process.env.GARDEN_REVIVE === '0') return
  const skipped = wereLive.filter((w) => !WORTH_REVIVING.has(w.status)).length
  if (skipped) {
    console.log(
      `[garden] leaving ${skipped} idle card${skipped === 1 ? '' : 's'} down; ` +
        'mail wakes them and resumes the conversation',
    )
  }
  const cards = wereLive
    .filter((w) => WORTH_REVIVING.has(w.status))
    .map((w) => store.getSession(w.id))
    .filter((s): s is TerminalSession => !!s && s.kind === 'session' && s.closedAt === null)
  if (!cards.length) return
  console.log(
    cards.length === 1
      ? '[garden] bringing back the 1 card that was running'
      : `[garden] bringing back the ${cards.length} cards that were running`,
  )

  /**
   * How long between one card coming up and the next being started.
   *
   * Raised twice now. First from 1200ms after a real revive of ten cards, where two of them exited
   * within seconds of being started. Raised again from 2000ms after two restarts in one night, each
   * reviving fifteen real cards, each losing six or seven of them to the thirty-second
   * "never reported in" watchdog below — not a crash, just contention: fifteen CLIs cold-starting
   * within thirty seconds each read CLAUDE.md, memory files, hooks and do their own account
   * resolution, and on a machine already running that many real cards there was not enough of the
   * thirty-second window left over once the queue behind them was accounted for. Every failure was
   * recovered by hand, one at a time, spaced well apart, which is the thing this number should have
   * been doing on its own.
   */
  const APART_MS = 4000
  /**
   * How long a revived card is watched before Garden decides it did not take.
   *
   * Long enough for a CLI that is merely slow to still be running, short enough that the retry lands
   * while the owner is still looking at the board coming back.
   */
  const SETTLE_MS = 8000

  let i = 0
  const startOne = (id: string, second: boolean) => {
    // Read again: the owner can reach the board before this finishes, and a card he has already
    // started himself must not be started twice.
    const now = store.getSession(id)
    if (!now || ptys.isLive(now.id) || now.closedAt !== null) return
    try {
      broadcast({ t: 'session.updated', session: startSession({ ...now, status: 'starting' }) })
    } catch (err) {
      console.log(`[garden] could not bring back ${now.title}: ${(err as Error).message}`)
      return
    }
    if (second) return
    /*
     * One retry, and only one, for a card whose process is gone again this soon.
     *
     * On the owner's own board, ten cards were revived and two of them exited with code 1 within
     * seconds while the other eight resumed normally. Started again by hand a minute later, both
     * came up first time and resumed their conversations, so the cards were not broken and neither
     * was the resume; the burst was. Without this he has to notice which two are missing, which is
     * exactly the checking this app exists to do for him.
     *
     * Bounded at one attempt because a card that fails twice is failing for a reason a third go will
     * not fix, and the log says so rather than the board quietly cycling.
     */
    setTimeout(() => {
      const after = store.getSession(id)
      if (!after || after.closedAt !== null || ptys.isLive(id)) return
      console.log(`[garden] "${after.title}" did not stay up, so it is being started once more`)
      startOne(id, true)
    }, SETTLE_MS).unref?.()
  }

  const next = () => {
    const s = cards[i++]
    if (!s) return
    startOne(s.id, false)
    if (i < cards.length) setTimeout(next, APART_MS).unref?.()
  }
  setTimeout(next, 1500).unref?.()
}

function shutdown() {
  ptys.killAll()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
