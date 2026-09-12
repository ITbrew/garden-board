/**
 * The hook spine: turning what the CLI says into what the board shows.
 *
 * Everything here is downstream of a real event. Nothing in this file infers a stage from
 * silence, reads prose to decide what an agent did, or paints a status from timing. If the CLI
 * did not say it, the board does not claim it, and a field stays null rather than being filled
 * in with a plausible number.
 *
 * Two identifiers do all the work. `gardenSessionId` is an environment variable Garden set when
 * it spawned the shell, inherited by the CLI and by every hook it runs, which ties an event to a
 * card without matching on pids or working directories. `prompt_id` ties every event from one
 * turn together, which is what makes a history record a turn rather than a pile of tool calls.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAX_TAIL_BYTES, TAIL_BYTES, readChat, tailLines } from './transcript.js'
import type {
  AgentEvent,
  ServerMessage,
  SessionStatus,
  TerminalSession,
  Wire,
  WorkRecord,
} from '@garden/shared'
import type { Store } from './store.js'
import { contextWindowFor } from './tokens.js'

export interface IngestDeps {
  store: Store
  broadcast: (msg: ServerMessage) => void
  /** Somewhere free on the board beside the parent card, so a new child never lands on anything. */
  placeChild: (parent: TerminalSession, w: number, h: number) => { x: number; y: number }
  /**
   * Create this card's own notes directory.
   *
   * Spawned agents get one for the same reason sessions do: a card that has done a job forty
   * times in this project should be better at it than a fresh one, and the only way that happens
   * is if what it learned outlives the process. The directory is keyed to the card, so it
   * survives the agent exiting, the app restarting, and the card being renamed.
   */
  ensureCardMemory: (session: TerminalSession) => void
  /**
   * Rewrite a card's PEERS.md from the wires it currently has.
   *
   * A wire is only half of a connection. The other half is the card knowing the wire is there, and
   * that lives in PEERS.md, which is written from the wire table. Cards created here get wires, so
   * they need this too, or a card is joined to a peer it has never been told about and the line on
   * the board describes a conversation neither end can start.
   */
  refreshMail: (cardId: string) => void
}

/** A hook payload, as posted by `server/hooks/garden-hook.mjs`. */
export interface HookBody {
  gardenSessionId: string | null
  receivedAt: number
  event: Record<string, unknown>
}

/*
 * The same size a card the owner makes himself gets.
 *
 * These were smaller because an agent card used to hold three lines of facts and nothing else. It
 * now holds the same things every other card holds: its conversation, its history block above and
 * its roots below. Drawn at two thirds the size beside its neighbours it read as a lesser kind of
 * card, which a blind reviewer picked out immediately, and the owner's whole point was that a
 * spawned agent gets the same card as anything else on the board.
 *
 * Kept in step with CARD_W and CARD_H in index.ts by hand, since one is the size the server places
 * new cards at and this is the size it places hired ones at.
 */
const CHILD_W = 340
const CHILD_H = 260

/**
 * Context window sizes, used only to turn a token count into the gauge on a card.
 *
 * A model this does not recognise leaves the gauge blank rather than assuming 200k. The gauge
 * exists to answer "is this session too full to trust", and a wrong denominator answers it
 * confidently and wrongly, which is the one outcome worth avoiding.
 */
/*
 * One table for the window a card is measured against, shared with the terminal reader.
 *
 * There were two, and they disagreed. This one gave Opus 200,000 while tokens.ts measured every
 * card against a flat million, so the same bar jumped by a factor of five depending on which source
 * last reported, and the transcript is usually the one that wins.
 */
const contextLimitFor = contextWindowFor

/**
 * Colour by role, so a board of agents reads as a team rather than a pile of identical cards.
 *
 * Every card of the same agent type gets the same colour on every board and across restarts,
 * because it is derived from the name rather than handed out in spawn order. Two Explore agents
 * that looked different from each other would be worse than no colour at all.
 */
const ROLE_COLORS = ['#7c5cff', '#2dd4bf', '#f59e0b', '#ec4899', '#38bdf8', '#a3e635', '#fb7185', '#c084fc']

function colorForRole(role: string | null): string | null {
  if (!role) return null
  let h = 0
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) >>> 0
  return ROLE_COLORS[h % ROLE_COLORS.length]!
}

/** Field names arrive snake_case on stdin. Read both, because the CLI's own docs use each. */
function pick(o: Record<string, unknown>, ...names: string[]): string | null {
  for (const n of names) {
    const v = o[n]
    if (typeof v === 'string' && v) return v
  }
  return null
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const DISPATCH_TOOLS = new Set(['Task', 'Agent'])

/** Top-level payload fields some reader actually opens on a tool event. */
const TOOL_KEEP = ['tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'prompt_id', 'agent_type', 'agentType']

/** Fields inside `tool_input` some reader actually opens. Everything else in it is dropped. */
const TOOL_INPUT_KEEP = ['file_path', 'path', 'command', 'description', 'subagent_type']

/** Past this, nothing reads a command: the close stage slices to 200 and the review stage matches a word. */
const COMMAND_CAP = 500

/**
 * What a tool event is stored as.
 *
 * A hook payload for a tool call carries the whole body the tool returned, and on 2026-09-08 that
 * field, `tool_response`, was 802 MB of the events table's 1,026 MB. Nothing had ever read it: not
 * the pipeline, not history, not the boundary check, not the web. It was write-only from the day it
 * was added, and the owner found it as "history kind of useless if its producing that much useless
 * data".
 *
 * So this keeps the fields that have a reader and drops the rest. The lists above are not a guess
 * about what might be wanted later; they are every field read by every consumer, each one found
 * before this was written and named in `docs/canonical/09-what-is-stored.md`. The consequence, which
 * is why that document carries the list too: a reader that starts needing a new field has to add it
 * here first, because the rows already written will not have it.
 */
export function trimToolPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of TOOL_KEEP) {
    if (payload[k] !== undefined) out[k] = payload[k]
  }
  const input = (payload.tool_input ?? payload.toolInput) as Record<string, unknown> | undefined
  if (input && typeof input === 'object') {
    const kept: Record<string, unknown> = {}
    for (const k of TOOL_INPUT_KEEP) {
      const v = input[k]
      if (v === undefined) continue
      kept[k] = k === 'command' && typeof v === 'string' ? v.slice(0, COMMAND_CAP) : v
    }
    // An empty object rather than a missing key: `toolInputOf` reads a shape, not a presence.
    out.tool_input = kept
  }
  return out
}

export class Ingest {
  private store: Store
  private broadcast: (msg: ServerMessage) => void
  private placeChild: IngestDeps['placeChild']
  private ensureCardMemory: IngestDeps['ensureCardMemory']
  private refreshMail: IngestDeps['refreshMail']

  /**
   * Dispatch calls seen but not yet matched to a SubagentStart, keyed by tool_use_id. The Agent
   * call carries the description and the agent type the owner asked for; the start event carries
   * the id the rest of the run uses. Holding the first until the second arrives is what lets a
   * child card be born already named.
   */
  private pendingDispatch = new Map<string, { sessionId: string; label: string; agentType: string | null; at: number }>()

  constructor(deps: IngestDeps) {
    this.store = deps.store
    this.broadcast = deps.broadcast
    this.placeChild = deps.placeChild
    this.ensureCardMemory = deps.ensureCardMemory
    this.refreshMail = deps.refreshMail
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  handle(body: HookBody) {
    const e = body.event ?? {}
    const type = pick(e, 'hook_event_name', 'hookEventName') ?? 'Unknown'
    const claudeSessionId = pick(e, 'session_id', 'sessionId')
    const promptId = pick(e, 'prompt_id', 'promptId')

    const session = this.resolve(body.gardenSessionId, claudeSessionId)
    if (!session) return

    // Learn the CLI's session id and transcript once, from the first event that carries them.
    const patch: Partial<TerminalSession> = {}
    if (claudeSessionId && session.claudeSessionId !== claudeSessionId) patch.claudeSessionId = claudeSessionId
    const transcript = pick(e, 'transcript_path', 'transcriptPath')
    if (transcript && session.transcriptPath !== transcript) patch.transcriptPath = transcript
    /*
     * The model, whenever a payload happens to name it.
     *
     * Not every hook event carries one, and there is no other file Garden can read that publishes
     * it, so this takes it from whichever event does and leaves the label off the card entirely
     * until then. A card that guessed which model it was running would be worse than one that
     * admits it does not know, since the answer is what a turn costs.
     */
    const model = pick(e, 'model')
    if (model && session.model !== model) patch.model = model
    const permissionMode = pick(e, 'permission_mode', 'permissionMode')
    if (permissionMode && session.permissionMode !== permissionMode) patch.permissionMode = permissionMode
    /*
     * The effort a session is actually running at, when a payload carries it.
     *
     * Nothing was reading this, so the card's Running row said "effort not reported" forever while
     * the CLI was publishing it. It arrives nested rather than flat, which is why the flat reader
     * above missed it. Still absent rather than assumed when no payload names one.
     */
    const effort = typeof (e as any)?.effort?.level === 'string' ? (e as any).effort.level : pick(e, 'effort')
    if (effort && session.effort !== effort) patch.effort = effort
    if (Object.keys(patch).length) this.update(session.id, patch)

    this.record(session.id, type, e, body.receivedAt)

    switch (type) {
      case 'SessionStart':
        this.setStatus(session.id, 'idle', null)
        break

      case 'UserPromptSubmit': {
        const ask = pick(e, 'prompt') ?? ''
        this.openWork(session.id, promptId, 'owner', null, ask, body.receivedAt)
        this.setStatus(session.id, 'working', null)
        break
      }

      case 'PreToolUse':
        this.onPreTool(session, e)
        break

      case 'PostToolUse':
        this.onPostTool(session, e, promptId)
        break

      case 'Notification':
      case 'PermissionRequest': {
        const reason =
          pick(e, 'waiting_for', 'waitingFor') ??
          pick(e, 'message') ??
          (type === 'PermissionRequest' ? 'permission prompt' : 'input needed')
        this.setStatus(session.id, 'needs-input', reason)
        break
      }

      case 'PermissionDenied':
        // Recorded above and nothing more: a denial is the guard's business, not the board's.
        break

      case 'Stop':
        this.closeWork(session.id, promptId, body.receivedAt)
        this.setStatus(session.id, 'idle', null)
        /*
         * Twice, because the hook fires the moment the turn ends and the transcript is flushed a
         * beat later. Reading only once left the context gauge permanently blank on a real
         * session while every synthetic test passed, which is exactly the class of bug that only
         * a live run finds.
         */
        this.readUsage(session.id)
        this.pushChat(session.id)
        setTimeout(() => {
          this.readUsage(session.id)
          this.pushChat(session.id)
        }, 2500).unref?.()
        break

      case 'SessionEnd':
        this.closeWork(session.id, promptId, body.receivedAt)
        this.setStatus(session.id, 'done', null)
        break

      case 'SubagentStart':
        this.onSubagentStart(session, e, body.receivedAt)
        break

      case 'SubagentStop':
        this.onSubagentStop(e, body.receivedAt)
        break

      case 'TaskCreated':
        this.onTaskCreated(session, e, body.receivedAt)
        break

      case 'TaskCompleted':
      case 'TeammateIdle':
        this.onTeammateUpdate(e, type, body.receivedAt)
        break
    }
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Which card an event belongs to.
   *
   * The environment variable is exact and wins. The CLI session id is the fallback for the case
   * that matters in practice: `/clear` or a resumed conversation changes the session id mid-life,
   * and the variable still holds. Nothing here falls back to matching on working directory,
   * because two cards open on the same folder is the normal case on this board, not a rare one.
   */
  private resolve(gardenSessionId: string | null, claudeSessionId: string | null): TerminalSession | undefined {
    if (gardenSessionId) {
      const byEnv = this.store.getSession(gardenSessionId)
      if (byEnv) return byEnv
    }
    if (claudeSessionId) return this.store.findSessionByClaudeId(claudeSessionId)
    return undefined
  }

  private update(id: string, patch: Partial<TerminalSession>) {
    const current = this.store.getSession(id)
    if (!current) return
    const next = { ...current, ...patch }
    this.store.upsertSession(next)
    this.broadcast({ t: 'session.updated', session: next })
  }

  private setStatus(id: string, status: SessionStatus, waitingFor: string | null) {
    const current = this.store.getSession(id)
    if (!current) return
    if (current.status === status && current.waitingFor === waitingFor) return
    this.update(id, { status, waitingFor, statusSince: Date.now() })
  }

  private record(sessionId: string, type: string, payload: Record<string, unknown>, ts: number) {
    const event: AgentEvent = {
      id: randomUUID(),
      sessionId,
      ts,
      type,
      // Trimmed only for the two types that carry a tool body. Everything else is small and is
      // stored whole, so a refusal, a dispatch or a mail hop reads exactly as it always has.
      payload:
        type === 'PreToolUse' || type === 'PostToolUse' ? trimToolPayload(payload) : payload,
      // A hook payload is the CLI stating a fact about itself. There is no stronger evidence in
      // this system, and nothing else in this file is allowed to claim the same grade.
      provenance: 'structured',
    }
    this.store.insertEvent(event)
    this.broadcast({ t: 'event', event })
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  private openWork(
    sessionId: string,
    promptId: string | null,
    origin: 'owner' | 'agent',
    parentId: string | null,
    ask: string,
    at: number,
  ): WorkRecord {
    const existing = promptId ? this.store.findOpenWork(sessionId, promptId) : undefined
    if (existing) return existing
    const rec: WorkRecord = {
      id: randomUUID(),
      sessionId,
      promptId,
      origin,
      parentId,
      ask: ask.slice(0, 4000),
      startedAt: at,
      endedAt: null,
      filesTouched: [],
      tasksCompleted: [],
      toolCalls: 0,
    }
    this.store.upsertWork(rec)
    this.broadcast({ t: 'work', sessionId, records: this.store.listWork(sessionId) })
    return rec
  }

  private closeWork(sessionId: string, promptId: string | null, at: number) {
    const open = this.store.findOpenWork(sessionId, promptId)
    if (!open || open.endedAt) return
    this.store.upsertWork({ ...open, endedAt: at })
    this.broadcast({ t: 'work', sessionId, records: this.store.listWork(sessionId) })
  }

  /**
   * The states canon 20 counts as the end of a task, from history's point of view.
   *
   * `done` and `confirmed` are the two a delivered message can actually produce today; `closed` is
   * in the list because canon names it as an end and leaving it out would make this set quietly
   * disagree with the document it comes from, not because anything reaches it yet.
   *
   * A static member rather than a module constant so the rule sits beside the only thing that uses
   * it, and so the mail door imports one name rather than repeating two string literals.
   */
  static readonly TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(['done', 'confirmed', 'closed'])

  /**
   * A task reached a terminal state, and this card's open turn is what moved it there.
   *
   * The other half of what a turn can have done. Files come in through `onPostTool`, which is the
   * CLI reporting its own write; this comes in from the mail door, after the transition has already
   * been written to the task table. Both are facts the board observed rather than claims an agent
   * made about itself, and that is the only grade of fact a history page is allowed to rest on.
   *
   * Called with no prompt id, because the transition arrives over HTTP from a shim the card ran
   * inside its turn and nothing on that request carries one. `findOpenWork` with a null id takes
   * the newest turn this card has not closed yet, which is the turn the shim ran in.
   *
   * A card with no open turn records nothing at all. That happens when the owner moves a task from
   * the board himself, or when a card's mail somehow lands after its `Stop`: there is no turn to
   * attribute the completion to, and inventing one, or hanging it on the previous turn, would put a
   * sentence on a page that nothing could check. History would rather be short than wrong.
   */
  noteTaskCompleted(sessionId: string, taskId: string) {
    const open = this.store.findOpenWork(sessionId, null)
    if (!open || open.endedAt || open.tasksCompleted.includes(taskId)) return
    this.store.upsertWork({ ...open, tasksCompleted: [...open.tasksCompleted, taskId] })
    this.broadcast({ t: 'work', sessionId, records: this.store.listWork(sessionId) })
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  private onPreTool(session: TerminalSession, e: Record<string, unknown>) {
    const tool = pick(e, 'tool_name', 'toolName')
    if (!tool || !DISPATCH_TOOLS.has(tool)) return
    const id = pick(e, 'tool_use_id', 'toolUseId')
    if (!id) return
    const input = (e.tool_input ?? e.toolInput) as Record<string, unknown> | undefined
    const label =
      (typeof input?.description === 'string' && input.description) ||
      (typeof input?.subagent_type === 'string' && input.subagent_type) ||
      'subagent'
    const agentType = typeof input?.subagent_type === 'string' ? input.subagent_type : null
    this.pendingDispatch.set(id, { sessionId: session.id, label, agentType, at: Date.now() })
    // A dispatch that never produced a start event is not evidence of anything after a minute.
    for (const [key, val] of this.pendingDispatch) {
      if (Date.now() - val.at > 120_000) this.pendingDispatch.delete(key)
    }
  }

  private onPostTool(session: TerminalSession, e: Record<string, unknown>, promptId: string | null) {
    const open = this.store.findOpenWork(session.id, promptId)
    if (!open) return
    const input = (e.tool_input ?? e.toolInput) as Record<string, unknown> | undefined
    const tool = pick(e, 'tool_name', 'toolName')
    const file = typeof input?.file_path === 'string' ? input.file_path : null
    const files =
      file && tool && WRITE_TOOLS.has(tool) && !open.filesTouched.includes(file)
        ? [...open.filesTouched, file]
        : open.filesTouched
    this.store.upsertWork({ ...open, toolCalls: open.toolCalls + 1, filesTouched: files })
    this.broadcast({ t: 'work', sessionId: session.id, records: this.store.listWork(session.id) })
  }

  // -------------------------------------------------------------------------
  // Children
  // -------------------------------------------------------------------------

  /**
   * SubagentStart's payload is not a documented schema (claude-code#19170 was closed as not
   * planned), so this reads every spelling that has been observed or proposed and falls back to
   * the id of the dispatch that caused it. A card whose id came from the tool call is still tied
   * to a real event; what it must never do is invent one, because a subagent card with a made-up
   * id would silently fail to match its own stop event and sit on the board working forever.
   */
  private onSubagentStart(parent: TerminalSession, e: Record<string, unknown>, at: number) {
    const toolUseId = pick(e, 'tool_use_id', 'toolUseId')
    const agentId = pick(e, 'agent_id', 'agentId') ?? (toolUseId ? `tool:${toolUseId}` : null)
    if (!agentId) return
    if (this.store.findSessionByAgentId(agentId)) return

    const pending = toolUseId ? this.pendingDispatch.get(toolUseId) : undefined
    if (toolUseId) this.pendingDispatch.delete(toolUseId)

    const agentType = pick(e, 'agent_type', 'agentType', 'agent_name', 'agentName') ?? pending?.agentType ?? null
    /*
     * A name that says which one this is.
     *
     * The dispatch usually carries a description and that is the best name available, since it says
     * what this agent was actually sent to do. When it does not, the fallback was the agent type,
     * and a card that hires five general-purpose agents then had five cards named "general-purpose"
     * standing beside each other. Now that an agent card is drawn exactly like any other card, that
     * is genuinely unreadable: the owner could not tell whether he was looking at five agents or
     * five copies of one. Numbering them is the same thing Garden already does for the cards he
     * makes himself, which arrive as "Claude Code 4".
     */
    const base = pending?.label ?? agentType ?? 'subagent'
    const sameName = this.store
      .childSessions(parent.id)
      .filter((c) => c.title === base || c.title.startsWith(`${base} `)).length
    const title = sameName === 0 ? base : `${base} ${sameName + 1}`
    const spot = this.placeChild(parent, CHILD_W, CHILD_H)

    const child: TerminalSession = {
      id: randomUUID(),
      projectId: parent.projectId,
      profileId: parent.profileId,
      adapterId: parent.adapterId,
      kind: 'subagent',
      title: title.slice(0, 80),
      cwd: parent.cwd,
      // A subagent has no PTY of its own, so there is nothing to type into and nothing to turn
      // on. The card exists to hold what it did, which is the part that used to disappear.
      pid: null,
      status: 'working',
      waitingFor: null,
      statusSince: at,
      agentId,
      parentId: parent.id,
      transcriptPath: pick(e, 'agent_transcript_path', 'agentTranscriptPath'),
      claudeSessionId: parent.claudeSessionId,
      // Born on the board. A subagent card is closed by the same route as any other card.
      closedAt: null,
      // A subagent has no process of Garden's own, so there is no launch that could stamp this.
      roleClassRunning: null,
      // What a spawned agent may touch is the parent's business to state, not Garden's to invent.
      ownedPaths: null,
      // A subagent card stands for work inside its parent's process and is never launched itself,
      // so its generation stays where it started.
      generation: 0,
      contextUsed: null,
      tokensUsed: null,
      contextSource: null,
      // A spawned agent is a worker by default: it was hired to do one job, and a subagent that
      // hires further is the thing the owner wants to be able to switch off deliberately.
      roleClass: 'worker',
      canSpawnAgents: parent.canSpawnAgents,
      canUseTeams: false,
      // Not inherited from the parent. This is the card's own answer, and a subagent card has
      // never given one, so it follows the board like any other silent card.
      subagentsAllowed: null,
      effort: null,
      // An agent inherits what it was hired under, so a manager set to opus does not quietly get
      // a team running on something else.
      modelChoice: parent.modelChoice,
      effortChoice: parent.effortChoice,
      teamSize: null,
      // It answers to whoever hired it, which Garden saw happen rather than assumed.
      reportsTo: parent.id,
      baseWidth: null,
      baseHeight: null,
      fontSize: null,
      // Not chosen yet, so the card opens on whatever its kind suits: a session on its terminal,
      // an agent on its conversation. See TerminalSession.bodyView.
      bodyView: null,
      model: pick(e, 'model'),
      permissionMode: null,
      managed: false,
      x: spot.x,
      y: spot.y,
      width: CHILD_W,
      height: CHILD_H,
      /*
       * Placed, not packed.
       *
       * The board tiles cards into a row while none of them has been positioned by hand, which is
       * right for a fresh set of terminals and wrong the moment a hierarchy exists: it flattened
       * a parent and its children onto one baseline, so the left-to-right, top-to-bottom shape
       * the placement had just worked out was invisible on screen. A blind reviewer looking at
       * the board described a single row of six with no tiers at all, while the database held the
       * hierarchy correctly. Marking a spawned card as positioned is what makes the two agree.
       */
      manualPos: true,
      renderState: 'preview',
      pinned: false,
      /*
       * Folded to its header, because that is how the owner actually uses these.
       *
       * His words: he rarely interacts with a subagent, he wants it kept and reachable rather than
       * open in front of him. A card that hires five agents was putting five full cards on the
       * board for work he was not reading, which crowds out the cards he is. Everything is still
       * there behind the header, its conversation, its history and its input; it just does not take
       * the room until he opens it. Nothing about what is recorded changes.
       */
      collapsed: true,
      color: colorForRole(agentType),
      role: agentType,
      size: 'normal',
      createdAt: at,
      exitedAt: null,
      exitCode: null,
    }
    this.store.upsertSession(child)
    this.ensureCardMemory(child)
    this.broadcast({ t: 'session.added', session: child })

    if (pending?.label) {
      this.openWork(child.id, null, 'agent', parent.id, pending.label, at)
    }

    const wire: Wire = {
      id: randomUUID(),
      projectId: parent.projectId,
      sourceId: parent.id,
      targetId: child.id,
      label: agentType ?? '',
      // Created from a dispatch that actually fired, which is what separates this from a line
      // the owner drew. The two are drawn differently for exactly that reason.
      kind: 'derived',
      // Both ends, because a dispatch is a round trip: the parent sends work and the child
      // reports back, and the answer coming home is the reason the card is kept at all.
      bidirectional: true,
      createdAt: at,
    }
    this.store.upsertWire(wire)
    this.broadcast({ t: 'wire.added', wire })
    this.broadcast({ t: 'wire.pulse', wireId: wire.id, kind: 'derived' })

    /*
     * Nothing is dropped here, and `BoardLimits.subagents` is not consulted.
     *
     * A version of this method deleted the oldest spent records once the board went past that
     * figure. Canon 15 forbids it in as many words: a limit refuses something new, it never removes
     * what already exists. The figure is a ceiling the CLI holds at launch, so by the time this
     * runs the dispatch has happened and the only thing left to do with it is record it.
     */
  }

  /*
   * Siblings are no longer wired to each other, and the method that did it is gone.
   *
   * It wired each new child to the last four still working for the same parent, both ends. Four
   * cards from one dispatch produced six lines between agents that never communicated, and eight
   * produced twenty-eight. A wire claims a recorded connection and a usable channel, and neither
   * was true of any of them. Membership of the Subagents / Tools list is what shows two cards are
   * siblings now.
   *
   * What it cost, written down rather than skipped: a wire is also what permits mail, so two
   * workers hired by the same manager can no longer message each other unless the owner draws the
   * wire himself. That is the trade canon asks for. A line drawn to describe a family promised a
   * conversation nobody had asked for.
   */

  private onSubagentStop(e: Record<string, unknown>, at: number) {
    const toolUseId = pick(e, 'tool_use_id', 'toolUseId')
    const agentId = pick(e, 'agent_id', 'agentId')
    const child =
      (agentId ? this.store.findSessionByAgentId(agentId) : undefined) ??
      (toolUseId ? this.store.findSessionByAgentId(`tool:${toolUseId}`) : undefined)
    if (!child) return

    this.closeWork(child.id, null, at)
    this.update(child.id, {
      // Done, not removed. A finished subagent keeps its card, its wire and its transcript, which
      // is the single behaviour this whole app was built to fix.
      status: 'done',
      statusSince: at,
      exitedAt: at,
      transcriptPath: pick(e, 'agent_transcript_path', 'agentTranscriptPath') ?? child.transcriptPath,
    })
    this.readUsage(child.id)

    const wire = child.parentId ? this.store.findWire(child.parentId, child.id) : undefined
    if (wire) this.broadcast({ t: 'wire.pulse', wireId: wire.id, kind: 'derived' })
  }

  // -------------------------------------------------------------------------
  // Teammates
  // -------------------------------------------------------------------------

  private onTaskCreated(parent: TerminalSession, e: Record<string, unknown>, at: number) {
    const name = pick(e, 'teammate_name', 'teammateName')
    const taskId = pick(e, 'task_id', 'taskId')
    if (!name || !taskId) return

    const key = `teammate:${name}`
    let card = this.store.findSessionByAgentId(key)
    if (!card) {
      const spot = this.placeChild(parent, CHILD_W, CHILD_H)
      card = {
        ...parent,
        id: randomUUID(),
        kind: 'teammate',
        title: name.slice(0, 80),
        pid: null,
        status: 'working',
        waitingFor: null,
        statusSince: at,
        // A teammate is a peer session with its own id, not a child process. The key is its name
        // because that is what every later event about it carries.
        agentId: key,
        parentId: parent.id,
        transcriptPath: null,
        managed: false,
        x: spot.x,
        y: spot.y,
        width: CHILD_W,
        height: CHILD_H,
        manualPos: true,
        collapsed: false,
        color: colorForRole('teammate'),
        role: 'teammate',
        size: 'normal',
        createdAt: at,
        exitedAt: null,
        exitCode: null,
      }
      this.store.upsertSession(card)
      this.ensureCardMemory(card)
      this.broadcast({ t: 'session.added', session: card })

      const wire: Wire = {
        id: randomUUID(),
        projectId: parent.projectId,
        sourceId: parent.id,
        targetId: card.id,
        label: 'teammate',
        kind: 'derived',
        bidirectional: true,
        createdAt: at,
      }
      this.store.upsertWire(wire)
      this.broadcast({ t: 'wire.added', wire })
    }

    this.openWork(card.id, taskId, 'agent', parent.id, pick(e, 'task_subject', 'taskSubject') ?? 'task', at)
    this.setStatus(card.id, 'working', null)

    const wire = this.store.findWire(parent.id, card.id)
    if (wire) this.broadcast({ t: 'wire.pulse', wireId: wire.id, kind: 'derived' })
  }

  private onTeammateUpdate(e: Record<string, unknown>, type: string, at: number) {
    const name = pick(e, 'teammate_name', 'teammateName')
    if (!name) return
    const card = this.store.findSessionByAgentId(`teammate:${name}`)
    if (!card) return
    const taskId = pick(e, 'task_id', 'taskId')
    if (type === 'TaskCompleted') this.closeWork(card.id, taskId, at)
    this.setStatus(card.id, type === 'TeammateIdle' ? 'idle' : 'working', null)
  }

  // -------------------------------------------------------------------------
  // Context gauge
  // -------------------------------------------------------------------------

  /**
   * Re-read the context gauge for one session.
   *
   * Called on a timer as well as at the end of a turn, because an interactive session's
   * transcript is not on disk when its Stop hook fires. Two live runs confirmed it: the path the
   * CLI reported did not exist at the end of the turn and appeared some minutes later. Reading
   * once and giving up left the gauge permanently blank on exactly the sessions it is for.
   */
  refreshUsage(sessionId: string) {
    this.readUsage(sessionId)
  }

  /**
   * Where this session's transcript actually is.
   *
   * The path a hook reported is used when it exists on disk, and it usually does. It can go stale
   * though: an interactive session was observed announcing one session id at SessionStart and
   * writing its transcript under a different one, so a path captured early can point at a file
   * that never appears. The fallback derives the path the way the CLI names it, from the working
   * directory with every non-alphanumeric character replaced by a dash. Both are checked against
   * the filesystem, and a miss returns null rather than a guess, which leaves the gauge blank.
   */
  private transcriptFor(session: TerminalSession): string | null {
    if (session.transcriptPath && existsSync(session.transcriptPath)) return session.transcriptPath
    if (!session.claudeSessionId) return null
    const slug = session.cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const guess = join(homedir(), '.claude', 'projects', slug, `${session.claudeSessionId}.jsonl`)
    if (existsSync(guess)) {
      this.update(session.id, { transcriptPath: guess })
      return guess
    }
    return null
  }

  /**
   * How full this session's context is, read from the last usage record in its own transcript.
   *
   * The number is the CLI's, not an estimate: input plus both cache figures is what actually
   * occupies the window on the next turn. If the transcript is unreadable or the model is one
   * this does not have a window size for, both fields stay null and the gauge stays blank, which
   * is the honest answer and the one the card is designed to show.
   */
  /**
   * Send a card's conversation to every window, the moment a turn has actually ended.
   *
   * The conversation used to be request-and-answer only: a card asked for it when it first drew and
   * again whenever its status changed, and nothing ever offered. That was tolerable while only
   * subagent cards showed it, because a subagent's whole life is one status change. It is not
   * tolerable now that a session card can sit on its conversation while the owner watches, because
   * the card would show what was there when he opened it and then quietly stop.
   *
   * Skipped when the file has not grown, which is the same trick `archive.ts` uses over 1300 files:
   * a stat is cheap and parsing a long transcript is not. Two reads per turn is deliberate, for the
   * reason `readUsage` above is called twice: the hook fires when the turn ends and the CLI flushes
   * its transcript a beat later.
   */
  private chatSeen = new Map<string, string>()

  private pushChat(sessionId: string) {
    const session = this.store.getSession(sessionId)
    if (!session) return
    const path = this.transcriptFor(session)
    if (!path) return
    try {
      const st = statSync(path)
      const stamp = `${st.size}:${st.mtimeMs}`
      if (this.chatSeen.get(sessionId) === stamp) return
      this.chatSeen.set(sessionId, stamp)
      this.broadcast({ t: 'agent.chat', sessionId, turns: readChat(path) })
    } catch {
      // A transcript that vanished or cannot be read is not worth an error here. The card keeps
      // whatever it already had and says so through its own empty states.
    }
  }

  /**
   * The tail of the transcript, growing the window until something is found in it.
   *
   * This read the whole file into a string, which Node refuses past 512MB. The owner had a card
   * whose transcript was 681MB, so every refresh threw `ERR_STRING_TOO_LONG` into the catch below,
   * written for a file that is missing rather than one that is enormous. That card's gauge stayed
   * blank and, worse, its model never moved off the one announced at `SessionStart`: he read it in
   * the rail as an orchestrator "on fable low and its showing previous setting of opus". The
   * failure lands on exactly the cards that have been working longest, and it is silent.
   *
   * `readChat` beside this had already been changed to read the tail for the same reason. The fix
   * was not carried across, which is the argument for the reader being one exported function rather
   * than each caller deciding how much of the file it wants.
   *
   * The window grows because how many turns fit in four megabytes depends on the session, and a
   * card whose records are hundreds of kilobytes each can have no usage line in the first window.
   * It stops at the same ceiling the chat reader stops at.
   */
  private readUsage(sessionId: string) {
    const session = this.store.getSession(sessionId)
    if (!session) return
    const path = this.transcriptFor(session)
    if (!path) return
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      return
    }
    for (let window = TAIL_BYTES; ; window *= 4) {
      if (this.scanUsage(session, path, window)) return
      if (window >= size || window >= MAX_TAIL_BYTES) return
    }
  }

  /** One pass over one window. True when it found the record it was looking for. */
  private scanUsage(session: TerminalSession, path: string, window: number): boolean {
    const sessionId = session.id
    try {
      const lines = tailLines(path, window)
      for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
        const line = lines[i]
        if (!line) continue
        /*
         * A compaction throws the conversation away and the CLI says so on its own line, right
         * there in the transcript this scan is already walking. Stopping on it, rather than
         * reading straight past to a usage line from before it, is the whole fix: without this a
         * card that just compacted from 838,017 tokens down to 13,607 kept showing 84% full,
         * of a conversation that no longer existed, for as long as it took the next turn to write
         * a fresher usage line over it. `postTokens` is the CLI's own count of what survived.
         */
        if (line.includes('compact_boundary')) {
          let boundary: any
          try {
            boundary = JSON.parse(line)
          } catch {
            continue
          }
          if (boundary?.type === 'system' && boundary?.subtype === 'compact_boundary') {
            const post = boundary?.compactMetadata?.postTokens
            if (typeof post === 'number') {
              const model: string | null = session.model ?? null
              const limit = contextLimitFor(model)
              this.update(sessionId, {
                tokensUsed: post,
                contextUsed: limit ? Math.min(1, post / limit) : null,
                contextSource: 'transcript',
              })
            }
            return true
          }
          continue
        }
        if (!line.includes('usage')) continue
        let parsed: any
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        const usage = parsed?.message?.usage
        if (!usage) continue
        const model: string | null = parsed?.message?.model ?? session.model ?? null
        const tokens =
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.output_tokens ?? 0)
        const limit = contextLimitFor(model)
        this.update(sessionId, {
          tokensUsed: tokens,
          contextUsed: limit ? Math.min(1, tokens / limit) : null,
          // The transcript is the CLI's own accounting, so it outranks anything read off the
          // screen and the card says so.
          contextSource: 'transcript',
          model: model ?? session.model,
        })
        return true
      }
    } catch {
      /*
       * An unreadable transcript leaves the gauge blank rather than showing a stale number. It says
       * false rather than true, so a window that could not be read is retried at the next size
       * instead of being taken for a window with nothing in it.
       */
      return false
    }
    return false
  }
}
