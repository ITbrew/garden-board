import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import {
  ROLE_CHAIN,
  ROLE_POWERS,
  agentHasEnded,
  cardIsOff,
  contextWindowFor,
  modelAndEffort,
  type TerminalSession,
  type Project,
} from '@garden/shared'
import { actions, onSessionBytes, useApp } from '../state'
import { heldTask, onTasks } from '../tasks'
import { SubagentList, type ListEntry } from './SubagentList'
import { TerminalMini } from './TerminalMini'
import { AgentChat } from './AgentChat'

/**
 * The default colour of a card, by which CLI it runs. A card can override it, which is how roles
 * and teams get colour coded, and agent-spawned cards will set it from their agent type.
 */
export const ADAPTER_COLOR: Record<string, string> = {
  shell: '#7a839c',
  claude: '#7c5cff',
  codex: '#2dd4bf',
}

const ADAPTER_LABEL: Record<string, string> = {
  shell: 'Shell',
  claude: 'Claude Code',
  codex: 'Codex',
}

// Control bytes, written out rather than embedded, because an escape inside JSX is easy to
// mangle and a silently-empty control sequence would look like a dead key.
const CR = String.fromCharCode(13)
const CTRL_C = String.fromCharCode(3)
const ESC = String.fromCharCode(27)
const TAB = String.fromCharCode(9)
const SHIFT_TAB = ESC + '[Z'

/**
 * Arrow keys, so a card can answer a prompt that offers a list rather than a line.
 */
const ARROW: Record<string, string> = {
  ArrowUp: ESC + '[A',
  ArrowDown: ESC + '[B',
  ArrowRight: ESC + '[C',
  ArrowLeft: ESC + '[D',
}

/**
 * Send a typed line to a session the way a person at a keyboard sends one: the text, and then
 * the Enter, as two separate arrivals.
 *
 * A card's input is a line editor, so the obvious thing is to write `text + CR` in one go. That
 * does not work against a TUI. Claude's prompt watches how its input arrives and treats a burst
 * that ends in a newline as pasted multi-line text, so the message landed in the composer with a
 * blank line under it and nothing was ever sent. Splitting the write is what makes the Enter read
 * as a keypress instead of as the last character of a paste.
 */
/**
 * How long after the text the return is sent.
 *
 * Measured rather than chosen. `scripts/lib/gap-reader.mjs` is a program that reports its own stdin
 * arrivals, and driven through a card it shows the two writes arriving separately with the gap the
 * client asked for: 40ms out arrives as 47, 90 as 90, 150 as 156. So nothing merges them in
 * transport, and the number here is the number the process sees.
 *
 * 40ms was too tight. Nobody types a line and presses return inside a twentieth of a second, and a
 * composer that decides between typing and pasting by watching arrival timing is entitled to call
 * that a paste, which leaves the line sitting in it unsent. The owner's report: "sometimes i have to
 * press enter twice in card after i type for it to actually enter... i press enter waiting for
 * response but its sitting in input field". The two server-side paths that type into a live CLI and
 * work, the mail wake-up and `agent-reach`, both use 60. This is comfortably past that, and still
 * far below anything a person would notice.
 */
const LINE_TO_RETURN_MS = 90

function sendLine(sessionId: string, text: string) {
  actions.input(sessionId, text)
  setTimeout(() => actions.input(sessionId, CR), LINE_TO_RETURN_MS)
}

const STATUS_LABEL: Record<string, string> = {
  starting: 'starting',
  idle: 'idle',
  working: 'working',
  'needs-input': 'needs you',
  done: 'done',
  stopped: 'off',
  failed: 'failed',
}

/** "waiting 2m", "waiting 1h 4m". Coarse on purpose: the point is a glance, not a stopwatch. */
function formatWait(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** A short clock time, for "finished at" on an agent card that has no PTY to show anything else. */
function formatWhen(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * Forces a re-render on an interval, only while `active`. The needs-input badge reads its wait
 * time straight from statusSince on every render, so this is the only state it needs: something
 * to make "now" move.
 */
function useTicker(active: boolean, intervalMs: number) {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => bump((n) => n + 1), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
}

/**
 * What the CLI accepts, rather than what sounds right.
 *
 * Aliases rather than full ids, because an alias survives a model being replaced and a pinned id
 * does not. The bracketed pair are the million token variants, which is what this owner's long
 * sessions actually run on.
 */
const MODELS = ['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'opusplan', 'best', 'default']

/** The CLI's own effort levels, in the order it lists them. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']

export type SessionNodeData = {
  session: TerminalSession
  project: Project | undefined
  /**
   * The account this session is actually running as, read from the oauthAccount in the config
   * directory it was launched with. Null means the directory is not signed in, which is shown as
   * such rather than guessed at.
   */
  account: string | null
  focused: boolean
  width: number
  height: number
  /** True when this card's context web is already unfolded below it. */
  contextOpen: boolean
  /** And the same for the history block above it, so its dot can fold as well as unfold. */
  historyOpen: boolean
  /**
   * Refusals this card has collected. Zero for almost every card.
   *
   * The pill that holds them folds away with the history now, so this is what stops the fold hiding
   * the fact that they exist. Canon 15: a refusal is never silent, and a fold is not an exception.
   */
  refusalCount: number
}

export const SessionNode = memo(function SessionNode({ data, selected }: NodeProps) {
  const { session, project, account, focused, width, height, contextOpen, historyOpen, refusalCount } =
    data as SessionNodeData
  const [powersOpen, setPowersOpen] = useState(false)
  /*
   * Who this card answers to, in words rather than an id.
   *
   * A card the owner started himself answers to him, which is what a null parent means and what
   * the strip should say. "unassigned" was the old wording and told him nothing: every card had a
   * real answer available, it just was not being asked for.
   */
  /*
   * Whether there is a process behind this card at all, needed before the summary line below.
   *
   * A subagent or teammate has no PTY: it was never turned off, it finished. Dimming it the same
   * way as a stopped process reads as "gone", which is exactly what this app exists to stop doing
   * to subagents. So only a real session card ever gets the off treatment.
   */
  const isAgent = session.kind !== 'session'
  /*
   * No pid means off, whatever the status says, and that is the whole of this line's history.
   *
   * This used to test the status alone. The status and the process disagree constantly: the server
   * revives only `working`, `starting` and `needs-input` cards on a restart and deliberately leaves
   * every idle one down, so a board that has restarted is full of cards reading `idle` or
   * `needs-input` with nothing behind them. None of those three statuses is in the list below, so
   * `off` came out false, the submit handler took the live branch, and `session.input` dropped the
   * line into a dead PTY without a word. The owner's report was that he could not type to a card at
   * all; what was actually happening is that the two most common off-states did not count as off.
   *
   * `garden-board.mjs` already rules on this and its wording is the one adopted here: a card with no
   * pid is OFF, whatever its status says. The comment above this line has always said the test is
   * "whether there is a process behind this card at all", so the code now does what the comment
   * already claimed.
   */
  const off = cardIsOff(session)

  /*
   * The task this card is accountable for right now, if any.
   *
   * Only `working`, `remediating` and `in_review`, which is the difference between a card that is
   * holding work and one that merely has a task with its name on it: `assigned` has not been sent
   * yet and `done` has already come back. A card wearing a task id in either of those would be the
   * face claiming a busyness the row does not support, and the status pill beside it already tells
   * enough small lies of that kind for one header.
   *
   * Safe as a snapshot despite returning an object: `heldTask` hands back a row out of the stored
   * array rather than building one, so between two `task.state` messages it is the same reference.
   */
  const task = useSyncExternalStore(
    onTasks,
    () => heldTask(session.id),
    () => null,
  )

  /*
   * An agent's own ending, which is not the same fact as a card being switched off.
   *
   * `off` stays false for an agent card on purpose, for the reason above. But the settings strip
   * and the input line below are now drawn on agent cards as well, and both have to know whether
   * anything is still running: a finished agent describing itself as "running opus" would be
   * asserting a process that has already exited. This is the observed version of that, the CLI
   * having said it stopped or having stamped an exit time, never silence.
   */
  const agentEnded = agentHasEnded(session)

  /*
   * The card that hired this one, looked up rather than passed in, since the node's data carries
   * one session and the input line below has to name a second. `parentId` is only ever set from a
   * dispatch Garden actually saw, so this is the real hiring line and not a guess about it.
   */
  const parentId = isAgent ? session.parentId : null
  const parent = useApp((s) => (parentId ? (s.sessions.find((x) => x.id === parentId) ?? null) : null))

  /*
   * What this card can reach, for the list pinned beside it.
   *
   * `parentId` is the recorded maker, and `kind` decides whether the child belongs here at all.
   *
   * This used to take every card naming this one as its parent, hired or dispatched, on the
   * reasoning that from the owner's side both are something this card can call. A blind reviewer
   * shown the board found what that costs: a list headed "Subagents / Tools" hanging beside a
   * manager whose only entries were the ordinary worker cards sitting a few inches away, already
   * drawn, already wired, already visible. It read the panel as a connector between two cards
   * rather than as anything belonging to either.
   *
   * So the rule is now the same one that took dispatched agents off the canvas: this list holds
   * what the board does not draw. A hired card is a card, with a terminal, a wire and a place; it
   * is reachable by looking at it. A dispatched agent has none of those and would otherwise have
   * no representation at all, which is the entire job of this list.
   *
   * The whole array is selected rather than a filtered one. `useApp` is a `useSyncExternalStore`
   * that compares snapshots by identity, so a selector returning a fresh array on every render
   * re-renders forever; the filter belongs in a memo on this side of it. That exact four-character
   * mistake froze the board once already and the note about it is in state.ts.
   *
   * Oldest first, which is dispatch order. The list does not sort: the order is the meaning.
   *
   * Tools are not in here yet. Garden records no such thing, and a wire to another card is a spawn
   * point rather than a tool, so inventing entries from wires would be claiming a capability
   * nobody wrote down.
   */
  const allSessions = useApp((s) => s.sessions)
  const reachable = useMemo<ListEntry[]>(
    () =>
      allSessions
        .filter((s) => s.parentId === session.id && s.kind === 'subagent' && s.closedAt === null)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((s) => ({
          id: s.id,
          title: s.title,
          kind: 'agent' as const,
          status: s.status,
          waitingFor: s.waitingFor,
          roleClass: s.roleClass,
          transcriptPath: s.transcriptPath,
        })),
    [allSessions, session.id],
  )

  /*
   * The folded line, short enough to survive a narrow card.
   *
   * The model and effort wording lives in `modelAndEffort` rather than here, because the rail's
   * lists name the same two things and the owner reads that rail to avoid opening every card. What
   * a row may and may not claim is written where the function is.
   *
   * `hiringBit` stays local and never says "hires any", since the CLI's own default of twenty is
   * still a limit; no cap set is what that actually means.
   */
  const { model: modelBit, effort: effortBit } = modelAndEffort(session)

  /*
   * The role, but only when the board and the process disagree.
   *
   * Changing a live card's role rewrites its POWERS.md and its deny list, and the picker moves at
   * once, but the session was told what it is once at startup and never reads that again. Its
   * brief says its identity outranks anything else it reads, so it defends the old role instead of
   * adopting the new one, and the card was left claiming a manager while a worker sat inside it.
   * `roleClassRunning` is what the process was actually launched as, so the disagreement is
   * observed rather than guessed. It is null while the card is off, and a silent bit the rest of
   * the time, because a warning that never goes away stops being read.
   */
  const roleBit =
    session.roleClassRunning && session.roleClassRunning !== session.roleClass
      ? session.roleClass
        ? `${session.roleClass} pending`
        : `running as ${session.roleClassRunning}`
      : null

  /*
   * The card's own answer first, because it is the one that beats the board and the summary is the
   * only place it shows while the settings are folded away. A card that follows the board says
   * nothing about subagents here: the board's answer is on the board, and repeating it on every
   * card would be a second place to read one fact and a second place for it to go stale.
   */
  const hiringBit =
    session.subagentsAllowed === false
      ? 'no subagents'
      : !session.canSpawnAgents || session.teamSize === 0
        ? 'hires nobody'
        : session.subagentsAllowed === true && session.teamSize === null
          ? 'subagents on'
          : session.teamSize
            ? `hires ${session.teamSize} at a time`
            : 'no hiring cap'

  /*
   * No "answers to" here.
   *
   * The wires already say who talks to whom, and a card repeating that in words was a second
   * place to read the same fact and a second place for it to be wrong. The owner's point: the
   * board is the record of the reporting line, and the session he talks to talks to him.
   */
  /*
   * A shell has none of this.
   *
   * Every one of these describes an AI session: which model it runs, how hard it thinks, how many
   * agents it may hire. A plain shell card was being handed the same strip and read "no hiring cap
   * · default model · default effort", which a blind reviewer flagged as a card describing itself
   * with properties it cannot have. Saying nothing is the honest version, and it is also shorter.
   */
  /*
   * An agent card gets the same strip, minus the hiring claim.
   *
   * The owner asked for agent cards to carry the same template as the cards he starts himself, so
   * the strip is no longer withheld from them. The hiring bit still is: on a session card that
   * number is real because Garden writes the cap into the settings file it launches the CLI with,
   * and Garden never launches a subagent, so the same words on an agent card would be describing an
   * enforcement that nothing performs. `roleBit` is null on an agent card by construction, since
   * `roleClassRunning` is only ever stamped by a launch.
   */
  const powersSummary =
    session.adapterId === 'shell'
      ? ''
      : isAgent
        ? [modelBit, effortBit].filter(Boolean).join(' · ')
        : [hiringBit, modelBit, effortBit, roleBit].filter(Boolean).join(' · ')
  const [line, setLine] = useState('')
  const collapsed = session.collapsed
  useTicker(session.status === 'needs-input', 15000)

  /*
   * A line typed at a card that was switched off.
   *
   * The card used to disable its input whenever the session was off, while the comment on the
   * footer said the buttons had been removed because "typing into the card's own input line
   * already starts a session and drives it". That was false in both layers: the input refused the
   * keystroke, and `session.input` on the server drops anything sent to a dead PTY without a
   * word. So the two cards the owner most needs to reach, an orchestrator and a boss laid out
   * before they were ever started, could not be spoken to from the board at all.
   *
   * The line is held rather than sent, because sending it the instant the PTY exists would post
   * it into a CLI that has not drawn its prompt yet. What is waited for is the process writing
   * something and then stopping: a TUI that has painted and gone quiet is one that will read a
   * keystroke. That is an observation of the real byte stream rather than a fixed delay, but it
   * is still a heuristic, and it is the reason the box says the line is waiting instead of
   * pretending it has been delivered.
   */
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => {
    if (pending == null || off) return
    let quiet: ReturnType<typeof setTimeout> | undefined
    const send = () => {
      sendLine(session.id, pending)
      setPending(null)
    }
    /*
     * Arm the timer now, not only when a byte arrives.
     *
     * Waiting for the stream to go quiet is right, but "quiet" was only ever measured from the
     * first byte this listener happened to see. A session that printed its opening and settled
     * before the listener attached produced no byte at all, so nothing started the clock and the
     * held line was never sent: the very first message to a switched-off card silently vanished
     * while every follow-up worked, because by then the card was running and took input directly.
     *
     * So there are two clocks. The long one covers a stream that is already silent. Every byte
     * replaces it with the short one, which is the original behaviour: a CLI that is still drawing
     * keeps pushing the send back until it stops.
     */
    const arm = (ms: number) => {
      if (quiet) clearTimeout(quiet)
      quiet = setTimeout(send, ms)
    }
    arm(4000)
    const stop = onSessionBytes(session.id, () => arm(700))
    return () => {
      if (quiet) clearTimeout(quiet)
      stop()
    }
  }, [pending, off, session.id])

  /*
   * The agent's own conversation, where a session card has its terminal.
   *
   * Read on demand rather than pushed. A transcript is a file that grows, and no event means
   * "another line was written to it", so there is nothing to subscribe to: the card asks when it
   * first draws and again whenever its status changes, which is the moment something new is likely
   * to be in there. Undefined and empty are kept apart on purpose. Undefined means the answer has
   * not come back yet; an empty array means the server read the file and found no turns, which is
   * the ordinary state of an agent that has only just started and must not be drawn as a run that
   * did nothing.
   */
  /**
   * Which of the two things this card's body is showing.
   *
   * The stored choice wins, and the default is the card's kind. A subagent or teammate card has no
   * process behind it and never had a terminal to show, so it opens on the conversation; a session
   * card opens on its terminal, which is what it has always done. What is new is that a session card
   * can now be turned round: the conversation is read from the CLI's own transcript, so it says what
   * was asked and answered in words, it survives the process ending and the app restarting, and it
   * is not a picture of drawing instructions that a resize can scramble.
   */
  const showChat = session.bodyView ? session.bodyView === 'chat' : isAgent

  /**
   * Whether this card can have a conversation at all, which decides whether the toggle is drawn.
   *
   * The turns are read out of a Claude Code transcript, and a shell has no such thing and never will.
   * Offering the switch there would be a control with one working position: press it and the card
   * says it has no transcript, forever, in wording about a CLI naming a file that a PowerShell prompt
   * is never going to do. A blind reviewer shown a Shell card in that state read the copy as written
   * for something else and reused here, which is exactly what it would have been.
   *
   * The same reasoning is already applied to what a role may reach for: something a card would only
   * discover it cannot do at the moment of refusal is worse than not offering it.
   */
  const canConverse = !isAgent && session.adapterId === 'claude'

  /*
   * Where a line typed at an agent card actually goes.
   *
   * There is no process behind a subagent or a teammate card, so the one dishonest option is an
   * input that appears to reach the agent. Three honest ones were on the table. Sending into the
   * card's own mailbox was rejected because nothing is running to read that file, so the message
   * would sit there for ever. Refusing to draw the line at all is what the card used to do, and the
   * owner has now ruled against it. What is left is the one thing on the board that can actually act
   * on what he types: the card that hired this one, which is a real session with a real PTY. So the
   * line goes there, exactly as typed, and the box says whose terminal it is landing in rather than
   * leaving him to infer it. Nothing is added to his text on the way through: a card that quietly
   * prefixed "about the reviewer:" would be putting words he did not write into a live CLI.
   */
  const parentLive = parent !== null && parent.kind === 'session' && parent.pid !== null
  const [sentAt, setSentAt] = useState<number | null>(null)
  useEffect(() => {
    if (sentAt == null) return
    const id = setTimeout(() => setSentAt(null), 4000)
    return () => clearTimeout(id)
  }, [sentAt])

  return (
    // A fragment, not a single div: the context gauge below has to sit outside the card's own
    // box, and .node has overflow:hidden (it clips the terminal preview to the card's rounded
    // corners). A child positioned outside that box gets clipped away by the same rule, which is
    // why the gauge used to render nothing at all. A sibling at this level is not inside .node's
    // clipping box, so it can sit just past the card's edge and still be seen.
    <>

      {/*
        Outside the card, not inside it.
        Drag any edge or corner to size a card exactly. This lived inside .node, which has
        overflow:hidden to clip the terminal preview to the card's rounded corners, and that clip
        took the corner handles with it: each one is centred on a corner, so half of every handle
        and all of its enlarged target were cut away, leaving a sliver inside a rounded corner to
        aim at. A sibling at this level is outside that clipping box.
      */}
      <NodeResizer
        isVisible={!collapsed}
        minWidth={220}
        minHeight={160}
        lineClassName="card-resize-line"
        handleClassName="card-resize-handle"
        onResizeEnd={(_e, params) => actions.setSessionBox(session.id, params.width, params.height)}
      />
    <div
      /*
       * `is-tinted` says the colour was CHOSEN, which is not the same as the card having one.
       *
       * Every card has a `--role-color` below, because an adapter with no colour set still falls
       * back to one, and that fallback is what paints the header edge on the majority of cards.
       * Painting the whole card from it would therefore retheme every card on the board the moment
       * this landed, which is the opposite of what was asked. So the class is the signal, the
       * property is the value, and a card the owner has never coloured looks exactly as it did.
       */
      className={`node ${selected ? 'is-selected' : ''} ${focused ? 'is-focused' : ''} ${off ? 'is-off' : ''} ${session.status === 'working' ? 'is-busy' : ''} ${session.color ? 'is-tinted' : ''}`}
      style={
        {
          width,
          height: collapsed ? undefined : height,
          // Drives every text size inside the card, including the terminal miniature.
          '--card-font': `${session.fontSize ?? 11}px`,
          /*
           * This card's own colour, used by the header edge, the role chip and the ring that
           * travels around the border while it is working. A coder, an orchestrator and a
           * reviewer therefore light up in different colours, so what a busy card is FOR is
           * readable from across the board without reading a word on it.
           *
           * When the owner has chosen a colour rather than inherited one, this same property is
           * also the whole card's theme: all four border edges, a tint under the header and a
           * fainter one under the body, all mixed from this one value in `styles.css`. One
           * property and one class, so a colour never has to be plumbed to a second place.
           */
          '--role-color': session.color ?? ADAPTER_COLOR[session.adapterId] ?? '#7c5cff',
        } as CSSProperties
      }
      /*
       * Ctrl and the wheel resize this card's text.
       *
       * Capture phase with preventDefault, because both the browser's page zoom and the canvas's
       * own ctrl-wheel zoom would otherwise take the gesture first. Without ctrl the event is
       * left alone so the canvas still zooms normally.
       */
      onWheelCapture={(e) => {
        if (!e.ctrlKey) return
        e.preventDefault()
        e.stopPropagation()
        actions.nudgeSessionFont(session.id, e.deltaY < 0 ? 1 : -1)
      }}
    >

      {/* The side dots are plain connectors with no meaning of their own. Direction is shown by
          the arrowhead on the wire, not by which side it left from, so there is no hidden logic
          to remember. Every port still names itself on hover. */}
      {/* Sides carry agent-to-agent connections. */}
      <header
        onDoubleClick={(e) => { e.stopPropagation(); actions.toggleSessionSize(session.id) }}
        className="node-head"
        style={{ borderTopColor: 'var(--role-color)' }}
      >
        <button
          className="twisty nodrag"
          title={collapsed ? 'Show this card' : 'Hide the contents, keep the card'}
          onClick={() => actions.setSessionCollapsed(session.id, !collapsed)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className={`dot dot--${session.status}`} />
        {/* The title must always stay readable: min-width:0 is what lets it actually shrink
            inside the flex row rather than being shoved out by the status pill next to it. */}
        <span className="node-title" title={session.title}>
          {session.title}
        </span>
        {/*
          What this card is accountable for, beside what it is doing.

          Two pills rather than one, and next to each other on purpose: the status says whether
          anything is running and the task says what it is answerable for, and those come apart all
          the time. A card can be idle and still hold a task in `remediating`, which is precisely
          the state canon exists to make visible, and one pill could not say both.

          Drawn before the status rather than after so the status stays where the eye already
          expects it, hard against the controls. The id is shortened only by the flex rule in the
          stylesheet, never here, because a truncated task id that could be mistaken for a whole one
          is worse than one that visibly runs out of room.
        */}
        {task && (
          <span
            className={`node-task node-task--${task.state}`}
            title={`This card owns ${task.id}, currently ${task.state}. Anything the ownership rules stopped, or would have stopped, is in the refusals pill above this card.`}
          >
            {task.id} · {task.state}
          </span>
        )}
        {/* The header only ever carries the short word. The reason and wait time, which can run
            long, go on their own banner below the header so they can never crowd the title out. */}
        <span
          className={`node-status node-status--${session.status} ${
            session.status === 'needs-input' ? 'node-status--alert' : ''
          }`}
        >
          {STATUS_LABEL[session.status] ?? session.status}
        </span>
        {/* Renaming lives here rather than in a row of footer buttons: it is a small, occasional
            edit to the title, so it belongs next to the title. */}
        <button
          className="twisty twisty--round nodrag"
          title="Rename this card"
          onClick={() => {
            const t = prompt('Rename card', session.title)
            if (t) actions.rename(session.id, t)
          }}
        >
          ✎
        </button>
        {/*
          Terminal or conversation.
          Only on a card that has a process; a subagent card has no terminal to switch to, so
          offering the choice there would be a control with one working position. Labelled with what
          pressing it gives you rather than with what is showing, since a toggle that names its own
          current state reads as a status and gets pressed by mistake.
        */}
        {canConverse && (
          <button
            className={`twisty twisty--word nodrag ${showChat ? 'twisty--on' : ''}`}
            title={
              showChat
                ? 'Showing the conversation. Press to go back to the terminal.'
                : 'Show the conversation: what was asked and answered, read from this card’s transcript rather than from terminal output, so it survives a restart'
            }
            onClick={() => actions.setBodyView(session.id, showChat ? 'terminal' : 'chat')}
          >
            {/*
              A word, not an icon, and that is the third attempt at this control.
              A speech bubble was tried and three blind reviewers between them could not settle what
              it was: at the size a card header runs, an emoji is a coloured blob with no internal
              detail, and it carries its own colours so it cannot be recontrasted against whatever is
              behind it. The header already labels its state in words next to this ("off"), so a word
              is the house style here as well as the legible option.
            */}
            chat
          </button>
        )}
        {/* An explicit control, because relying on double-click alone left no discoverable way
            to grow a card, and no way at all if the gesture is swallowed. */}
        <button
          className="twisty nodrag"
          title="Bigger: working size, then the whole workspace"
          onClick={() => actions.cycleSessionSize(session.id, 1)}
        >
          ⤢
        </button>
        {/* Minimize, never close. Removing a card is right-click, Delete, and a confirmation. */}
        <button
          className="twisty nodrag"
          title={
            (session.size ?? 'normal') === 'normal'
              ? 'Minimize: hide the contents. The session keeps running and the card stays.'
              : 'Minimize: step back down one size'
          }
          onClick={() =>
            (session.size ?? 'normal') === 'normal'
              ? actions.setSessionCollapsed(session.id, true)
              : actions.cycleSessionSize(session.id, -1)
          }
        >
          –
        </button>
      </header>

      {/*
        The single most important visual in the app: whether the owner has to look at this card,
        why, and for how long. It gets its own full-width row rather than living in the header, so
        a long reason string can never squeeze the title down to nothing. Reason and wait time
        come straight from the CLI's own session file (waitingFor, statusSince), never guessed, so
        this banner never claims a reason it does not have. Shown even while collapsed: a blocked
        card should not be able to hide the fact that it is blocked by folding itself up.
      */}
      {session.status === 'needs-input' && (
        <div className="node-alert" title={session.waitingFor ? `Waiting on you: ${session.waitingFor}` : 'Waiting on you'}>
          <span className="node-alert__headline">needs you</span>
          {session.waitingFor && <span className="node-alert__reason">{session.waitingFor}</span>}
          {session.statusSince != null && (
            <span className="node-alert__since">waiting {formatWait(Date.now() - session.statusSince)}</span>
          )}
        </div>
      )}

      {!collapsed && (
        <>
          {/*
            What this card is, and what it may do.

            Every row here does exactly one thing and says so. The strip that used to sit here was
            a summary line reading "unassigned, hires, teams", and those words were inside the
            element that opens the panel, so clicking any of them just opened the panel. Three
            controls that looked like switches and were text. The fold control is now the only
            thing in the header strip that responds to a click.

            The rows split by when they take effect, because that is the honest division. A model
            or an effort can be pushed into a session that is already running, since the CLI takes
            /model and /effort and Garden owns the terminal. Permissions and the concurrency cap
            cannot: the CLI reads those once, at launch.
          */}
          {/*
            Nothing to say, no strip. A shell card has no model, effort or hiring cap, so its
            summary is empty, and the row was still reserving its full height with a lone fold caret
            floating in it. A blind reviewer read that empty band as a rendering fault.
          */}
          {powersSummary !== '' && (
            <div className="node-powers nodrag">
              {/*
                The whole strip opens the panel, not just the caret.

                The owner reported there was no way to change a card's model or effort. Both
                controls have existed the whole time, three rows down inside this panel, behind a
                caret 10px wide with nothing beside it saying it opened anything. What he saw was
                the summary line, which prints the model and the effort as plain text, so he read it
                as the feature being described rather than offered. A control nobody can find is
                indistinguishable from one nobody built, and he was right about the only part he
                could see.

                This does not reintroduce the failure the note above records. That one was three
                separate words that looked like three switches and were one element; the strip now
                is one element that does one thing and says so. The trailing word is what says it,
                and it is only shown where something is actually settable: an agent card's values
                are reports of what was watched, so offering to change them would be a lie in a
                place this card is careful to be honest.
              */}
              <button
                className="node-powers__strip node-powers__strip--open"
                aria-expanded={powersOpen}
                title={
                  powersOpen
                    ? 'Hide these settings'
                    : isAgent
                      ? 'What this agent was reported to be running'
                      : 'Change this card: model, effort, hiring and who it answers to'
                }
                onClick={() => setPowersOpen((v) => !v)}
              >
                <span className="node-powers__fold" aria-hidden>
                  {powersOpen ? '▾' : '▸'}
                </span>
                <span className="node-powers__summary" title={powersSummary}>
                  {powersSummary}
                </span>
                {!isAgent && !powersOpen && <span className="node-powers__hint">change</span>}
              </button>

              {powersOpen && (
                <div className="node-powers__body">
                  {/*
                    Nothing on an agent card is settable, so an agent card is shown none of the
                    controls.

                    Every control here writes `session.setRole`, which the CLI reads once when
                    Garden launches the process. Garden never launches a subagent or a teammate, so
                    a picker on one of those cards would change a row in the database and nothing
                    else, for ever. The read-only rows underneath are the part that is true either
                    way, and they stay.
                  */}
                  {!isAgent && (
                    <>
                      <label className="node-powers__row">
                        <span>May hire agents</span>
                        <input
                          type="checkbox"
                          checked={session.canSpawnAgents}
                          onChange={(e) => actions.setSessionRole(session.id, { canSpawnAgents: e.target.checked })}
                        />
                      </label>

                      {/*
                        This card's own answer about subagents, which beats the board's.

                        Three options and not a checkbox, and the third one is the whole feature: the
                        owner asked for a board where one card has subagents and another does not,
                        "make individual card controls override the global cieling if the user wants
                        one card to have sub agents/not the other". A checkbox has two states, so one
                        of them would have to double as "has not answered", every card ever made
                        would read as an explicit yes, and a board set to no would be overridden by
                        every card on it. Canon 15, "A card may answer for itself, and its answer
                        wins".

                        Not the same row as May hire agents above. That one asks whether this card
                        may hire agents at all and is checked where a hire is requested; this one is
                        asked at the hook on every dispatch, so switching it to No reaches a card
                        that is already running rather than waiting for it to be turned on again.
                      */}
                      <label className="node-powers__row">
                        <span title="Whether this card may dispatch subagents, whatever the board's ceiling says. Follow the board is the default and means it has no opinion. Yes and No are this card overruling the board in either direction, and both take effect on the very next dispatch, including on a card that is already running.">
                          Subagents allowed
                        </span>
                        <select
                          value={session.subagentsAllowed === null ? '' : session.subagentsAllowed ? 'yes' : 'no'}
                          onChange={(e) =>
                            actions.setSessionRole(session.id, {
                              subagentsAllowed: e.target.value === '' ? null : e.target.value === 'yes',
                            })
                          }
                        >
                          <option value="">follow the board</option>
                          <option value="yes">yes, whatever the board says</option>
                          <option value="no">no, whatever the board says</option>
                        </select>
                      </label>

                      {/*
                        Named for what it actually controls.

                        The only thing the CLI enforces for a non-zero value is how many run at the
                        same time, not how many get hired over a session. A row labelled "team size"
                        beside a value reading "3 at a time" still gets read as a team of three, so
                        the label carries the qualifier too. Disabled when hiring is off, since the
                        two controls express the same hard stop and must never disagree on screen,
                        and disabled again when this card has said no to subagents, since there is
                        then nothing for a figure to cap.

                        The empty option used to read "no cap set, the CLI allows 20", which
                        described the CLI rather than this board and stopped being true the day the
                        ceiling grew a figure of its own. A card with no figure falls back to the
                        board's, which is what it now says.
                      */}
                      <label className="node-powers__row">
                        <span title="How many subagents this card may run at the same moment, which overrides the board's figure. It reaches the card in its settings file at launch, so it applies the next time this card is turned on rather than mid-turn.">
                          Subagents at once
                        </span>
                        <select
                          disabled={!session.canSpawnAgents || session.subagentsAllowed === false}
                          value={session.teamSize === null ? '' : String(session.teamSize)}
                          onChange={(e) =>
                            actions.setSessionRole(session.id, {
                              teamSize: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                        >
                          <option value="">follow the board</option>
                          <option value="0">0, may not hire at all</option>
                          {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                            <option key={n} value={String(n)}>
                              {n} at a time
                            </option>
                          ))}
                        </select>
                      </label>

                      {/*
                        Back on the card because it is still being enforced.

                        Dropping the control while the server kept writing the deny left a card that
                        could be silently gagged by a setting made in an earlier session, with nothing
                        on screen saying so and no way to undo it. A permission with no control is the
                        worst of both.
                      */}
                      <label className="node-powers__row">
                        <span title="Denies the messaging and task tools an agent team uses. It does not prevent hiring, which the checkbox above controls.">
                          May message teammates
                        </span>
                        <input
                          type="checkbox"
                          checked={session.canUseTeams}
                          onChange={(e) => actions.setSessionRole(session.id, { canUseTeams: e.target.checked })}
                        />
                      </label>

                      <label className="node-powers__row">
                        <span>Model</span>
                        <span className="node-powers__pair">
                          <select
                            value={session.modelChoice ?? ''}
                            onChange={(e) => actions.setSessionRole(session.id, { modelChoice: e.target.value || null })}
                          >
                            <option value="">whatever the account defaults to</option>
                            {MODELS.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn btn--ghost node-powers__now"
                            disabled={!session.modelChoice || session.pid === null || session.adapterId !== 'claude'}
                            title="Types /model into this session now. Otherwise it applies at the next start."
                            onClick={() => actions.applyNow(session.id, 'model')}
                          >
                            now
                          </button>
                        </span>
                      </label>

                      <label className="node-powers__row">
                        <span>Effort</span>
                        <span className="node-powers__pair">
                          <select
                            value={session.effortChoice ?? ''}
                            onChange={(e) => actions.setSessionRole(session.id, { effortChoice: e.target.value || null })}
                          >
                            <option value="">whatever the model defaults to</option>
                            {EFFORTS.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn btn--ghost node-powers__now"
                            disabled={!session.effortChoice || session.pid === null || session.adapterId !== 'claude'}
                            title="Types /effort into this session now. The CLI may ask you to confirm it."
                            onClick={() => actions.applyNow(session.id, 'effort')}
                          >
                            now
                          </button>
                        </span>
                      </label>

                      {/*
                       * Read off the same table the create form and the settings file both read,
                       * rather than a fourth hand-typed copy that has to be remembered every time a
                       * role is added, removed or renamed. It used to stop at reviewer and never
                       * offer the role that could actually create a card, which is exactly the
                       * failure mode a shared table exists to rule out: not a wrong description, an
                       * impossible one.
                       */}
                      <label className="node-powers__row">
                        <span>This card is a</span>
                        <select
                          value={session.roleClass ?? ''}
                          onChange={(e) =>
                            actions.setSessionRole(session.id, {
                              roleClass: (e.target.value || null) as TerminalSession['roleClass'],
                            })
                          }
                        >
                          <option value="">not said</option>
                          {ROLE_CHAIN.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      {/* The chosen role's own brief, quoted rather than retyped a fourth time. */}
                      {session.roleClass && ROLE_POWERS[session.roleClass] && (
                        <p className="node-powers__note">{ROLE_POWERS[session.roleClass]!.summary}</p>
                      )}

                      {/*
                       * Said here, next to the control, not only in the folded strip above.
                       *
                       * The CLI reads a session's permissions once, at launch, and never again. The
                       * picker above moves the instant it is touched because the board's own record
                       * changed, but the process behind this card has not: it was told what it is
                       * once and is still that until it is turned off and on. Drawing the new value
                       * as though it were already in force would be exactly the kind of claim this
                       * project exists to refuse, so a running card that disagrees with its own
                       * picker says so in words, right where the disagreement was just created.
                       */}
                      {roleBit && (
                        <p className="node-powers__pending">
                          Applies at the next start. Running now as {session.roleClassRunning}.
                        </p>
                      )}
                    </>
                  )}

                  <div className="node-powers__row node-powers__row--read">
                    <span>{agentEnded ? 'Last ran' : 'Running'}</span>
                    <span className="node-powers__value">
                      {session.model ?? 'model not reported'} · {session.effort ?? 'effort not reported'}
                      {/* The role the live process was launched with is only worth a word when it
                          is not the one the picker above is showing. Naming it there says which of
                          the two the agent inside will actually defend. */}
                      {roleBit && ` · as a ${session.roleClassRunning}`}
                    </span>
                  </div>

                  <div className="node-powers__row node-powers__row--read">
                    <span>Tokens</span>
                    <span className="node-powers__value">
                      {/*
                        The denominator comes from the model this card is running, not from a
                        constant.

                        It was the literal string "of 1,000,000" here, which is the third copy of
                        this answer this codebase has had and the last one still wrong. The owner
                        moved his orchestrator to Fable and the card went on reading "278,747 of
                        1,000,000" beside a model name that was no longer Opus. The bar above was
                        already honest about it and drew itself blank; this line was not, and a
                        number is more believable than a blank bar, so the wrong one won.

                        When the window is not known, the count still shows, because how many tokens
                        a card has spent is a fact whether or not Garden knows what to divide it by.
                        What it stops doing is dividing it by something nobody chose.
                      */}
                      {session.tokensUsed === null
                        ? 'none seen'
                        : `${session.tokensUsed.toLocaleString()}${
                            contextWindowFor(session.model)
                              ? ` of ${contextWindowFor(session.model)!.toLocaleString()}`
                              : ', and the window for this model is not known here'
                          }${session.contextSource === 'terminal' ? ', read from the terminal' : ''}`}
                    </span>
                  </div>

                  {isAgent ? (
                    <p className="node-powers__note">
                      Nothing here can be set on an agent card. Garden never launched this agent, so
                      it has no settings file of its own to write and no next start to apply one at.
                      These two lines are what the CLI reported while it was running, or say that it
                      reported nothing.
                    </p>
                  ) : (
                    <p className="node-powers__note">
                      Hiring, team size and this card's role are read by the CLI when this card
                      starts, so they apply the next time it is turned on. A running session was told
                      its role once and will keep to that one. Model and effort can be pushed into a
                      running session with the button beside them.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="node-meta">
            <span className="chip">{ADAPTER_LABEL[session.adapterId] ?? session.adapterId}</span>
            {project && (
              <span className="chip chip--project" style={{ color: project.color }}>
                {project.name}
              </span>
            )}
            {/* Says what kind of card this is, not just what it is doing: an agent card has no PTY,
                which is why the line below it addresses the card that hired it and why nothing on
                the card offers to turn it on. */}
            {isAgent && (
              <span
                className="chip chip--kind"
                title={
                  session.kind === 'subagent'
                    ? 'A subagent, spawned from a real dispatch event. No process of its own.'
                    : 'A teammate session, a peer agent rather than a process this card owns.'
                }
              >
                {session.kind}
              </span>
            )}
            {session.role && (
              <span
                className="chip chip--role"
                style={{ color: session.color ?? undefined, borderColor: session.color ?? undefined }}
              >
                {session.role}
              </span>
            )}
            {/* The model used to be repeated here. The settings strip above already names it, and
                two lines of chrome saying the same thing is two lines the terminal does not get. */}
            {session.transcriptPath && (
              <button
                className="chip chip--transcript nodrag"
                title={`Open transcript: ${session.transcriptPath}`}
                onClick={() => actions.openTranscript(session.id)}
              >
                transcript
              </button>
            )}
            {/* Which account this session spends on. Exact: it is read from the config dir the
                process was actually launched with, not inferred. */}
            {session.adapterId !== 'shell' && (
              <span
                className={`chip chip--account ${account ? '' : 'chip--unknown'}`}
                title={
                  account
                    ? `Running as ${account}`
                    : 'This profile is not signed in yet. Run /login inside this session.'
                }
              >
                {account ?? 'not signed in'}
              </span>
            )}
          </div>

          {/*
            An agent card shows its conversation where a session card shows its terminal.

            This block used to be three lines of facts, type and status and finish time, because an
            agent has no PTY and a pane reading "no output yet" for ever looks broken rather than
            looking like what it is. The owner has overruled that: he wants an agent card built to
            the same template as the cards he starts himself, and the thing he named as missing was
            the conversation. The transcript was always on disk, so the pane is filled from that
            file rather than from anything guessed, and what it cannot fill it says plainly. The
            three facts have not been thrown away: status is the word in the header, type is the
            role chip above, and the finish time is kept at the foot of the pane, which is where the
            end of a conversation belongs anyway.

            Two attributes on the pane are load bearing. `nowheel` makes the wheel scroll the
            conversation instead of zooming the board, and `minHeight: 0` is what lets it scroll at
            all: a flex child floors itself at its own content height without it, so a long
            conversation would have grown the pane until it pushed the line below it off the bottom
            of the card.
          */}
          {showChat ? (
            <AgentChat
              sessionId={session.id}
              transcriptPath={session.transcriptPath}
              status={session.status}
              exitedAt={session.exitedAt}
              formatWhen={formatWhen}
            />
          ) : (
            // Double-click grows the card: its own size, then a working size, then the workspace.
            <div
              className="mini-wrap"
              title="Double-click to make this card bigger"
              onDoubleClick={(e) => { e.stopPropagation(); actions.toggleSessionSize(session.id) }}
            >
              <TerminalMini sessionId={session.id} everRan={session.exitedAt !== null} />
            </div>
          )}

          {/*
            An agent card's line, which goes to the card that hired it.

            Agent cards used to have no input at all, on the grounds that a greyed-out box implies a
            process is there to reach. The owner asked for the line back, and the way to give it to
            him without making that implication is to send it somewhere that can actually act on it.
            That is the parent: a real session with a real PTY, recorded from the dispatch Garden
            watched, and the only thing on this branch of the board that can do anything about what
            he types. The placeholder names it, so the line never looks like it is going into the
            agent, and it goes off when the parent is not running rather than accepting a keystroke
            that has nowhere to land.

            No control keys here, and Escape is refused out loud rather than merely left unhandled.
            Ctrl+C, Escape and Tab all act on a whole session: Escape is what the CLI reads as
            "cancel what you are doing", so sending one from a child's card would kill a turn
            running in the parent, which the owner would have no reason to expect from a box drawn
            on the child. He lost a turn of work to exactly that shape of mistake, so this line
            swallows the keystroke and drops focus instead, and the only thing it ever sends is the
            text he typed followed by the Enter he pressed.
          */}
          {isAgent && (
            <form
              className="node-input nodrag"
              /*
               * Straight to the agent while it is running, and to the card that hired it once it
               * has ended.
               *
               * The owner's point, and he was right: a running agent IS reachable, it is what the
               * arrow keys in his terminal do. It has no process of its own, so Garden gets there
               * by driving the parent's agent list, reading the screen to confirm the right row is
               * selected before it types. That can fail for ordinary reasons and the answer comes
               * back separately, so nothing here claims the line landed.
               *
               * A finished agent is not in that list at all, so there is nothing to reach and the
               * line goes to the parent instead, which is the only thing that can act on it.
               */
              onSubmit={(e) => {
                e.preventDefault()
                if (!line) return
                if (!agentEnded) {
                  actions.sayToAgent(session.id, line)
                  setLine('')
                  setSentAt(Date.now())
                  return
                }
                if (!parentLive || !parent) return
                sendLine(parent.id, line)
                setLine('')
                setSentAt(Date.now())
              }}
            >
              {/* An arrow, not the terminal's own caret. This line leaves the card it is drawn on,
                  and the glyph should say so before the placeholder is read. */}
              <span className="node-input__caret" title="Goes up to the card that hired this agent">
                ↑
              </span>
              <input
                value={line}
                onChange={(e) => setLine(e.target.value)}
                /*
                 * Short enough to fit the card it is drawn on.
                 *
                 * These read well in a source file and not on screen: a blind reviewer found the
                 * longest of them running off the right edge of the card, cut mid-word at "so
                 * ther". An agent card is narrower than a session card, so a placeholder is a label
                 * and not a sentence. The full explanation is still there in the tooltip below,
                 * which is where a sentence belongs.
                 *
                 * "type", never "message". This box sits right under a pane drawn to look like a
                 * conversation (Asked / Said / Did above it), and "message this agent" read as an
                 * invitation to compose something that would travel the mailbox the way one agent
                 * reaches another. It does not: it is the owner's own keystrokes landing straight
                 * in a terminal, his exactly as PowerShell or bash would take them. "type to" says
                 * that plainly, and matches the wording the plain session input already uses two
                 * cases below.
                 */
                placeholder={
                  !agentEnded
                    ? sentAt != null
                      ? 'sent'
                      : 'type to this agent'
                    : !parent
                      ? 'no parent card recorded'
                      : !parentLive
                        ? `${parent.title} is off`
                        : sentAt != null
                          ? `sent to ${parent.title}`
                          : `type to ${parent.title}`
                }
                // A running agent is reachable through its parent's terminal, so the only case with
                // nowhere to go is a finished one whose parent is also off.
                disabled={agentEnded && !parentLive}
                spellCheck={false}
                title={
                  parentLive && parent
                    ? `Typed straight into ${parent.title}'s terminal, exactly as written. This agent has no process of its own to type into.`
                    : 'This agent has no process of its own, and the card that hired it is not running either, so there is nowhere for this line to go.'
                }
                onKeyDown={(e) => {
                  e.stopPropagation()
                  // Escape leaves the line and reaches nothing else. Left merely unhandled it would
                  // still be a keystroke travelling up a page that has terminals on it, and the one
                  // process it could plausibly land in is the parent's, mid-turn.
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    e.currentTarget.blur()
                  }
                }}
              />
            </form>
          )}

          {/*
            A real terminal line, not a chat box. What you type is written to this session's PTY
            exactly as typed, with a carriage return, which is the same thing the full terminal
            does. So a prompt answer, a slash command and a shell command all work, and nothing
            is interpreted or invented on the way through.
          */}
          {!isAgent && (
            <form
              className="node-input nodrag"
              onSubmit={(e) => {
                e.preventDefault()
                /*
                  A card that is off starts itself and keeps the line. Enter alone will not do it:
                  there is no prompt on the other side yet to accept a bare Enter, and a keystroke
                  sent to a dead PTY is discarded in silence.
                */
                if (off) {
                  if (!line) return
                  actions.startSession(session.id)
                  setPending(line)
                  setLine('')
                  return
                }
                // Enter on an empty line is a bare Enter, which is how the highlighted choice in
                // a permission prompt is accepted. Swallowing it left the card unable to answer.
                if (!line) {
                  actions.input(session.id, CR)
                  return
                }
                sendLine(session.id, line)
                setLine('')
              }}
            >
              <span className="node-input__caret">›</span>
              <input
                value={line}
                onChange={(e) => setLine(e.target.value)}
                placeholder={
                  pending != null
                    ? 'starting, your line is waiting…'
                    : off
                      ? 'type here to start this session'
                      : 'type into this terminal'
                }
                // Only ever disabled while a line is already queued, so a second one cannot be
                // typed into a session that has nowhere to put the first.
                disabled={pending != null}
                spellCheck={false}
                title={
                  off
                    ? 'Starts this session and sends what you typed once it is up'
                    : "Typed straight into this session's terminal, exactly as written"
                }
                onKeyDown={(e) => {
                  e.stopPropagation()
                  // Ctrl+C has to reach the process, not the browser, or a runaway agent cannot be
                  // stopped from here.
                  if (e.key === 'c' && e.ctrlKey) {
                    e.preventDefault()
                    actions.input(session.id, CTRL_C)
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    actions.input(session.id, ESC)
                    return
                  }
                  /*
                    Tab cycles a Claude session's permission mode, and the browser's own use for
                    it is to move focus to the next control. Both happening at once meant the mode
                    changed and the card stopped accepting typing in the same keystroke, which
                    reads as the input having died.
                  */
                  if (e.key === 'Tab') {
                    e.preventDefault()
                    actions.input(session.id, e.shiftKey ? SHIFT_TAB : TAB)
                    return
                  }
                  /*
                    Arrows move the selection in a prompt that offers a list. Only when the line is
                    empty: with text in it they are still the caret keys they look like.
                  */
                  if (!line && ARROW[e.key]) {
                    e.preventDefault()
                    actions.input(session.id, ARROW[e.key]!)
                  }
                }}
              />
            </form>
          )}

          {/*
            The footer holds one thing, and only when there is one thing worth holding.

            Open terminal, turn on and rename all left it. Typing into the card's own input line
            starts a session and drives it, which is now true rather than only claimed: the input
            was disabled whenever the card was off, so the one justification for dropping the
            "Turn on" button was the one thing the card would not do. Expanding is a header control, and renaming is
            a pencil in the header now, so those three buttons spent a row of every card offering
            a second way to do something the card already did. All three are still on the
            right-click menu, which is where the actions that are not everyday live.

            An agent card keeps its transcript button, because reaching that transcript is the
            entire reason the card is kept after the agent is gone.
          */}
          {isAgent && session.transcriptPath && (
            <footer className="node-actions">
              <button className="btn btn--primary nodrag" onClick={() => actions.openTranscript(session.id)}>
                Open transcript
              </button>
            </footer>
          )}
        </>
      )}
    </div>

    {/*
      What this card can call, pinned to its right edge.

      A sibling of .node rather than a child, for the same reason the ports and the context gauge
      are: .node has overflow:hidden to clip the terminal preview to its rounded corners, and
      anything positioned past the card's edge from inside it is clipped away entirely. At this
      level the offset parent is the node's own box, which is what the 8px pin measures from, so
      the list travels with the card at any zoom.

      It draws nothing when there is nothing to show, and it never carries a Handle: both spawn
      points belong to the card, and a wire from this list would promise a channel the mail spine
      would then refuse.
    */}
    <SubagentList
      ownerId={session.id}
      ownerTitle={session.title}
      entries={reachable}
      onOpen={(id) => actions.focus(id)}
      onTranscript={(id) => actions.openTranscript(id)}
    />

    {/*
      The connection dots live outside the card, not inside it.

      A dot sits half past the card's edge so a wire visibly lands ON something rather than
      touching a bare border. The card clips its own overflow, to keep the terminal preview inside
      its rounded corners, and that clip was taking the outer half of every dot with it. Rendering
      the ports as siblings of the card rather than children puts them outside that clip, the same
      trick the context gauge needs and for the same reason.
    */}
      {/*
        Both sides are spawn points and they mean the same thing.

        They used to read "Made by" on the left and "Its agents" on the right, swapping when a card
        was mirrored, which asserted that a side carried seniority. It does not. A card that hired
        this one and a card this one hired can sit on the same side, so the label promised a
        direction the position cannot deliver, and the mirroring existed only to keep that promise
        from being visibly wrong half the time.

        The direction is carried by the wire itself, in its arrowheads and its own label, which is
        the one place it is actually known. Canon: docs/canonical/13-card-orientation.md.
      */}
      <div className="port port--left">
        <Handle id="in" type="target" position={Position.Left} className="node-pin" />
        <Handle id="outLeft" type="source" position={Position.Left} className="node-pin node-pin--stacked" />
        <span className="port-label port-label--left">Spawn point</span>
      </div>

      <div className="port port--right">
        <Handle id="out" type="source" position={Position.Right} className="node-pin" />
        <Handle id="inRight" type="target" position={Position.Right} className="node-pin node-pin--stacked" />
        <span className="port-label port-label--right">Spawn point</span>
      </div>

      {/*
        Four dots, one meaning each, and no exceptions.

        Top is history. Bottom is the files this session runs from. Left and right are connections
        to other sessions and agents. That rule is the whole point of the layout: a wire's meaning
        has to be readable from where it leaves the card, without clicking it.

        This used to be six handles, with a spawn-parent dot sharing the top edge with history and
        a spawn-child dot sharing the bottom edge with the file web. Two meanings on one edge is
        why wires appeared to attach at random: a dispatch wire could leave the same side as the
        file web, and which dot a wire picked depended on where the two cards happened to sit.
        Both are gone, and a dispatch now always leaves the right and arrives at the left.

        The top and bottom handles anchor wires but are never dragged from: those webs open by
        clicking the dot, so the handle ignores the pointer and the button underneath takes it.
      */}
      {/*
        Arrows rather than dots, pointing the way each web opens.

        Same two connection points doing the same two jobs, drawn differently. A round dot on all
        four sides said "a wire lands here" four times over, when only the left and right ones join
        two cards; these two unfold a block above or below. An arrow says which way it goes before
        it is clicked, and it stops the eye reading four identical dots as four of the same thing.

        The top one was a span with no handler at all, so the history web could only be opened from
        the right-click menu while the bottom one opened on a click. Both are buttons now.
      */}
      <div className="port port--top">
        <Handle
          id="history"
          type="source"
          position={Position.Top}
          className="node-pin node-pin--under"
        />
        <button
          className={`port-arrow port-arrow--up nodrag ${historyOpen ? 'is-open' : ''}`}
          title={
            historyOpen
              ? 'Fold this history away'
              : refusalCount > 0
                ? `History, and ${refusalCount} refusal${refusalCount === 1 ? '' : 's'} folded behind it`
                : 'History: what this session has done, opened above the card'
          }
          // Pressing it again folds the block away, the same as the roots dot below. Only the
          // bottom one ever toggled, so the top one kept reopening a block that was already there.
          onClick={() => {
            if (historyOpen) actions.closeHistoryWeb(session.id)
            else actions.openHistoryWeb(session.id)
          }}
        >
          ▲
        </button>
        {/*
          The label says the refusals are there while they are folded, and it is the only thing that
          does. The arrow was marked as well at first and the owner said no: "i dotn want the button
          to be red for history refused". He is right that the colour was the weaker half. Canon 15
          requires that a refusal is never hidden, and a count in words satisfies that better than a
          border does, because a colour has to be learned before it means anything.
        */}
        <span className="port-label port-label--top">
          {historyOpen ? 'Fold away' : refusalCount > 0 ? `History · ${refusalCount} refused` : 'History'}
        </span>
      </div>

      <div className="port port--bottom">
        <Handle
          id="context"
          type="source"
          position={Position.Bottom}
          className="node-pin node-pin--under"
        />
        <button
          className={`port-arrow port-arrow--down nodrag ${contextOpen ? 'is-open' : ''}`}
          title={
            contextOpen
              ? 'Fold these roots away'
              : 'Roots: what this session works from, as columns. Open a column to see its files.'
          }
          onClick={() => {
            /*
             * Columns, not files.
             *
             * This used to call `openContextWeb` with no group, which puts every file on the board
             * at once. On a real card that is over a hundred cards arriving together, and the
             * owner's report was that it "makes it too laggy the way it is right now". The columns
             * carry the same counts, so nothing is hidden; the files are one click further.
             */
            if (contextOpen) actions.closeContextWeb(session.id)
            else actions.openContextColumns(session.id)
          }}
        >
          ▼
        </button>
        <span className="port-label port-label--bottom">{contextOpen ? 'Fold away' : 'Roots'}</span>
      </div>


    {/*
      Context gauge. Fills from the bottom as the window fills, and turns amber then red as a
      session approaches the point where it stops being worth trusting. Shows "no data" (a dashed,
      hatched track) rather than an estimate: the CLI only writes its token count into the
      transcript after a turn finishes, so null is the common state for most of a session's life,
      not a rare edge case, and a guessed gauge is worse than none here, since the entire reason
      to look at it is deciding whether a session is too full, which a made-up number cannot
      answer.
    */}
    {/*
      Dimmed when nothing is running, because a full bar beside the word "off" reads as activity.

      The number is real: it is what the last run reached, and it is worth keeping, since how full a
      card got is exactly what decides whether to resume it or start it fresh. But drawn at full
      strength on a stopped card, a blind reviewer read the bright bar as "this one is alive" next to
      a header saying it was not. Same fact, drawn as history rather than as a live reading.
    */}
    <div
      className={`ctxbar ${session.contextUsed === null ? 'is-unknown' : ''} ${off ? 'is-stale' : ''}`}
      title={
        session.contextUsed === null
          ? 'Context usage is not published yet. The CLI writes its token count into the transcript after a turn finishes, so this is empty for most of a session\'s life, not a guess and not an error.'
          : `${off ? 'Where its last run got to: context window' : 'Context window'} ${Math.round(session.contextUsed * 100)}% full` +
            (session.tokensUsed ? ` (${session.tokensUsed.toLocaleString()} tokens)` : '')
      }
    >
      <div
        className={`ctxbar-fill ${
          (session.contextUsed ?? 0) > 0.85 ? 'is-high' : (session.contextUsed ?? 0) > 0.6 ? 'is-mid' : ''
        }`}
        style={{ height: `${Math.min(100, Math.max(0, (session.contextUsed ?? 0) * 100))}%` }}
      />
    </div>
    </>
  )
})
