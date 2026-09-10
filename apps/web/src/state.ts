import { useSyncExternalStore } from 'react'
import type {
  Project,
  Profile,
  TerminalSession,
  DocCard,
  Channel,
  Wire,
  AccountIdentity,
  ServerMessage,
  WorkRecord,
  SavedLayout,
  BoardLimits,
} from '@garden/shared'
import { conn } from './connection'
import { dropPreview, feedPreview, resizePreview } from './preview'
import { record } from './undo'
import { asPipelineRuns, type PipelineRun } from './pipeline-types'

export interface AppState {
  connected: boolean
  projects: Project[]
  profiles: Profile[]
  sessions: TerminalSession[]
  docs: DocCard[]
  channels: Channel[]
  wires: Wire[]
  /** The account the unmanaged config dir uses, so a tab can name it instead of saying default. */
  defaultAccount: AccountIdentity | null
  /**
   * Which build the server half is on, or null until it has said.
   *
   * The page knows its own version at compile time. It cannot know the server's, and the server is
   * the half that can be left behind: restarting the backend from the header replaces it without
   * touching the page, and reloading the page replaces the page without touching the server. The
   * header compares the two and says so when they differ.
   */
  serverBuild: { version: string; commit: string; startedAt: number } | null
  /** Markdown files found in the active project, for the open-a-doc picker. */
  docFiles: string[]
  activeProjectId: string | null
  /** Tabs he has closed. Their boards are intact; they are simply not on the row. */
  closedProjects: Project[]
  /** Boards written into the Garden directory, newest first. */
  boards: Array<{ file: string; name: string; projectId: string; projectPath: string; savedAt: number; cards: number }>
  /** Sessions raised into the 1:1 dock. Capped, because live xterms are expensive. */
  focused: string[]
  /**
   * Sessions whose pipeline panel is open right now.
   *
   * Client state, deliberately. The panel is one view of one card rather than a scatter of file
   * cards, so it needs none of the machinery the context and history webs have on the server, and
   * building that machinery would mean editing `packages/shared` and `server/src`, which restarts
   * the backend and kills every live card. What is given up is that a reload closes the panel,
   * which is what "on demand" already meant.
   */
  pipelineOpen: string[]
  lastError: string | null
}

const MAX_FOCUSED = 4

let state: AppState = {
  connected: false,
  projects: [],
  profiles: [],
  sessions: [],
  docs: [],
  channels: [],
  wires: [],
  defaultAccount: null,
  serverBuild: null,
  docFiles: [],
  closedProjects: [],
  boards: [],
  activeProjectId: null,
  focused: [],
  pipelineOpen: [],
  lastError: null,
}

const subs = new Set<() => void>()

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch }
  for (const fn of subs) fn()
}

export function subscribe(fn: () => void) {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function getState() {
  return state
}

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select(state),
  )
}

// ---------------------------------------------------------------------------
// Terminal byte streams
// ---------------------------------------------------------------------------

/**
 * `cols` and `rows` are set on a snapshot and only on a snapshot.
 *
 * They are the grid the bytes were drawn against, and they travel with the bytes for the same
 * reason the preview already needs them: a CLI sends drawing instructions computed for a specific
 * width, not finished text, so replaying them against a different one lands every wrap and every
 * cursor move somewhere else. The preview was given this on `session.scrollback` and the dock
 * terminal was not, which is why a card could be correct while the terminal beside it was
 * scrambled, and why opening a pane a second time appeared to fix it.
 *
 * Live bytes carry no size because they are appended to a grid that is already correct.
 */
/**
 * How long a pane's measured size has to stand before it is reported to the process.
 *
 * Long enough to outlast a mount-time fit being corrected by the ResizeObserver a frame or two
 * later, short enough that a deliberate drag of a pane still feels immediate. The two figures that
 * motivated it arrived about a frame apart.
 */
const RESIZE_SETTLE_MS = 120
const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * The last size actually reported, so a settled size identical to it is not sent again.
 *
 * It has to be forgotten when the process behind a card is replaced, and `forgetReportedSize` below
 * is the only reason this is not simply local to `actions.resize`. What it remembers is not "the
 * size of the pane", it is "what this process has been told", and a new process has been told
 * nothing.
 */
const lastResize = new Map<string, string>()

/**
 * A card just got a different process, so nothing has been told anything about its screen.
 *
 * Every process spawns at 120x30 whatever the dock looks like, and the pane corrects it once. That
 * correction was deduped against the size the PREVIOUS process had been told, and the pane has not
 * changed, so the message was dropped and the replacement spent its whole life believing it had 120
 * columns while the pane drew it at 260. Measured on a restart with the pane left open and
 * untouched: the process reported 120x30 against a pane drawing 260x25.
 *
 * Nothing reports a disagreement like that, because both halves are internally consistent and only
 * disagree with each other. What it produces is the CLI computing its wrapping and its cursor moves
 * for one grid while xterm lays them out on another, so every "move up three lines" lands somewhere
 * the CLI never meant, which is the smeared and doubled text.
 */
function forgetReportedSize(sessionId: string) {
  lastResize.delete(sessionId)
  const pending = resizeTimers.get(sessionId)
  if (pending) {
    clearTimeout(pending)
    resizeTimers.delete(sessionId)
  }
}

type ByteListener = (data: string, seq: number, isSnapshot: boolean, cols?: number, rows?: number) => void
const byteListeners = new Map<string, Set<ByteListener>>()

/** Subscribe to raw PTY bytes for one session. Used by live xterm instances. */
export function onSessionBytes(sessionId: string, fn: ByteListener) {
  let set = byteListeners.get(sessionId)
  if (!set) byteListeners.set(sessionId, (set = new Set()))
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) byteListeners.delete(sessionId)
  }
}

// Preview text comes from a real headless terminal per session, in ./preview.ts. See the note
// there for why interpreting the byte stream with a regex is not good enough.
export { getPreviewLines as getPreview, onPreviewChange } from './preview'

// Document text, kept out of React state for the same reason as terminal bytes: a card's body
// changing should not re-render the canvas.
const docContent = new Map<string, string>()
const docMtime = new Map<string, number>()
const docSubs = new Set<() => void>()

/*
 * A message card's conversation, kept out of React state for the same reason document text is: the
 * card redrawing when somebody says something should not redraw the canvas.
 *
 * Keyed per channel, and the listeners are per channel too. A board with several message cards on it
 * has each one woken only by its own file, which matters here more than it does for documents: the
 * whole point of this card is that it is quiet, and a card that re-renders whenever any other
 * conversation moves is not.
 */
const channelText = new Map<string, string>()
const channelSubs = new Map<string, Set<() => void>>()
/** When the file was last written, so an edit can be refused if the card answered mid-typing. */
const channelMtime = new Map<string, number>()

/**
 * Where the last edit of a message card got to, in the same three states a document card uses.
 *
 * Three, not two, and `pending` is the one that matters. The write has gone and nothing has come
 * back, so whether it reached disk is unknown, and unknown is neither success nor failure and must
 * not be drawn as either. This card can be written by the agent at the other end at any moment, so
 * "I think I saved it" is a claim with a real way of being wrong.
 */
export type ChannelSaveState =
  | { status: 'pending'; at: number }
  | { status: 'ok'; at: number }
  | { status: 'error'; at: number; error: string }

const channelSaveState = new Map<string, ChannelSaveState>()

export function getChannelText(channelId: string): string {
  return channelText.get(channelId) ?? ''
}

export function getChannelMtime(channelId: string): number {
  return channelMtime.get(channelId) ?? 0
}

export function getChannelSaveState(channelId: string): ChannelSaveState | undefined {
  return channelSaveState.get(channelId)
}

export function onChannelChange(channelId: string, fn: () => void) {
  let set = channelSubs.get(channelId)
  if (!set) channelSubs.set(channelId, (set = new Set()))
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) channelSubs.delete(channelId)
  }
}

/**
 * Where the last save for a card got to, and there are three answers, not two.
 *
 * `pending` is the one that used to be missing, and it is the one the project's rule is about. A
 * write has been sent and nothing has come back, so whether the bytes reached disk is not known.
 * That is not success and it is not failure, and it must not be drawn as either. Only `ok` means
 * the server said the file was written, and only `error` means it said the file was not.
 *
 * `content` is the text that was sent. The card's own copy of the file is not touched until the
 * write is confirmed, so what is on screen is what is on disk plus an editor holding the rest. The
 * old code wrote the draft into the card the instant it hit send, which is why the one mark that
 * said the work was not safe yet vanished on the click and never came back, whether or not a single
 * byte had reached disk. On a refusal the attempted text is kept here too, so the editor can offer
 * it back rather than losing the very work the card is reporting was not saved.
 *
 * `token` counts saves for one card, so an answer to a save the owner has since replaced cannot
 * close an editor he has gone back into.
 */
export type DocSaveState =
  | { status: 'pending'; token: number; at: number; content: string }
  | { status: 'ok'; token: number; at: number }
  | { status: 'error'; token: number; at: number; error: string; content: string }

const docSaveState = new Map<string, DocSaveState>()
let docSaveToken = 0

/** Where the last save for a card got to, or undefined if this card has never been saved. */
export function getDocSaveState(cardId: string): DocSaveState | undefined {
  return docSaveState.get(cardId)
}

/** What each session runs from, grouped, once asked for. */
export interface ContextEntry {
  group: string
  title: string
  display: string
  usage: string
  open: boolean
}
const contextLists = new Map<string, ContextEntry[]>()
const contextSubs = new Set<(sessionId: string) => void>()

/**
 * Which cards have their roots unfolded as columns rather than as files.
 *
 * The bottom dot used to open every file at once. On a real project that is well over a hundred
 * cards arriving together, and the owner's report was the plain one: "makes it too laggy the way it
 * is right now". So the dot now unfolds the columns, each one a label and a count, and a column
 * opens its own files when it is asked to.
 *
 * Held here rather than in AppState, and rather than on the server, because it is a view of a card
 * and not a fact about it. Nothing is created on disk, nothing is stored, and closing the web
 * forgets it. The files themselves remain the only thing with a real existence on the board, which
 * is why a column that has files open shows those instead of a placeholder.
 */
const contextColumns = new Set<string>()

export function contextColumnsOpen(sessionId: string) {
  return contextColumns.has(sessionId)
}

/**
 * The days each card has a history for, and which of them are on the board.
 *
 * Out of React state for the same reason the context list is: a card learning that it has six days
 * of turns should redraw that card, not the canvas. Keyed by card, and the server sends the whole
 * answer every time it could have changed, so this is never merged or reasoned about here.
 */
export interface HistoryGroup {
  group: string
  label: string
  count: number
  latest: number
}
const historyGroups = new Map<string, { groups: HistoryGroup[]; open: string[] }>()
const historySubs = new Set<(sessionId: string) => void>()

export function getHistoryGroups(sessionId: string) {
  return historyGroups.get(sessionId)
}

/**
 * Drop what we know about a card's history days, and tell anything drawing them.
 *
 * Days are not cards. They come from a `history.groups` answer and are drawn from that answer, so
 * nothing the server broadcasts on close can clear them: it removes the turn cards it owns and has
 * no message that says "and forget the days". Folding the block away has to forget them here.
 */
export function forgetHistoryGroups(sessionId: string) {
  if (!historyGroups.delete(sessionId)) return
  for (const fn of historySubs) fn(sessionId)
}

export function onHistoryGroups(fn: (sessionId: string) => void) {
  historySubs.add(fn)
  return () => {
    historySubs.delete(fn)
  }
}

export function getContextList(sessionId: string) {
  return contextLists.get(sessionId)
}

export function onContextList(fn: (sessionId: string) => void) {
  contextSubs.add(fn)
  return () => {
    contextSubs.delete(fn)
  }
}

// ---------------------------------------------------------------------------
// Work history
// ---------------------------------------------------------------------------

// Kept out of AppState for the same reason as contextLists: only the card whose history is
// open needs to re-render when a batch of records arrives, not the whole board.
const work = new Map<string, WorkRecord[]>()
const workSubs = new Set<(sessionId: string) => void>()

export function getWork(sessionId: string) {
  return work.get(sessionId)
}

export function onWork(fn: (sessionId: string) => void) {
  workSubs.add(fn)
  return () => {
    workSubs.delete(fn)
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/*
 * What each of a session's runs actually reached, kept out of AppState for the same reason as the
 * work history: only the panel that is open needs to redraw when a reply lands.
 *
 * Undefined means never asked for, which the panel draws as "asking" rather than as an empty
 * pipeline. That distinction is the same one the stages themselves make, and getting it wrong
 * here would show a card with nothing in it as a card that did nothing.
 */
const pipelines = new Map<string, { runs: PipelineRun[]; unreadable: number; at: number }>()
const pipelineSubs = new Set<(sessionId: string) => void>()

export function getPipeline(sessionId: string) {
  return pipelines.get(sessionId)
}

export function onPipeline(fn: (sessionId: string) => void) {
  pipelineSubs.add(fn)
  return () => {
    pipelineSubs.delete(fn)
  }
}

/**
 * Where an open panel has been dragged to, if anywhere.
 *
 * Client-side, like the open set: the panel is derived from a card's position until the owner
 * moves it, and after that it stays where he put it for as long as it is open.
 */
const pipelineAt = new Map<string, { x: number; y: number }>()

export function getPipelineAt(sessionId: string) {
  return pipelineAt.get(sessionId)
}

// ---------------------------------------------------------------------------
// Wire pulses
// ---------------------------------------------------------------------------

/**
 * Which wires are mid-pulse right now, for WireEdge to animate. Transient by design: `wire.pulse`
 * is never stored as state, so this is a plain Set with its own timers, not part of AppState.
 * A wire that never pulsed is never in this set, which is what keeps it dim at rest.
 */
const pulsingWires = new Set<string>()
const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pulseSubs = new Set<(wireId: string) => void>()
/*
 * How long a wire stays lit after a message travels it.
 *
 * 1200ms, and before that 500ms, were both too short: the owner reads this board from across a wide
 * screen and a glance a moment late caught nothing, so a delivery that did happen looked like a
 * board where nothing had. Held for three and a half seconds the pulse is still plainly an event
 * rather than a state, and the travelling dot gets three full runs of the wire inside it.
 */
const PULSE_MS = 3500

export function isWirePulsing(wireId: string) {
  return pulsingWires.has(wireId)
}

export function onWirePulse(fn: (wireId: string) => void) {
  pulseSubs.add(fn)
  return () => {
    pulseSubs.delete(fn)
  }
}

// ---------------------------------------------------------------------------
// Saved layouts
// ---------------------------------------------------------------------------

/*
 * Where cards were, saved on the server rather than in this tab.
 *
 * The first version of "Previous" lived in component state, so a reload lost the way back from an
 * arrangement. That is the exact fear the owner described, so the record belongs somewhere a
 * reload cannot reach.
 */
const layouts = new Map<string, SavedLayout[]>()
const layoutSubs = new Set<() => void>()

/*
 * One shared empty array, and never a fresh one.
 *
 * useSyncExternalStore compares snapshots by identity, so returning `?? []` handed it a new array
 * on every render and React re-rendered forever trying to settle. It surfaced as "Maximum update
 * depth exceeded" and froze the board, which is a lot of damage for four characters.
 */
const NO_LAYOUTS: SavedLayout[] = []

export function getLayouts(projectId: string | null): SavedLayout[] {
  if (!projectId) return NO_LAYOUTS
  return layouts.get(projectId) ?? NO_LAYOUTS
}

export function onLayouts(fn: () => void) {
  layoutSubs.add(fn)
  return () => {
    layoutSubs.delete(fn)
  }
}

// ---------------------------------------------------------------------------
// Board limits
// ---------------------------------------------------------------------------

/**
 * The ceiling per project, and what is currently counted against it.
 *
 * Per project rather than a single slot, the same reason `layouts` above is: switching tabs would
 * otherwise flash the previous project's numbers for a moment, or show nothing, while the fresh
 * ones round-trip. The server does not re-broadcast this after an ordinary `session.create` or
 * `session.delete` changes what is counted, only after `limits.set` changes the ceiling itself, so
 * `counted` is only as fresh as the last `limits.get` — see the effect in Sidebar.tsx that asks
 * again whenever the project's own card count moves.
 *
 * `subagents` is optional here and required on the wire, and the difference is deliberate: a server
 * older than that field sends a `counted` without it, and the panel draws an absent figure as "—"
 * rather than as zero. Typing it required would make this map claim a number nobody sent.
 */
const boardLimits = new Map<string, { limits: BoardLimits; counted: { cards: number; running: number; subagents?: number } }>()
const limitsSubs = new Set<() => void>()

export function getLimits(projectId: string | null) {
  if (!projectId) return undefined
  return boardLimits.get(projectId)
}

export function onLimits(fn: () => void) {
  limitsSubs.add(fn)
  return () => {
    limitsSubs.delete(fn)
  }
}

/** One side of a spawned agent's conversation, as its card shows it. */
export type AgentTurn = {
  role: 'asked' | 'said' | 'did'
  text: string
  at: number | null
  /** The whole thing, present only when `text` is a shortened version of it. */
  full?: string
}

/*
 * Conversations read from a card's own transcript, kept out of React state for the same reason as
 * terminal bytes and document text: an agent answering should redraw its card, not the canvas.
 */
const agentChats = new Map<string, AgentTurn[]>()
/*
 * Told which card changed, rather than just that something did. A board can hold a lot of agent
 * cards and one of them answering should not make every other one re-read its own conversation.
 */
const agentChatSubs = new Set<(sessionId: string) => void>()

/** What happened to the last line sent to an agent, so its card can say rather than assume. */
const agentSaid = new Map<string, { ok: boolean; reason: string | null; at: number }>()

export function getAgentSaid(sessionId: string) {
  return agentSaid.get(sessionId)
}

/** Undefined means never asked for; an empty array means asked, and there is nothing yet. */
export function getAgentChat(sessionId: string): AgentTurn[] | undefined {
  return agentChats.get(sessionId)
}

export function onAgentChat(fn: (sessionId: string) => void) {
  agentChatSubs.add(fn)
  return () => {
    agentChatSubs.delete(fn)
  }
}

export function getDocContent(cardId: string): string | undefined {
  return docContent.get(cardId)
}

export function setDocContent(cardId: string, content: string) {
  docContent.set(cardId, content)
  for (const fn of docSubs) fn()
}

export function onDocChange(fn: () => void) {
  docSubs.add(fn)
  return () => {
    docSubs.delete(fn)
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

conn.on((msg: ServerMessage) => {
  switch (msg.t) {
    case 'state': {
      // Both lists are asked for once a connection exists, so the tab menu has something to offer
      // the first time it is opened rather than only after something has been saved this session.
      conn.send({ t: 'project.listClosed' })
      conn.send({ t: 'board.list' })
      const active = state.activeProjectId ?? msg.projects[0]?.id ?? null
      set({
        projects: msg.projects,
        profiles: msg.profiles,
        sessions: msg.sessions,
        docs: msg.docs ?? [],
        /*
         * Read here as well as on `channel.added`, and leaving it out is how a message card came to
         * exist on the server and never appear on the board.
         *
         * The two paths cover different moments and only one of them is exercised while the app is
         * open: a card created now arrives as its own event, and a card that already existed arrives
         * only in this snapshot. So the bug was invisible in every session where the card was made,
         * and certain in every reload afterwards.
         */
        channels: msg.channels ?? [],
        wires: msg.wires ?? [],
        defaultAccount: msg.defaultAccount ?? null,
        serverBuild: msg.build ?? null,
        activeProjectId: active,
        /*
         * The terminals he had open, put back.
         *
         * This is the half that answers the complaint. A reload used to arrive here with `focused`
         * at its initial empty value and nothing to restore it from, so every pane on the board
         * closed and the cards stayed, which reads as the terminal having vanished rather than as
         * the dock having been emptied.
         */
        focused: focusFor(active, msg.sessions),
      })
      if (active) conn.send({ t: 'doc.list', projectId: active })
      // Populate every card's miniature from existing scrollback rather than waiting for the
      // session to print something new.
      for (const s of msg.sessions) conn.send({ t: 'session.scrollback', sessionId: s.id })
      return
    }
    case 'profiles': {
      set({ profiles: msg.profiles, defaultAccount: msg.defaultAccount ?? null })
      return
    }
    case 'project.picked': {
      return
    }
    case 'project.updated': {
      set({ projects: state.projects.map((p) => (p.id === msg.project.id ? msg.project : p)) })
      return
    }
    case 'project.added': {
      set({
        projects: [msg.project, ...state.projects.filter((p) => p.id !== msg.project.id)],
        activeProjectId: msg.project.id,
        docFiles: [],
      })
      // Adding a project makes it active, so its documents must be scanned here too. Without
      // this the picker sat empty for every newly added project and the feature looked broken.
      conn.send({ t: 'doc.list', projectId: msg.project.id })
      return
    }
    // Its arrival is the message. `connection.ts` has already stamped the clock by the time this
    // runs, and nothing on the board changes, so there is deliberately no `set` here: a heartbeat
    // that re-rendered the board would be its own performance problem.
    case 'pulse':
      return
    case 'projects.closed': {
      set({ closedProjects: msg.projects })
      return
    }
    case 'boards': {
      set({ boards: msg.boards })
      return
    }
    case 'project.removed': {
      const projects = state.projects.filter((p) => p.id !== msg.projectId)
      // The cards and wires go with it. The server says so card by card as well, and this does not
      // depend on those arriving first or at all.
      set({
        projects,
        sessions: state.sessions.filter((s) => s.projectId !== msg.projectId),
        docs: state.docs.filter((d) => d.projectId !== msg.projectId),
        wires: state.wires.filter((w) => w.projectId !== msg.projectId),
        activeProjectId: state.activeProjectId === msg.projectId ? projects[0]?.id ?? null : state.activeProjectId,
      })
      return
    }
    case 'session.added': {
      if (state.sessions.some((s) => s.id === msg.session.id)) return
      set({ sessions: [...state.sessions, msg.session] })
      conn.send({ t: 'session.scrollback', sessionId: msg.session.id })
      return
    }
    case 'session.updated': {
      /*
       * A card that just got a process needs its terminal read again from the start.
       *
       * The server counts bytes from zero for each new process, while the pane counts cumulatively
       * and drops anything not newer than what it has already drawn. So after a stop and a start,
       * every byte of the new run arrived numbered below the old total and was thrown away, and the
       * pane sat showing the previous run until the new one had printed just as much. Asking for the
       * scrollback on the transition resets both sides together, and the snapshot path already knows
       * how to rebuild a pane whose numbering has moved backwards.
       */
      const was = state.sessions.find((s) => s.id === msg.session.id)
      if (was && was.pid !== msg.session.pid) {
        // A different process, or none. Whatever the last one was told about its screen does not
        // apply to this one, and remembering it is what left a restarted card at 120x30.
        forgetReportedSize(msg.session.id)
      }
      if (was && was.pid === null && msg.session.pid !== null) {
        conn.send({ t: 'session.scrollback', sessionId: msg.session.id })
      }
      set({ sessions: state.sessions.map((s) => (s.id === msg.session.id ? msg.session : s)) })
      return
    }
    case 'session.removed': {
      dropPreview(msg.sessionId)
      // Imported lazily so the pool module can import this one without a cycle at load time.
      void import('./terminal-pool').then((m) => m.destroy(msg.sessionId))
      set({
        sessions: state.sessions.filter((s) => s.id !== msg.sessionId),
        focused: state.focused.filter((id) => id !== msg.sessionId),
      })
      return
    }
    case 'session.data': {
      feedPreview(msg.sessionId, msg.data, msg.seq, false)
      const set_ = byteListeners.get(msg.sessionId)
      if (set_) for (const fn of set_) fn(msg.data, msg.seq, false)
      return
    }
    case 'session.scrollback': {
      /*
       * The size before the bytes, and in that order.
       *
       * These bytes were drawn against a specific grid, so the preview has to be that size BEFORE
       * it replays them. Resizing afterwards is not the same thing: xterm reflows what it already
       * holds, which is a guess at how text that was wrapped one way would have wrapped another,
       * and a guess is exactly what the card should never be showing.
       */
      resizePreview(msg.sessionId, msg.cols, msg.rows)
      feedPreview(msg.sessionId, msg.data, msg.seq, true)
      const set_ = byteListeners.get(msg.sessionId)
      if (set_) for (const fn of set_) fn(msg.data, msg.seq, true, msg.cols, msg.rows)
      return
    }
    case 'wire.added': {
      if (state.wires.some((w) => w.id === msg.wire.id)) return
      set({ wires: [...state.wires, msg.wire] })
      return
    }
    case 'wire.updated': {
      set({ wires: state.wires.map((w) => (w.id === msg.wire.id ? msg.wire : w)) })
      return
    }
    case 'wire.removed': {
      set({ wires: state.wires.filter((w) => w.id !== msg.wireId) })
      return
    }
    case 'agent.chat': {
      agentChats.set(msg.sessionId, msg.turns)
      for (const fn of agentChatSubs) fn(msg.sessionId)
      return
    }
    case 'agent.said': {
      /*
       * A refusal is the interesting case and it goes where the owner will see it. Reaching an
       * agent can fail for ordinary reasons: it finished, its parent is off, or two agents look
       * identical on the parent's screen and Garden will not guess between them. Saying nothing
       * would leave a line that appeared to send and did not.
       */
      if (!msg.ok) set({ lastError: msg.reason ?? 'that agent could not be reached' })
      agentSaid.set(msg.sessionId, { ok: msg.ok, reason: msg.reason ?? null, at: Date.now() })
      for (const fn of agentChatSubs) fn(msg.sessionId)
      return
    }
    case 'doc.list': {
      if (msg.projectId === state.activeProjectId) set({ docFiles: msg.files })
      return
    }
    case 'channel.added': {
      if (state.channels.some((c) => c.id === msg.channel.id)) return
      set({ channels: [...state.channels, msg.channel] })
      return
    }
    case 'channel.updated': {
      set({ channels: state.channels.map((c) => (c.id === msg.channel.id ? msg.channel : c)) })
      return
    }
    case 'channel.removed': {
      channelText.delete(msg.channelId)
      set({ channels: state.channels.filter((c) => c.id !== msg.channelId) })
      return
    }
    case 'channel.text': {
      // Whole file every time, so the board can never hold a version of the conversation that the
      // file does not. There is one copy of what was said and it is on disk.
      channelText.set(msg.channelId, msg.text)
      channelMtime.set(msg.channelId, msg.at)
      const listeners = channelSubs.get(msg.channelId)
      if (listeners) for (const fn of listeners) fn()
      return
    }
    case 'channel.saved': {
      channelSaveState.set(
        msg.channelId,
        msg.error ? { status: 'error', at: msg.at, error: msg.error } : { status: 'ok', at: msg.at },
      )
      const listeners = channelSubs.get(msg.channelId)
      if (listeners) for (const fn of listeners) fn()
      return
    }
    case 'doc.added': {
      if (state.docs.some((d) => d.id === msg.card.id)) return
      set({ docs: [...state.docs, msg.card] })
      return
    }
    case 'doc.updated': {
      set({ docs: state.docs.map((d) => (d.id === msg.card.id ? msg.card : d)) })
      return
    }
    case 'doc.removed': {
      docContent.delete(msg.cardId)
      set({ docs: state.docs.filter((d) => d.id !== msg.cardId) })
      return
    }
    case 'context.list': {
      contextLists.set(msg.sessionId, msg.entries)
      for (const fn of contextSubs) fn(msg.sessionId)
      return
    }
    case 'layouts': {
      layouts.set(msg.projectId, msg.layouts)
      for (const fn of layoutSubs) fn()
      return
    }
    case 'limits': {
      boardLimits.set(msg.projectId, { limits: msg.limits, counted: msg.counted })
      for (const fn of limitsSubs) fn()
      return
    }
    case 'pipeline': {
      // The message is typed `runs: unknown[]`, so this is where the shape is checked rather than
      // assumed. See pipeline-types.ts for why the type lives in this app instead of in shared.
      const { runs, unreadable } = asPipelineRuns(msg.runs)
      pipelines.set(msg.sessionId, { runs, unreadable, at: Date.now() })
      for (const fn of pipelineSubs) fn(msg.sessionId)
      return
    }
    case 'history.groups': {
      historyGroups.set(msg.sessionId, { groups: msg.groups, open: msg.open })
      for (const fn of historySubs) fn(msg.sessionId)
      return
    }
    case 'work': {
      work.set(msg.sessionId, msg.records)
      for (const fn of workSubs) fn(msg.sessionId)
      return
    }
    case 'wire.pulse': {
      pulsingWires.add(msg.wireId)
      const existing = pulseTimers.get(msg.wireId)
      if (existing) clearTimeout(existing)
      pulseTimers.set(
        msg.wireId,
        setTimeout(() => {
          pulsingWires.delete(msg.wireId)
          pulseTimers.delete(msg.wireId)
          for (const fn of pulseSubs) fn(msg.wireId)
        }, PULSE_MS),
      )
      for (const fn of pulseSubs) fn(msg.wireId)
      return
    }
    case 'doc.saved': {
      /*
       * The only place a save is allowed to become an outcome.
       *
       * A confirmed write is also the only moment the card's copy of the file is replaced, and it is
       * replaced with the exact bytes the server has just said it wrote, so what the card shows is
       * never ahead of the disk. The mtime is taken only on success on purpose: after a failed write
       * it describes the copy that was NOT overwritten, so trusting it would make the next save send
       * a baseMtime for a write that never happened.
       */
      const outstanding = docSaveState.get(msg.cardId)
      const sent = outstanding?.status === 'pending' ? outstanding.content : undefined
      const token = outstanding?.token ?? ++docSaveToken
      if (msg.error) {
        docSaveState.set(msg.cardId, {
          status: 'error',
          token,
          at: Date.now(),
          error: msg.error,
          content: sent ?? docContent.get(msg.cardId) ?? '',
        })
        set({ lastError: msg.error })
      } else {
        docSaveState.set(msg.cardId, { status: 'ok', token, at: Date.now() })
        docMtime.set(msg.cardId, msg.mtime)
        if (sent !== undefined) docContent.set(msg.cardId, sent)
      }
      for (const fn of docSubs) fn()
      return
    }
    case 'doc.content': {
      if (msg.mtime) docMtime.set(msg.cardId, msg.mtime)
      docContent.set(msg.cardId, msg.error ? `Could not read this file.

${msg.error}` : msg.content)
      for (const fn of docSubs) fn()
      return
    }
    case 'error': {
      if (msg.message === '__connected__') return set({ connected: true, lastError: null })
      if (msg.message === '__disconnected__') return set({ connected: false })
      set({ lastError: msg.message })
      return
    }
  }
})

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * What the Full preset comes to on this screen, measured the same way the canvas draws it.
 *
 * Read off the canvas element rather than the window, since the dock and the rail take a good part
 * of the width and a card sized to the window would run underneath them.
 */
function fullBox(): { width: number; height: number } {
  const rect = document.querySelector('.react-flow')?.getBoundingClientRect()
  return {
    width: Math.max(600, (rect?.width ?? window.innerWidth) - 80),
    height: Math.max(400, (rect?.height ?? window.innerHeight) - 80),
  }
}

/**
 * Which terminals are open, remembered per board across a reload.
 *
 * It was held in memory and nowhere else, so refreshing the page closed every pane on the board at
 * once. The cards stayed where they were, which is what made it confusing rather than obviously
 * broken: the owner's words were that a terminal "keeps disappearing from workspace" and that "the
 * garden view needed refresh then it was gone". Nothing had gone. The one thing the browser knew,
 * and the only thing it was never asked to write down, was which of them he had open.
 *
 * In localStorage rather than on the server, and that is a real distinction rather than laziness.
 * Which panes are open is a fact about this window, not about the board: a second window looking at
 * the same board legitimately has different ones open, and the panel layout beside it already lives
 * here for the same reason. Keyed by project, because switching tabs should give him back what he
 * had on that tab.
 */
const FOCUS_KEY = 'garden.focused'

function rememberedFocus(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(FOCUS_KEY) ?? '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    // A key somebody edited by hand, or a browser with storage turned off. Neither is worth an error.
    return {}
  }
}

function rememberFocus(projectId: string | null, focused: string[]) {
  if (!projectId) return
  try {
    localStorage.setItem(FOCUS_KEY, JSON.stringify({ ...rememberedFocus(), [projectId]: focused }))
  } catch {
    // Storage full or blocked. The dock still works for this session, which is where it started.
  }
}

/**
 * The panes to reopen for a board, filtered to cards that are still there.
 *
 * A remembered id whose card has since been deleted would open a pane for nothing, so what is
 * stored is treated as a wish rather than as truth, which is the same rule the rest of this app
 * follows about anything read back from disk.
 */
function focusFor(projectId: string | null, sessions: TerminalSession[]): string[] {
  if (!projectId) return []
  const alive = new Set(sessions.filter((s) => s.projectId === projectId && s.closedAt === null).map((s) => s.id))
  return (rememberedFocus()[projectId] ?? []).filter((id) => alive.has(id)).slice(-MAX_FOCUSED)
}

export const actions = {
  setActiveProject(id: string) {
    set({ activeProjectId: id, docFiles: [], focused: focusFor(id, state.sessions) })
    conn.send({ t: 'project.open', projectId: id })
    conn.send({ t: 'doc.list', projectId: id })
  },

  createProfile(name: string, adapterId: 'shell' | 'claude' | 'codex') {
    conn.send({ t: 'profile.create', name, adapterId })
  },

  deleteProfile(profileId: string) {
    conn.send({ t: 'profile.delete', profileId })
  },

  /** Bind an account to a project. Every session in it then runs on that account, enforced. */
  setProjectProfile(projectId: string, adapterId: 'claude' | 'codex' | 'shell', profileId: string | null) {
    conn.send({ t: 'project.setProfile', projectId, adapterId, profileId })
  },

  /** Opens the OS folder dialog and adds whatever is chosen. */
  pickProject() {
    conn.send({ t: 'project.pick' })
  },

  addProject(path: string) {
    conn.send({ t: 'project.add', path })
  },

  removeProject(projectId: string) {
    conn.send({ t: 'project.remove', projectId })
  },

  /** Stop what is running in a tab and take it off the row. Nothing is deleted. */
  closeProject(projectId: string) {
    conn.send({ t: 'project.close', projectId })
  },

  reopenProject(projectId: string) {
    conn.send({ t: 'project.reopen', projectId })
  },

  /** Write this board into the Garden directory so it can be opened again later. */
  saveBoard(projectId: string, name?: string) {
    conn.send({ t: 'board.save', projectId, name })
  },

  openBoard(file: string) {
    conn.send({ t: 'board.open', file })
  },

  deleteBoard(file: string) {
    conn.send({ t: 'board.delete', file })
  },

  /**
   * Make a card by saying what it is for, before anything starts.
   *
   * The role travels with the creation rather than being set afterwards, because the CLI reads its
   * permissions once at launch: a card started first and given a role second runs its whole first
   * session unrestricted.
   */
  createRoleCard(args: {
    projectId: string
    adapterId: 'shell' | 'claude' | 'codex'
    title?: string
    roleClass: TerminalSession['roleClass']
    reportsTo: string | null
    modelChoice: string | null
    effortChoice: string | null
    teamSize: number | null
    /** The files and folders this card is responsible for. Empty means no limit. */
    ownedPaths?: string[]
    /**
     * What this card is for, in the maker's own words.
     *
     * A card no longer inherits the project's instructions or the user's, so this is the whole of
     * what it knows about its own job before it does anything.
     */
    roots?: string
    start: boolean
    x?: number
    y?: number
  }) {
    conn.send({ t: 'session.create', ...args })
  },

  /**
   * The plain launcher in the pane menu: a terminal with none of the role-card form's questions.
   *
   * `x`/`y` are optional and, when given, are board coordinates from wherever the menu was
   * opened, the same field `createRoleCard` already sends. Omitted, the server falls back to its
   * own automatic placement.
   */
  newSession(projectId: string, adapterId: 'shell' | 'claude' | 'codex', x?: number, y?: number) {
    conn.send({ t: 'session.create', projectId, adapterId, x, y })
  },

  focus(sessionId: string) {
    /*
     * The dock holds four, and opening a fifth closes the oldest without saying so.
     *
     * That cap is deliberate and stays: a live xterm is expensive and four is what the pane row
     * fits. What was wrong is that the closure was silent, so a terminal the owner had open simply
     * was not there any more and nothing on screen accounted for it. Now the card whose pane was
     * taken is named, in the same line the rest of the app reports things in.
     */
    const already = state.focused.includes(sessionId)
    const next = already ? state.focused : [...state.focused, sessionId].slice(-MAX_FOCUSED)
    const dropped = state.focused.find((id) => !next.includes(id))
    const title = dropped ? state.sessions.find((s) => s.id === dropped)?.title : null
    set({
      focused: next,
      ...(title
        ? { lastError: `The dock holds ${MAX_FOCUSED} terminals, so "${title}" was closed to make room.` }
        : {}),
    })
    rememberFocus(state.activeProjectId, next)
  },

  unfocus(sessionId: string) {
    const focused = state.focused.filter((id) => id !== sessionId)
    set({ focused })
    rememberFocus(state.activeProjectId, focused)
  },

  toggleFocus(sessionId: string) {
    if (state.focused.includes(sessionId)) actions.unfocus(sessionId)
    else actions.focus(sessionId)
  },

  clearFocus() {
    set({ focused: [] })
    rememberFocus(state.activeProjectId, [])
  },

  rename(sessionId: string, title: string) {
    conn.send({ t: 'session.rename', sessionId, title })
  },

  /** Ends the process. The card stays on the board with its history. */
  stopSession(sessionId: string) {
    conn.send({ t: 'session.stop', sessionId })
  },

  /** Starts the process again for a card that is turned off. */
  startSession(sessionId: string) {
    conn.send({ t: 'session.start', sessionId })
  },

  /**
   * The only call that removes a card. Every path to it confirms first, because losing a card
   * means losing an agent's history and that is the thing this app exists to prevent.
   */
  deleteSession(sessionId: string) {
    conn.send({ t: 'session.delete', sessionId })
  },

  move(sessionId: string, x: number, y: number) {
    const prev = state.sessions.find((s) => s.id === sessionId)
    const from = prev ? { x: prev.x, y: prev.y } : null
    conn.send({ t: 'session.move', sessionId, x, y })
    if (from && (from.x !== x || from.y !== y)) {
      record({
        label: 'move card',
        undo: () => conn.send({ t: 'session.move', sessionId, x: from.x, y: from.y }),
        redo: () => conn.send({ t: 'session.move', sessionId, x, y }),
      })
    }
  },

  input(sessionId: string, data: string) {
    conn.send({ t: 'session.input', sessionId, data })
  },

  /**
   * Tell the process how big its screen is, once the answer has stopped changing.
   *
   * Measured, not supposed: opening a pane used to tell the PTY 106x34 and then, a moment later,
   * 106x13. The pane holds 13 rows. The first figure came from fitting a box the browser had not
   * laid out yet, and Garden sent it to the process as a fact about its screen. That is the thing
   * this project exists not to do, and it would be worth stopping even if nothing downstream cared.
   *
   * Something downstream may well care. A CLI told its screen is 34 rows draws a screen for 34 rows;
   * told a moment later that it is 13, it redraws for 13 against a terminal still holding the taller
   * render, and the gaps it skips with cursor-forward land on cells that are not blank. That is a
   * candidate for the glyphs the owner photographed and it is NOT proven, so this is not a fix for
   * them. It is a wrong number stopped being sent.
   *
   * The guard is deliberately here rather than at the caller, because there are two callers and the
   * other one lives inside a snapshot replay. Whichever of them speaks first, only the size that
   * survives a beat reaches the process.
   */
  resize(sessionId: string, cols: number, rows: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return
    const pending = resizeTimers.get(sessionId)
    if (pending) clearTimeout(pending)
    resizeTimers.set(
      sessionId,
      setTimeout(() => {
        resizeTimers.delete(sessionId)
        if (lastResize.get(sessionId) === `${cols}x${rows}`) return
        lastResize.set(sessionId, `${cols}x${rows}`)
        conn.send({ t: 'session.resize', sessionId, cols, rows })
        // The card's miniature follows the real terminal, because it is interpreting the same stream
        // and a stream only means anything at the size it was drawn for. Opening the dock changes that
        // size, so the preview would otherwise start disagreeing with the terminal the moment the owner
        // looked at one, which is the worst possible moment for the two to diverge.
        resizePreview(sessionId, cols, rows)
      }, RESIZE_SETTLE_MS),
    )
  },

  requestScrollback(sessionId: string) {
    conn.send({ t: 'session.scrollback', sessionId })
  },

  setSessionColor(sessionId: string, color: string | null) {
    const prev = state.sessions.find((s) => s.id === sessionId)?.color ?? null
    conn.send({ t: 'session.setColor', sessionId, color })
    record({
      label: 'change card colour',
      undo: () => conn.send({ t: 'session.setColor', sessionId, color: prev }),
      redo: () => conn.send({ t: 'session.setColor', sessionId, color }),
    })
  },

  /**
   * Double-click behaviour: expand, and press again to go back to the size it has on the board.
   *
   * A three-step cycle read as unpredictable, and its "already at the end, do nothing" branch
   * meant a press could silently do nothing at all, which is worse than any amount of stepping.
   * A toggle always changes something.
   */
  toggleSessionSize(sessionId: string) {
    const s = state.sessions.find((x) => x.id === sessionId)
    const current = s?.size ?? 'normal'
    const next = current === 'normal' ? 'large' : 'normal'
    conn.send({ t: 'session.setSize', sessionId, size: next })
    record({
      label: next === 'normal' ? 'shrink card' : 'expand card',
      undo: () => conn.send({ t: 'session.setSize', sessionId, size: current }),
      redo: () => conn.send({ t: 'session.setSize', sessionId, size: next }),
    })
  },

  /** The size button steps up and wraps, so a press always changes something. */
  cycleSessionSize(sessionId: string, direction: 1 | -1) {
    const s = state.sessions.find((x) => x.id === sessionId)
    const order = ['normal', 'large', 'full'] as const
    const current = s?.size ?? 'normal'
    const i = Math.max(0, order.indexOf(current))
    const next = order[(i + direction + order.length) % order.length]!
    /*
     * Full is the one preset only the browser can work out, so the browser has to say what it came
     * to. Without it the server keeps the old box on file and places that card's roots against an
     * edge the card no longer has, which puts the block underneath it.
     */
    conn.send({ t: 'session.setSize', sessionId, size: next, ...(next === 'full' ? fullBox() : {}) })
    record({
      label: direction > 0 ? 'expand card' : 'shrink card',
      undo: () => conn.send({ t: 'session.setSize', sessionId, size: current }),
      redo: () => conn.send({ t: 'session.setSize', sessionId, size: next }),
    })
  },

  /** Exact size from dragging a card's edge or corner. */
  setSessionBox(sessionId: string, width: number, height: number) {
    const prev = state.sessions.find((s) => s.id === sessionId)
    conn.send({ t: 'session.setBox', sessionId, width, height })
    if (prev) {
      record({
        label: 'resize card',
        undo: () => conn.send({ t: 'session.setBox', sessionId, width: prev.width, height: prev.height }),
        redo: () => conn.send({ t: 'session.setBox', sessionId, width, height }),
      })
    }
  },

  setDocBox(cardId: string, width: number, height: number) {
    const prev = state.docs.find((d) => d.id === cardId)
    conn.send({ t: 'doc.setBox', cardId, width, height })
    if (prev) {
      record({
        label: 'resize card',
        undo: () => conn.send({ t: 'doc.setBox', cardId, width: prev.width, height: prev.height }),
        redo: () => conn.send({ t: 'doc.setBox', cardId, width, height }),
      })
    }
  },

  /**
   * Text size inside one card, nudged with ctrl and the wheel.
   *
   * Not recorded for undo: a wheel produces a stream of small steps, and filling the undo stack
   * with fifty of them would bury the edits that matter.
   */
  nudgeSessionFont(sessionId: string, delta: number) {
    const s = state.sessions.find((x) => x.id === sessionId)
    const current = s?.fontSize ?? 11
    const next = Math.max(7, Math.min(28, current + delta))
    if (next === current) return
    conn.send({ t: 'session.setFontSize', sessionId, fontSize: next })
  },

  /**
   * Show this card its terminal, or its conversation.
   *
   * Recorded for undo, unlike the font nudge above, because this is one deliberate press rather than
   * a stream of wheel steps, and it changes what the card is showing rather than how big it is.
   */
  setBodyView(sessionId: string, bodyView: 'terminal' | 'chat') {
    const s = state.sessions.find((x) => x.id === sessionId)
    const prev = s?.bodyView ?? null
    if (prev === bodyView) return
    conn.send({ t: 'session.setBodyView', sessionId, bodyView })
    record({
      label: bodyView === 'chat' ? 'show the conversation' : 'show the terminal',
      undo: () => conn.send({ t: 'session.setBodyView', sessionId, bodyView: prev ?? 'terminal' }),
      redo: () => conn.send({ t: 'session.setBodyView', sessionId, bodyView }),
    })
  },

  nudgeDocFont(cardId: string, delta: number) {
    const d = state.docs.find((x) => x.id === cardId)
    const current = d?.fontSize ?? 12
    const next = Math.max(7, Math.min(28, current + delta))
    if (next === current) return
    conn.send({ t: 'doc.setFontSize', cardId, fontSize: next })
  },

  setSessionCollapsed(sessionId: string, collapsed: boolean) {
    conn.send({ t: 'session.setCollapsed', sessionId, collapsed })
    record({
      label: collapsed ? 'compact card' : 'expand card',
      undo: () => conn.send({ t: 'session.setCollapsed', sessionId, collapsed: !collapsed }),
      redo: () => conn.send({ t: 'session.setCollapsed', sessionId, collapsed }),
    })
  },

  // --- documents ---

  /**
   * `x`/`y` are board coordinates from wherever the menu was opened, same as `newSession` sends
   * for a terminal.
   *
   * `doc.create` does not carry them on the wire type yet; the server still places every new
   * document card at a fixed spot regardless of where it was asked for. That is the other half of
   * this same fix, in flight on the server side. Sent anyway, through a named variable rather than
   * an inline literal so the extra fields do not trip the excess-property check TypeScript runs on
   * an object literal passed straight to a call: once the wire type grows `x`/`y` this needs no
   * change, and until then the position is simply not read yet rather than rejected.
   */
  createDoc(projectId: string, relPath: string, x?: number, y?: number) {
    const msg: { t: 'doc.create'; projectId: string; relPath: string; x?: number; y?: number } = {
      t: 'doc.create',
      projectId,
      relPath,
      x,
      y,
    }
    conn.send(msg)
  },

  openDoc(projectId: string, relPath: string) {
    conn.send({ t: 'doc.open', projectId, relPath })
  },

  readDoc(cardId: string) {
    conn.send({ t: 'doc.read', cardId })
  },

  // --- message cards ---

  createChannel(projectId: string, x?: number, y?: number) {
    conn.send({ t: 'channel.create', projectId, x, y })
  },
  readChannel(channelId: string) {
    conn.send({ t: 'channel.read', channelId })
  },
  /**
   * Write the file as he edited it, and say the write is in flight rather than done.
   *
   * The pending state is set here, on the send, not on the answer. That is what makes the card able
   * to draw "saving" and then either "saved" or the reason it did not, instead of flipping to a
   * confirmation the moment a button is pressed. Nothing here knows whether the bytes landed; only
   * the server does, and it answers with `channel.saved`.
   */
  /*
   * `baseMtime` is passed in by the card, and reading it here instead is the bug this argument
   * exists to prevent.
   *
   * It has to be the mtime from when the editor OPENED. Read at save time it is whatever the file
   * now says, which after the card has replied is the reply's own timestamp, so the check compares
   * the newest write against itself and passes. Measured: the card appended mid-edit, the save went
   * through, the reply was erased and the card drew "saved 09:23:55" over the top of it.
   */
  saveChannel(channelId: string, text: string, baseMtime: number) {
    channelSaveState.set(channelId, { status: 'pending', at: Date.now() })
    const listeners = channelSubs.get(channelId)
    if (listeners) for (const fn of listeners) fn()
    conn.send({ t: 'channel.save', channelId, text, baseMtime })
  },
  sendChannel(channelId: string, text: string) {
    conn.send({ t: 'channel.send', channelId, text })
  },
  moveChannel(channelId: string, x: number, y: number) {
    conn.send({ t: 'channel.move', channelId, x, y })
  },
  setChannelBox(channelId: string, width: number, height: number) {
    conn.send({ t: 'channel.setBox', channelId, width, height })
  },
  setChannelFontSize(channelId: string, fontSize: number | null) {
    conn.send({ t: 'channel.setFontSize', channelId, fontSize })
  },
  deleteChannel(channelId: string) {
    conn.send({ t: 'channel.delete', channelId })
  },

  /**
   * Writes the file back to disk. The server refuses any path outside the project.
   *
   * Returns the token for this save, so a card can tell an answer to its own write from an answer to
   * one it has already replaced.
   */
  saveDoc(cardId: string, content: string) {
    const token = ++docSaveToken
    /*
     * Recorded as outstanding, NOT as done. This used to call setDocContent here, which told the
     * card that the file now held the draft before anything had written it, so a save that failed
     * and a save that was never answered both looked exactly like one that had worked.
     */
    docSaveState.set(cardId, { status: 'pending', token, at: Date.now(), content })
    // The mtime the card last read is sent with the write, so the server can refuse to clobber
    // an edit an agent made in between rather than silently winning.
    conn.send({ t: 'doc.save', cardId, content, baseMtime: docMtime.get(cardId) })
    for (const fn of docSubs) fn()
    return token
  },

  attachDoc(cardId: string, sessionId: string) {
    conn.send({ t: 'doc.attach', cardId, sessionId })
  },

  detachDoc(cardId: string) {
    conn.send({ t: 'doc.detach', cardId })
  },

  /**
   * Take a card off the board without destroying it.
   *
   * The board only ever had delete, which ended a session, removed its history and cascaded into
   * every card it had hired. Closing is the everyday action and this is it: the card moves to the
   * closed list in the sidebar and can be brought back.
   */
  /**
   * Ask the server for a card's conversation, read from its transcript.
   *
   * On demand rather than pushed: a transcript is a file that grows with no event meaning "another
   * line was written", so the card asks again when its status changes, which is when there is
   * likely something new to read.
   */
  readAgentChat(sessionId: string) {
    conn.send({ t: 'agent.chat', sessionId })
  },

  /**
   * Send a line to a spawned agent, through the terminal of the card that hired it.
   *
   * The answer comes back separately and may be a refusal, so the card has to wait for it rather
   * than assuming the line went. A subagent is reachable only while it is running, and only when
   * Garden can tell its row apart from the others on the parent's screen.
   */
  sayToAgent(sessionId: string, text: string) {
    conn.send({ t: 'agent.say', sessionId, text })
  },

  closeSession(sessionId: string) {
    conn.send({ t: 'session.close', sessionId })
  },

  restoreSession(sessionId: string) {
    conn.send({ t: 'session.restore', sessionId })
  },

  closeDoc(cardId: string) {
    const d = state.docs.find((x) => x.id === cardId)
    conn.send({ t: 'doc.close', cardId })
    if (d && !d.web) {
      record({
        label: 'close document',
        undo: () => conn.send({ t: 'doc.open', projectId: d.projectId, relPath: d.relPath }),
        redo: () => {
          const again = state.docs.find((x) => x.relPath === d.relPath && x.projectId === d.projectId)
          if (again) conn.send({ t: 'doc.close', cardId: again.id })
        },
      })
    }
  },

  /**
   * Pick up a whole web and put it somewhere, in one step that can be undone in one press.
   *
   * By distance rather than to a coordinate, because a frame is derived from where its cards are
   * and has no stored position to send back to.
   */
  moveWeb(sessionId: string, web: 'context' | 'history', dx: number, dy: number) {
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    conn.send({ t: 'web.move', sessionId, web, dx, dy })
    record({
      label: `move ${web === 'history' ? 'history' : 'roots'}`,
      undo: () => conn.send({ t: 'web.move', sessionId, web, dx: -dx, dy: -dy }),
      redo: () => conn.send({ t: 'web.move', sessionId, web, dx, dy }),
    })
  },

  moveDoc(cardId: string, x: number, y: number) {
    const prev = state.docs.find((d) => d.id === cardId)
    const from = prev ? { x: prev.x, y: prev.y } : null
    conn.send({ t: 'doc.move', cardId, x, y })
    if (from && (from.x !== x || from.y !== y)) {
      record({
        label: 'move card',
        undo: () => conn.send({ t: 'doc.move', cardId, x: from.x, y: from.y }),
        redo: () => conn.send({ t: 'doc.move', cardId, x, y }),
      })
    }
  },

  createWire(projectId: string, sourceId: string, targetId: string, label?: string) {
    conn.send({ t: 'wire.create', projectId, sourceId, targetId, label })
    record({
      label: 'draw wire',
      undo: () => {
        const w = state.wires.find((x) => x.sourceId === sourceId && x.targetId === targetId)
        if (w) conn.send({ t: 'wire.delete', wireId: w.id })
      },
      redo: () => conn.send({ t: 'wire.create', projectId, sourceId, targetId, label }),
    })
  },

  /** One arrowhead or two: which way this connection is allowed to carry work. */
  setWireDirection(wireId: string, bidirectional: boolean) {
    conn.send({ t: 'wire.setDirection', wireId, bidirectional })
  },

  setWireKind(wireId: string, kind: 'manual' | 'derived' | 'blind') {
    conn.send({ t: 'wire.setKind', wireId, kind })
  },

  labelWire(wireId: string, label: string) {
    conn.send({ t: 'wire.label', wireId, label })
  },

  deleteWire(wireId: string) {
    const w = state.wires.find((x) => x.id === wireId)
    conn.send({ t: 'wire.delete', wireId })
    if (w) {
      record({
        label: 'delete wire',
        undo: () =>
          conn.send({
            t: 'wire.create',
            projectId: w.projectId,
            sourceId: w.sourceId,
            targetId: w.targetId,
            label: w.label,
            kind: w.kind,
          }),
        redo: () => {
          const again = state.wires.find((x) => x.sourceId === w.sourceId && x.targetId === w.targetId)
          if (again) conn.send({ t: 'wire.delete', wireId: again.id })
        },
      })
    }
  },

  openContextWeb(
    sessionId: string,
    group?: 'instructions' | 'memory' | 'research' | 'settings' | 'skills' | 'agents' | 'hooks' | 'guards',
    /** Where this column's rows belong, which is directly under its own pill. */
    at?: { x: number; y: number },
  ) {
    conn.send({ t: 'context.open', sessionId, group, at })
  },

  /**
   * Unfold the roots as columns: what kinds of thing this card runs from, and how many of each.
   *
   * This is what the bottom dot does now. Opening every file was the honest thing when a card ran
   * from a handful of them and became unusable once it ran from a hundred and seventeen, which is
   * the number the owner had in front of him. A column is one node instead of forty, so the board
   * stays responsive, and the count on it is the same number that would have arrived as cards.
   *
   * Asking the server for the list is a read. Nothing is opened until a column is clicked.
   */
  openContextColumns(sessionId: string) {
    contextColumns.add(sessionId)
    conn.send({ t: 'context.list', sessionId })
    for (const fn of contextSubs) fn(sessionId)
  },

  /** Open exactly the files chosen from the picker, rather than a whole group. */
  openContextFiles(sessionId: string, only: string[]) {
    conn.send({ t: 'context.open', sessionId, only })
  },

  /** Ask what a session runs from, so it can be offered as a grouped list. */
  listContext(sessionId: string) {
    conn.send({ t: 'context.list', sessionId })
  },

  /**
   * Set what a card is for and what it may do.
   *
   * Takes effect when the session is next started, because the CLI reads its permissions once at
   * launch. The card's own panel says so rather than the change looking instant.
   */
  setSessionRole(
    sessionId: string,
    patch: {
      /*
       * Read off `TerminalSession` itself rather than retyped, so this union changes the moment
       * the shared one does. It was a separate hand-copied list until this line, and roles have
       * already been added, removed and renamed once since this file was last touched.
       */
      roleClass?: TerminalSession['roleClass']
      canSpawnAgents?: boolean
      canUseTeams?: boolean
      // Three states, so null is a value the card can send rather than an omission: it means this
      // card withdraws its own answer and follows the board again.
      subagentsAllowed?: boolean | null
      teamSize?: number | null
      modelChoice?: string | null
      effortChoice?: string | null
      reportsTo?: string | null
    },
  ) {
    conn.send({ t: 'session.setRole', sessionId, ...patch })
  },

  /**
   * Push a model or effort change into a session that is already running.
   *
   * The settings file only reaches a session at launch, so without this a change would sit on the
   * card looking applied while the session carried on unchanged. This types the CLI's own command
   * into the terminal, which is the only supported way in.
   */
  applyNow(sessionId: string, what: 'model' | 'effort') {
    conn.send({ t: 'session.applyNow', sessionId, what })
  },

  /** Save where every card is now, under a name. Positions only, so nothing is claimed about processes. */
  saveLayout(projectId: string, name: string, basedOn?: string | null) {
    conn.send({ t: 'layout.save', projectId, name, basedOn: basedOn ?? null })
  },

  restoreLayout(layoutId: string) {
    conn.send({ t: 'layout.restore', layoutId })
  },

  deleteLayout(layoutId: string) {
    conn.send({ t: 'layout.delete', layoutId })
  },

  /** Asks for this project's ceiling and what is currently counted against it. */
  refreshLimits(projectId: string) {
    conn.send({ t: 'limits.get', projectId })
  },

  /**
   * Changes the ceiling itself. Written as asked, including below what the board already holds:
   * the server never reaches back to something already running, so lowering a limit mid-task is
   * safe rather than destructive.
   */
  setLimits(projectId: string, limits: BoardLimits) {
    conn.send({ t: 'limits.set', projectId, limits })
  },

  listLayouts(projectId: string) {
    conn.send({ t: 'layout.list', projectId })
  },

  /** Ask for a session's work history, so the history web can show what it actually did. */
  listWork(sessionId: string) {
    conn.send({ t: 'work.list', sessionId })
  },

  /**
   * Ask what this session's runs actually reached, stage by stage.
   *
   * Fire and forget, like everything else on this socket: the answer arrives as a broadcast and
   * is handled in the reducer above. Asking again is how the panel refreshes, since a run in
   * progress changes stage without any event meaning "your pipeline moved".
   */
  readPipeline(sessionId: string) {
    conn.send({ t: 'pipeline.get', sessionId })
  },

  /** Unfold what this card's runs reached, beside it, and ask the server for the answer. */
  openPipeline(sessionId: string) {
    if (!state.pipelineOpen.includes(sessionId)) {
      set({ pipelineOpen: [...state.pipelineOpen, sessionId] })
    }
    actions.readPipeline(sessionId)
  },

  closePipeline(sessionId: string) {
    pipelineAt.delete(sessionId)
    set({ pipelineOpen: state.pipelineOpen.filter((id) => id !== sessionId) })
  },

  togglePipeline(sessionId: string) {
    if (state.pipelineOpen.includes(sessionId)) actions.closePipeline(sessionId)
    else actions.openPipeline(sessionId)
  },

  /** Remember where an open panel was dragged to, so redrawing the board does not snap it back. */
  movePipeline(sessionId: string, x: number, y: number) {
    pipelineAt.set(sessionId, { x, y })
    // Nothing subscribes to this map, so nudge the store to redraw the canvas.
    set({ pipelineOpen: [...state.pipelineOpen] })
  },

  /** Opens an agent card's transcript as a document card, in place of a dead icon. */
  openTranscript(sessionId: string) {
    conn.send({ t: 'transcript.open', sessionId })
  },

  /**
   * Fold one column back to its pill, leaving the rest of the roots as they are.
   *
   * The card stays in columns mode, so the pill reappears the moment its files are gone and the
   * column can be opened again. Without this a column was a one-way door: "i cant collapse them
   * after they are opened".
   */
  closeContextColumn(sessionId: string, group: string) {
    contextColumns.add(sessionId)
    conn.send({ t: 'context.close', sessionId, group })
    for (const fn of contextSubs) fn(sessionId)
  },

  closeContextWeb(sessionId: string) {
    // The columns go with the files. Folding away means folding away.
    contextColumns.delete(sessionId)
    for (const fn of contextSubs) fn(sessionId)
    conn.send({ t: 'context.close', sessionId })
  },

  /**
   * Show or hide the pictures a turn reviewed.
   *
   * Derived from whether any are already on the board rather than from a stored flag, for the same
   * reason the webs work that way: the board is the state, so there is nothing to fall out of step
   * with it.
   */
  toggleEvidence(cardId: string) {
    const open = state.docs.some((d) => d.ownerId === cardId)
    conn.send(open ? { t: 'evidence.close', cardId } : { t: 'evidence.open', cardId })
  },

  /**
   * Ask what days this card has, which is what the arrow on the card does now.
   *
   * It used to unfold every turn at once. On a card that has been working for days that is dozens
   * arriving together, which is the same fault the roots had before they became columns.
   */
  openHistoryWeb(sessionId: string) {
    conn.send({ t: 'history.groups', sessionId })
  },

  /**
   * Ask the server to stop and come back.
   *
   * Nothing here is optimistic: the socket dies a moment later and the header's own connection badge
   * says so, which is the honest reading of the state until a new server answers. `revive` on the
   * far side starts the cards that were running and resumes their conversations.
   */
  restartServer() {
    conn.send({ t: 'server.restart' })
  },

  /** Put one day's turns on the board. */
  openHistoryDay(sessionId: string, group: string) {
    conn.send({ t: 'history.open', sessionId, group })
  },

  /** Fold one day back to its pill, leaving the other days where they are. */
  closeHistoryDay(sessionId: string, group: string) {
    conn.send({ t: 'history.closeGroup', sessionId, group })
  },

  /**
   * Fold the whole history block away, days included.
   *
   * The local forget is the half that was missing, and without it history could not be folded away
   * at all. `history.close` deletes the turn cards on the server and broadcasts their removal, but
   * the days are not cards: they are drawn from the last `history.groups` answer, which the server
   * has no reason to send again. So the turn cards went and the row of day pills stayed, and since
   * the arrow reads "open" from the same set, it went back to reading "History" and reopened on the
   * next press instead of folding.
   */
  closeHistoryWeb(sessionId: string) {
    conn.send({ t: 'history.close', sessionId })
    forgetHistoryGroups(sessionId)
  },

  /**
   * Move many cards at once, for the arrangement presets.
   *
   * One message per card would make an arrangement land piecemeal and fill the undo stack with
   * fifty steps; this is one action that can be undone in one press.
   */
  applyArrangement(moves: Array<{ id: string; kind: 'session' | 'doc'; x: number; y: number }>) {
    const before = moves.map((m) => {
      const card =
        m.kind === 'doc' ? state.docs.find((d) => d.id === m.id) : state.sessions.find((s) => s.id === m.id)
      return { id: m.id, kind: m.kind, x: card?.x ?? m.x, y: card?.y ?? m.y }
    })
    /*
     * One message for the whole board, not one per card.
     *
     * Sent individually, each move was nudged clear of the cards that had not moved yet, so the
     * board was measured against itself half-updated and the arrangement's shape did not survive
     * the trip. The layout already guarantees nothing overlaps, so it goes over as a single set.
     */
    const send = (list: typeof moves) => {
      conn.send({ t: 'board.arrange', positions: list.map((m) => ({ id: m.id, x: m.x, y: m.y })) })
    }
    send(moves)
    record({ label: 'arrange the board', undo: () => send(before), redo: () => send(moves) })
  },

  /** Tell the server where cards actually ended up after packing, so it can place new ones. */
  reportLayout(positions: Array<{ id: string; x: number; y: number }>) {
    if (positions.length) conn.send({ t: 'board.layout', positions })
  },

  /** Forget every manual position in this project and let the packer lay it out again. */
  tidyBoard(projectId: string) {
    conn.send({ t: 'board.tidy', projectId })
  },

  /** Puts a document card back to its own size, used when closing one that was opened to edit. */
  setDocSize(cardId: string, size: 'normal' | 'large' | 'full') {
    const d = state.docs.find((x) => x.id === cardId)
    const current = d?.size ?? 'normal'
    if (current === size) return
    conn.send({ t: 'doc.setSize', cardId, size })
    record({
      label: 'resize card',
      undo: () => conn.send({ t: 'doc.setSize', cardId, size: current }),
      redo: () => conn.send({ t: 'doc.setSize', cardId, size }),
    })
  },

  /** Steps a document card up through its own size, a working size, then the whole workspace. */
  toggleDocSize(cardId: string) {
    const d = state.docs.find((x) => x.id === cardId)
    const current = d?.size ?? 'normal'
    const next = current === 'normal' ? 'large' : 'normal'
    conn.send({ t: 'doc.setSize', cardId, size: next })
    record({
      label: next === 'normal' ? 'shrink card' : 'expand card',
      undo: () => conn.send({ t: 'doc.setSize', cardId, size: current }),
      redo: () => conn.send({ t: 'doc.setSize', cardId, size: next }),
    })
  },

  cycleDocSize(cardId: string, direction: 1 | -1) {
    const d = state.docs.find((x) => x.id === cardId)
    const order = ['normal', 'large', 'full'] as const
    const current = d?.size ?? 'normal'
    const i = Math.max(0, order.indexOf(current))
    const next = order[(i + direction + order.length) % order.length]!
    conn.send({ t: 'doc.setSize', cardId, size: next })
    record({
      label: direction > 0 ? 'expand card' : 'shrink card',
      undo: () => conn.send({ t: 'doc.setSize', cardId, size: current }),
      redo: () => conn.send({ t: 'doc.setSize', cardId, size: next }),
    })
  },

  setDocCollapsed(cardId: string, collapsed: boolean) {
    conn.send({ t: 'doc.setCollapsed', cardId, collapsed })
    record({
      label: collapsed ? 'compact card' : 'expand card',
      undo: () => conn.send({ t: 'doc.setCollapsed', cardId, collapsed: !collapsed }),
      redo: () => conn.send({ t: 'doc.setCollapsed', cardId, collapsed }),
    })
  },
}
