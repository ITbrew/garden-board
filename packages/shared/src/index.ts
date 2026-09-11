/**
 * The contract between the renderer and the server.
 *
 * One rule governs this file: the renderer never names an executable. It names a project,
 * a profile and an adapter by id, and the server resolves those into a command line. That is
 * why terminal output can never cause a command to run.
 */

export type Provenance = 'structured' | 'inferred'

/**
 * A card outlives its process. `stopped` means you turned it off or it exited cleanly, `done`
 * means an agent finished its work, and both keep the card on the board with its history. Only
 * an explicit, confirmed delete ever removes a card.
 */
export type SessionStatus =
  | 'starting'
  | 'idle'
  | 'working'
  | 'needs-input'
  | 'done'
  | 'stopped'
  | 'failed'

/** How much of a live session is currently being drawn. The process is live in every case. */
export type NodeRenderState = 'collapsed' | 'preview' | 'expanded'

export interface Project {
  id: string
  name: string
  path: string
  color: string
  defaultAdapterId: AdapterId
  /**
   * The account each CLI uses in this project, enforced rather than suggested: the server
   * ignores any profile the renderer asks for and uses this map. One Claude account and one
   * Codex account can coexist in a tab, and can be wired together, but two Claude accounts
   * cannot, because keeping those financially separate is the whole point.
   */
  profiles: Partial<Record<AdapterId, string | null>>
  /** Kept for the Claude slot so older rows keep working. Prefer `profiles`. */
  defaultProfileId: string | null
  notes: string
  createdAt: number
  lastOpenedAt: number
}

export type AdapterId = 'shell' | 'claude' | 'codex'

/**
 * A profile is a managed config directory Garden owns. It holds no secrets: it points at the
 * CLI's own credential store via CLAUDE_CONFIG_DIR / CODEX_HOME and never reads it.
 */
export interface Profile {
  id: string
  name: string
  adapterId: AdapterId
  configDir: string
  /** Read from the config dir's oauthAccount. Null means not signed in, never a guess. */
  accountEmail: string | null
  accountName: string | null
  organizationName: string | null
  createdAt: number
}

/**
 * What a card stands for.
 *
 * `session` is a process Garden launched and can type into. `subagent` and `teammate` are cards
 * created from a real hook event, holding an agent that ran inside or beside a session. Neither
 * has a PTY, so neither can be typed into or turned on, and both stay on the board with their
 * transcript after the agent exits. That last part is the whole reason they exist.
 */
export type CardKind = 'session' | 'subagent' | 'teammate'

/**
 * Whether the board draws this card, in one place because two places disagreed.
 *
 * The canvas stopped drawing subagents and the server went on avoiding them. So the layout was
 * built from 24 rectangles on a board showing three, and a card dragged into visibly empty space
 * was shoved aside by spent agents and by cards the owner had closed and parked. He could see the
 * space and Garden could not, and nothing on screen could explain the difference.
 *
 * Every rule that has to match what he can see reads this: the canvas filter, and the server's
 * `occupiedRects`. Anything that reasons about space rather than about rows belongs here too. A
 * second definition of "visible" is exactly how this came back the first time.
 *
 * Note what this is NOT for. A subagent card is hidden, not gone: it keeps its transcript, its
 * wire and its history, and every route that reads a card still finds it. This answers one
 * question only, which is whether a rectangle exists on screen.
 */
export function drawnOnBoard(card: { kind: CardKind; closedAt: number | null }): boolean {
  return card.closedAt === null && card.kind !== 'subagent'
}

/** What a card's model and effort are called, everywhere they are named. */
export interface ModelEffortCard {
  kind: CardKind
  pid: number | null
  status: string
  exitedAt: number | null
  model: string | null
  modelChoice: string | null
  effort: string | null
  effortChoice: string | null
}

/** No process behind this card. An agent card is never "off": it ran and finished. */
export function cardIsOff(card: Pick<ModelEffortCard, 'kind' | 'pid' | 'status'>): boolean {
  return (
    card.kind === 'session' &&
    (card.pid === null || card.status === 'stopped' || card.status === 'failed' || card.status === 'done')
  )
}

/** An agent card whose run is over, which reads the same way as a card that is off. */
export function agentHasEnded(card: Pick<ModelEffortCard, 'kind' | 'status' | 'exitedAt'>): boolean {
  return card.kind !== 'session' && (card.status === 'done' || card.exitedAt !== null)
}

/**
 * What to call this card's model and effort, said the same way wherever they are shown.
 *
 * Two surfaces name these: the card's own powers strip and the rail's lists. One function, because a
 * rail saying one thing while the card beside it says another is two answers to the same question,
 * and the owner reads the rail precisely to avoid opening each card.
 *
 * A model is named and nothing else: "opus-5 . high effort", running or not. Both prefixes it used to
 * carry are gone at the owner's instruction, first "running" and then "last": "remove the words
 * 'running' from 'running opus-5' 'running high effort'", then "do the same for 'last'".
 *
 * What the prefixes were for is worth recording, because it is why they could go. A blind reviewer
 * read "off" in a card's header and "running opus-5" underneath it and could not say which was true;
 * both were, and the fix at the time was to mark the stale observation as "last". With "running"
 * gone, no row claims a live process at all. A bare model name is a name rather than a claim, and
 * what says whether anything is behind it is the card's own status dot and the rail's headings, both
 * of which are beside it.
 *
 * A choice the live process has not taken up is still marked pending, because that is a real
 * disagreement between two values rather than a label on one. A card with neither reads "default",
 * because Garden does not know what the CLI's default resolves to and will not guess a name.
 *
 * An agent card reports only what was watched. `modelChoice` is copied onto it from whoever hired it
 * at the instant it spawned, and there is no next start for it to apply at, so a pending state there
 * would describe a change that can never happen.
 */
export function modelAndEffort(card: ModelEffortCard): { model: string; effort: string } {
  const isAgent = card.kind !== 'session'
  const model = isAgent
    ? card.model
      ? card.model.replace(/^claude-/, '')
      : 'model not reported'
    : card.modelChoice
      ? card.model && card.model !== card.modelChoice
        ? `${card.modelChoice} pending`
        : card.modelChoice
      : card.model
        ? card.model.replace(/^claude-/, '')
        : 'default model'

  const effort = isAgent
    ? card.effort
      ? `${card.effort} effort`
      : 'effort not reported'
    : card.effortChoice
      ? card.effort && card.effort !== card.effortChoice
        ? `${card.effortChoice} pending`
        : card.effortChoice
      : card.effort
        ? `${card.effort} effort`
        : 'default effort'

  return { model, effort }
}

/**
 * May this card dispatch a subagent? Asked once, answered the same way everywhere.
 *
 * There are three inputs and they are not interchangeable, which is the reason this is a function
 * rather than three `&&`s written out at each call site. The two call sites are the deny list in
 * the settings file, written at launch, and Garden's own hook, asked per dispatch. They have to
 * agree: a card launched with `Agent` denied and a hook that would have allowed it is a card the
 * owner turned on and cannot fix without restarting it.
 *
 * The card's own answer wins outright, in both directions, because that is what the owner asked
 * this control for: one board where one card has subagents and another does not.
 *
 * A card that has not answered follows the board, and is still held to `canSpawnAgents`. That flag
 * means may this card hire agents at all, and a card told no there must not gain subagents from
 * having said nothing here. Canon 15, "A card may answer for itself, and its answer wins".
 */
export function subagentsAllowedFor(
  card: { subagentsAllowed: boolean | null; canSpawnAgents: boolean },
  boardAllows: boolean,
): boolean {
  if (card.subagentsAllowed !== null) return card.subagentsAllowed
  return boardAllows && card.canSpawnAgents
}

/**
 * The statuses a card has while something is actually running behind it.
 *
 * Here rather than in the server's SQL, because the header and the ceiling both answer "how many
 * are running" and they used to answer it differently: the header counted a live pid, the ceiling
 * counted these statuses, and a subagent card has status `working` with no process at all. So a
 * board drawing two cards said "none running" at the top and "2 of 6" in the rail, both from the
 * same rows.
 */
export const RUNNING_STATUSES: readonly SessionStatus[] = ['starting', 'idle', 'working', 'needs-input']

/**
 * Whether something is running behind this card, asked once and answered the same way everywhere.
 *
 * Drawn first, because a card the board does not draw cannot be running on it: a spent subagent
 * keeps `working` forever with a null pid, and counting those against the running ceiling refused
 * the owner a card for a reason that had stopped being true hours earlier.
 */
export function runningOnBoard(card: { kind: CardKind; closedAt: number | null; status: SessionStatus }): boolean {
  return drawnOnBoard(card) && RUNNING_STATUSES.includes(card.status)
}

/**
 * What a card is for, as one name rather than the same seven words written out in four places.
 *
 * It was spelled inline on the session row and on two client messages, which is survivable until
 * something else has to refer to a role by type: a task's `requiredRole` is a role, and a
 * reassignment refused for `missing_capability` compares against one. Three copies of a union drift
 * the first time one of them gains a member, and this one just did.
 *
 * `verifier` is the new member. `reviewer` is untouched and stays what it is; canon 20 says why a
 * new role exists rather than a loosened one, and the short version is that a reviewer is denied
 * Bash and Write, so it cannot run the send shim and cannot write the file the shim sends. Every
 * blind pass on this board has therefore been a subagent inside somebody else's turn. A persistent
 * independent verifier has to be able to report, so it keeps Write, Edit and Bash from the CLI and
 * loses them at the hook instead.
 */
export type RoleClass =
  | 'orchestrator'
  | 'boss'
  | 'manager'
  | 'worker'
  | 'reviewer'
  | 'delegator'
  | 'verifier'

export interface TerminalSession {
  id: string
  projectId: string
  profileId: string | null
  adapterId: AdapterId
  kind: CardKind
  title: string
  cwd: string
  pid: number | null
  status: SessionStatus
  /**
   * Why this session is waiting, straight from the CLI's own session file: `permission prompt`,
   * `input needed`, `dialog open` and so on. Null unless the status is needs-input.
   */
  waitingFor: string | null
  /** When the current status began, so a card can say how long it has been waiting. */
  statusSince: number | null
  /** The subagent's own id from SubagentStart. Null for anything not spawned as one. */
  agentId: string | null
  /** The card that spawned this one, from a real dispatch event. Never inferred. */
  parentId: string | null
  /** Absolute path to this agent's transcript, once the CLI names one. */
  transcriptPath: string | null
  /** Set once the CLI reports it. Null means we do not know, never a guess. */
  claudeSessionId: string | null
  /**
   * How full this session's context window is, 0 to 1.
   *
   * Null until Garden reads the CLI's own numbers, which arrive with the statusline and hook
   * spine. It stays null rather than being estimated: a context gauge that guesses is worse than
   * no gauge, because the whole point is deciding when a session is too full to trust.
   */
  contextUsed: number | null
  /** Tokens this session has consumed, once the CLI reports them. Null is never a guess. */
  tokensUsed: number | null
  /**
   * Where that number came from, so the card can say how much it is worth.
   *
   * `transcript` is the CLI's own usage record, which is exact but is only written some time
   * after a turn ends. `terminal` is the figure the CLI prints on its own spinner and agent tree,
   * read from the session's buffer, which is live but is a rendered number rather than a
   * published one. Null means nothing has been seen and the gauge stays blank.
   */
  contextSource: 'transcript' | 'terminal' | null
  /**
   * Text size inside this card, in pixels, set with ctrl and the mouse wheel. Per card rather
   * than global, because a card you are reading and a card you are only monitoring want
   * different sizes on a board this wide.
   */
  fontSize: number | null
  /**
   * What this card's body shows: the terminal miniature, or the conversation.
   *
   * The terminal is a picture of drawing instructions, capped at 256 KB, reset by every restart and
   * unreadable the moment a TUI takes the screen over. The conversation comes from the CLI's own
   * transcript file, so it says what was actually asked and answered and it survives the process,
   * the card being turned off, and the app restarting. Which one a card shows is a real preference
   * and so it is stored rather than held in the browser: it has to survive a reload and reach a
   * second window, the same as the card's size and its colour.
   *
   * Null means the card has not been told, and the default is chosen by kind: a subagent card has no
   * process behind it and never had a terminal to show, so it opens on the conversation.
   */
  bodyView: 'terminal' | 'chat' | null
  model: string | null
  permissionMode: string | null
  /** True only for sessions Garden launched. Others are observe-only. */
  managed: boolean
  x: number
  y: number
  width: number
  height: number
  /**
   * False until the node is dragged. While every node in a project is still false, the canvas
   * tiles them to fill the viewport, because a handful of fixed-size cards on a 4K ultrawide
   * reads as an unfinished layout. The first drag hands control back to the owner for good.
   */
  manualPos: boolean
  renderState: NodeRenderState
  pinned: boolean
  /** Header only, no preview. Lets many cards sit on the canvas at once. */
  collapsed: boolean
  /**
   * Colour coding for roles and teams. Null means take the adapter's default, so an uncoloured
   * board still reads sensibly. Agent-spawned cards will set this from their agent type.
   */
  color: string | null
  /** The agent type this card is running, once that is known. Null is never a guess. */
  role: string | null
  /**
   * What this card is FOR, which is the owner's call rather than something to be detected.
   *
   * A manager takes an unstructured request and decides who does what. A delegator hands out
   * work that has already been specified. A worker does the job itself and does not hire anyone.
   * The distinction matters because the same prompt costs wildly different amounts depending on
   * which of the three is reading it, and because a specialist told to do the work should not
   * quietly turn into a second orchestrator.
   */
  roleClass: RoleClass | null
  /**
   * Whether this session may spawn subagents, and whether it may hire teammates.
   *
   * Enforced through the CLI's own permission layer rather than by Garden intercepting anything:
   * the per-session settings file Garden already passes carries a deny entry, so the CLI refuses
   * the tool itself. Garden does not become a second authority arguing with the first.
   */
  canSpawnAgents: boolean
  canUseTeams: boolean
  /**
   * Whether THIS card may dispatch subagents, overriding the board's answer.
   *
   * Three states, and the third one is the point. Null means this card has not answered and the
   * board's `BoardLimits.subagentsAllowed` decides; true and false are this card overruling it in
   * either direction. The owner asked for exactly that: "make individual card controls override the
   * global cieling if the user wants one card to have sub agents/not the other".
   *
   * A boolean would have been the obvious field and would have broken the feature on the day it
   * shipped. Every existing card would have arrived as an explicit yes, so a board set to no would
   * have been overridden by every card on it and the ceiling row would have refused nothing while
   * appearing to work. A card that has never been touched has to be silent rather than agreeing.
   *
   * Not `canSpawnAgents` above, which asks whether this card may hire agents and is checked where a
   * hire is requested. One control answering two questions leaves no way to say "hires nobody, but
   * dispatches subagents". `canSpawnAgents` set to false still denies the dispatch tool, so a card
   * that may not hire at all does not quietly gain subagents from this field being unset. Canon 15,
   * "A card may answer for itself, and its answer wins".
   */
  subagentsAllowed: boolean | null
  /** Reasoning effort, as reported by the CLI. Null until it says, never assumed. */
  effort: string | null
  /**
   * What the owner chose, as opposed to what the CLI reported.
   *
   * Kept apart from `model` and `effort` on purpose. Those two are observations: what this session
   * turned out to be running. These two are instructions: what it should run as next time it
   * starts. Collapsing them into one field would mean a card could not show a choice that has not
   * taken effect yet, which is exactly the case the owner needs to see.
   */
  modelChoice: string | null
  effortChoice: string | null
  /**
   * How many agents this card may have working for it at once.
   *
   * Zero is the only value the CLI enforces absolutely, by refusing the tool outright. Any other
   * number is passed as the CLI's own concurrency cap, which limits how many run AT ONCE rather
   * than how many it may hire in total, and is also written into the card's files as the number it
   * was asked to keep to. The card says which of those two things it is promising.
   */
  teamSize: number | null
  /**
   * The card this one answers to. Null means it answers to the owner.
   *
   * Set from a real dispatch when Garden saw one, and by hand otherwise. Changing it moves the
   * wire, because who reports to whom is a thing on the board rather than a label on a card.
   */
  reportsTo: string | null
  /**
   * The size this card goes back to when it is stepped down from a preset.
   *
   * The presets write real dimensions into the row, because the server places a card's webs from
   * that row and a card drawn at a size the server never heard about has its roots placed against
   * an edge it does not have. That leaves nowhere to put the size the owner had it at, hence this:
   * stamped when a card first leaves Normal, spent when it comes back.
   */
  baseWidth: number | null
  baseHeight: number | null
  /**
   * Three steps, not a free-for-all: its own size, a working size big enough to actually read a
   * terminal in, and the whole workspace. Double-click steps up, minimize steps back down.
   */
  size: 'normal' | 'large' | 'full'
  createdAt: number
  exitedAt: number | null
  exitCode: number | null
  /**
   * When the owner took this card off the board, or null while it is on it.
   *
   * Closing is not deleting. The row, its turns, its events, its wires and everything it wrote
   * under `~/.garden` stay exactly as they were; the card simply stops being drawn and moves to
   * the closed list, where it can be brought back or destroyed deliberately. Right-clicking a
   * card used to delete all of that outright, and to cascade into every child card as well, so
   * one menu press could take an agent's whole history with it.
   */
  closedAt: number | null
  /**
   * The role this card was actually launched with, or null when nothing is running.
   *
   * `roleClass` is the owner's current choice and can be changed at any moment. A running session
   * was told what it is once, at startup, and never re-reads that, so changing the role of a live
   * card moved the chip on the board while the agent inside carried on being what it was told. The
   * brief it holds says its identity outranks anything else it reads, so it will defend the old
   * role rather than quietly adopt the new one.
   *
   * Stamped at spawn and cleared on exit, so the card can say a choice has not taken effect yet
   * instead of asserting one that has not. Same shape as `modelChoice` against `model`.
   */
  roleClassRunning: string | null
  /**
   * The files and folders this card is responsible for, project-relative, or null for no limit.
   *
   * A role says what kind of card this is; it has never said which part of the repository is its
   * own. The owner's division is that a boss owns the repo, a manager owns an area and a worker
   * owns files, and without somewhere to put that, two workers on one job collide exactly the way
   * two sessions in one checkout do.
   *
   * Written into POWERS.md so the agent reads it as part of who it is, and compiled into its
   * settings file so the CLI refuses edits outside it. Reads are never restricted: a specialist
   * still has to understand the code around its own.
   */
  ownedPaths: string[] | null
  /**
   * How many times this card's process has been launched. Starts at 0 and never goes back.
   *
   * Every delayed automatic input Garden schedules carries the generation it was scheduled under,
   * and a timer whose generation is no longer the card's is dropped rather than typed. Without it
   * an Enter queued sixty milliseconds before a restart lands in the new process, which is a
   * keystroke nobody sent into a conversation nobody chose. Cancelling by timer handle cannot
   * cover it: the handles live in whichever code path scheduled them, and a restart is exactly the
   * moment that path is not looking.
   *
   * Worth having whether or not anything ever restarts a card for an update, which is why it is in
   * this stage rather than the one that acts.
   */
  generation: number
  /**
   * The CLI version this card's live process is actually running, from the CLI's own registry
   * entry for its pid. Null when nothing is running or the entry has not appeared yet.
   *
   * Never read from terminal text. The CLI draws "Update installed · Restart to update" in its
   * status line and that phrase also appears in quoted prose, tool results and this comment; a
   * card must never be restarted because a phrase matched. Derived on the way out rather than
   * stored, because a stored version is a claim about a process that may already be gone.
   */
  runningVersion?: string | null
  /** What the executable on disk reports, cached against its mtime. Null when it cannot be read. */
  installedVersion?: string | null
  /** True only when both versions are known and they differ. Unknown is never pending. */
  updatePending?: boolean
  /**
   * Whether an update restart could be performed for this card at all, which is a different
   * question from whether one is pending and from whether the moment is safe.
   *
   * False with a reason for a card Garden could not bring back where it left off: a Codex card,
   * which has no resume in Garden's adapter, or any card with no resumable conversation id.
   */
  updateEligible?: boolean
  /** Why not, in one sentence, or null when it is eligible. */
  updateReason?: string | null
}

/**
 * A markdown document pinned to the canvas as its own card. The canvas is a board of cards, not
 * a terminal grid: CLAUDE.md, AGENTS.md and canon docs belong next to the sessions that act on
 * them.
 */
export interface DocCard {
  id: string
  projectId: string
  /**
   * Project-relative for files inside the project. For `external` cards this is an absolute
   * path, and it is only ever set by the server from its own scan: the renderer cannot supply
   * one, so the path boundary still holds.
   */
  relPath: string
  /** True when the file lives outside the project, such as the user-level CLAUDE.md. */
  external: boolean
  /**
   * The card this one hangs off, when it belongs to another card's web. Folding that web away
   * removes exactly these, and nothing the owner opened by hand.
   */
  ownerId: string | null
  /** Which web it belongs to, so the two blips can be folded independently. */
  web: 'context' | 'history' | null
  /**
   * Images this turn actually opened, by absolute path.
   *
   * Only ever populated from a Read the CLI reported, so a turn that reviewed three screenshots
   * lists those three and a turn that reviewed none lists nothing. This is what turns "a review
   * command ran" into "here is what it looked at", which for a blind review is the only part that
   * settles anything.
   */
  images: string[]
  /**
   * Text is rendered and editable in place; an image is displayed. Decided by the server from
   * the file it resolved, never from anything the renderer said.
   */
  kind: 'text' | 'image'
  /** Same three steps as a session card: its own size, a working size, the whole workspace. */
  size: 'normal' | 'large' | 'full'
  /** Text size inside this card, in pixels, set with ctrl and the mouse wheel. */
  fontSize: number | null
  /**
   * Which column of the context web this card belongs to: instructions, settings, guards and so
   * on. Shown on the card, so a column says what it is without a separate header that could be
   * dragged away from the cards it labels.
   */
  group: string | null
  title: string
  x: number
  y: number
  width: number
  height: number
  collapsed: boolean
  manualPos: boolean
  createdAt: number
}

/**
 * A place for the owner and one card to talk, and nothing else.
 *
 * The problem it exists for, in his words: "currently orchestrator gets tied up in a lot of things
 * and its hard for me to found our back and forth". A card's terminal carries everything it does,
 * every tool call, every file it reads, every message from every wire, and the two sentences he
 * actually exchanged with it are somewhere in the middle of that. So this is a second, much smaller
 * surface that carries only those two sentences.
 *
 * Its own card type rather than a text card pointed at a file, at his word: "make it into its own
 * messaging card instead of as a txt card so that it stays separate". A text card belongs to the
 * roots web, has an owner and a column, and folds away with the rest; a channel is none of those
 * things and would have been a special case in every one of them.
 *
 * It is still a file underneath, `NOTES.md` in the bound card's own mail directory, because that is
 * what lets the card read and write it with the tools it already has. Nothing here is a new
 * transport: the owner appends by pressing Send, the card appends with its ordinary file writing,
 * and both are looking at the same bytes on disk.
 */
export interface Channel {
  id: string
  projectId: string
  /** The card this channel talks to, or null while it has been drawn but not yet wired. */
  sessionId: string | null
  /** Absolute path of the file both sides append to. Set by the server, never by the renderer. */
  path: string | null
  x: number
  y: number
  width: number
  height: number
  fontSize: number | null
  createdAt: number
}

/**
 * A connection drawn on the board.
 *
 * `manual` is a wire you drew. `derived` is one Garden created from a real event, such as a
 * parent dispatching a subagent, and is never invented. `blind` marks an agent deliberately
 * cut off from project context: a blind reviewer is wired to whoever called it and to nothing
 * else, because seeing the project is exactly what would stop it being blind. The kinds render
 * differently so a drawn line is never mistaken for an observed one, and so an isolated agent
 * is visibly isolated.
 */
export type WireKind = 'manual' | 'derived' | 'blind' | 'context' | 'history' | 'evidence'

export interface Wire {
  id: string
  projectId: string
  sourceId: string
  targetId: string
  label: string
  kind: WireKind
  /**
   * Drawn with an arrowhead at both ends.
   *
   * A spawn is not one-way traffic: the parent dispatches and the child reports back, and the
   * whole reason for keeping the card is that the answer comes home. One wire with two heads
   * rather than two overlapping wires, because two lines between the same pair of cards is a
   * picture of two connections when there is only one.
   */
  bidirectional: boolean
  createdAt: number
}

/** Who a config directory is signed in as. Null fields mean not signed in, never a guess. */
export interface AccountIdentity {
  email: string | null
  displayName: string | null
  organizationName: string | null
}

/**
 * Where every card on a board was sitting at one moment.
 *
 * Positions and nothing else. A layout that also remembered which processes were running would be
 * promising something a Windows process cannot deliver, and restoring it would put dead cards on
 * the board claiming to be alive. Restoring one moves cards; it never starts or stops anything.
 *
 * The automatic layout is written before every arrangement, one per project, always overwritten.
 * It is the way back from a button press, which is the thing that made the owner afraid to use the
 * arrangements at all.
 */
export interface SavedLayout {
  id: string
  projectId: string
  name: string
  automatic: boolean
  /**
   * Which of the four styles this layout grew out of, if any.
   *
   * A style is a starting point rather than an answer: the owner presses Tree, then nudges half a
   * dozen cards until it says what he means. Recording which button a saved layout came from lets
   * his edited version live under that button, so each style offers both the clean shape and his
   * own, and choosing one never destroys the other.
   */
  basedOn: string | null
  positions: Array<{ id: string; x: number; y: number }>
  savedAt: number
}

export interface AgentEvent {
  id: string
  sessionId: string
  ts: number
  type: string
  provenance: Provenance
  payload: unknown
}

/**
 * One line of a session's history: what was asked, who asked, and what came of it.
 *
 * Every field comes from a hook payload or a transcript file. `origin` says whether the owner
 * typed this or another agent dispatched it, which was the specific thing he could not tell
 * before: a card that did work never said whose idea the work was.
 */
export interface WorkRecord {
  id: string
  sessionId: string
  /** The CLI's own prompt_id, which ties every event from one turn together. */
  promptId: string | null
  origin: 'owner' | 'agent'
  /** The card that dispatched this, when origin is agent. */
  parentId: string | null
  ask: string
  startedAt: number
  endedAt: number | null
  /** Files written during this turn, from PostToolUse on Write/Edit. Structured, never guessed. */
  filesTouched: string[]
  /**
   * Tasks that reached a terminal state while this turn was open.
   *
   * The other half of what a turn can have done, and the half history had no way to see. A card
   * that spent a turn checking somebody's work, answered, and moved `T-12` to done wrote no file,
   * so `filesTouched` was empty and the turn left no trace at all.
   *
   * Written only from the server's own task transition, the one that follows a delivered `done` or
   * `confirm`, never from an agent saying it had finished something. That is the same grade of fact
   * as `filesTouched`: a row in the task table with a time on it, checkable afterwards by anything
   * that can read the database. Empty on nearly every turn, and empty on every row written before
   * this field existed.
   */
  tasksCompleted: string[]
  toolCalls: number
}

// ---------------------------------------------------------------------------
// Task ownership
// ---------------------------------------------------------------------------

/**
 * Where a task is in its life, which is a row on this board rather than a word in a message.
 *
 * `unbound` is the legacy state and the only one with no owner. Every task id Garden has ever seen
 * in its mail history starts here, and nothing moves a task out of it except a deliberate `bind`.
 * The owner's instruction, in his words: do not silently invent owners for historical work. A task
 * whose owner was guessed from whoever happened to send the mail would be accountability that reads
 * exactly like the real thing and is not.
 *
 * `paused` is where a task goes when Garden cannot tell who should hold it: a split that named no
 * owner for a piece, a bind naming a card that is closed. A state rather than an error, so the task
 * stays on the board with the reason attached instead of vanishing into a log line.
 */
export type TaskState =
  | 'unbound'
  | 'assigned'
  | 'working'
  | 'in_review'
  | 'remediating'
  | 'done'
  | 'confirmed'
  | 'closed'
  | 'paused'

/**
 * How hard the ownership rules bite, per project.
 *
 * `shadow` evaluates every rule and records every refusal as a `TaskWouldRefuse` event, then
 * delivers the message anyway, so the owner can watch what would have been stopped before anything
 * is. `enforce` refuses. `off` evaluates nothing and records nothing, which is where a board should
 * be only while something is broken.
 */
export type TaskAuthority = 'off' | 'shadow' | 'enforce'

/**
 * Why a task changed hands, as a closed list.
 *
 * There is no `convenience`, no `faster` and no `available`, and their absence is the point: the
 * owner's requirement is that work returns to the card that built it, and a reassignment for speed
 * cannot be expressed here rather than being asked against. Garden checks the evidence for each of
 * these itself before it writes the row, so the reason is a claim it verified and not a label the
 * dispatcher chose.
 */
export type ReassignReason =
  | 'owner_stopped'
  | 'owner_silent'
  | 'missing_capability'
  | 'missing_territory'
  | 'blocked_elsewhere'
  | 'legacy_bind'

/**
 * One task, keyed by `(projectId, id)` so the ids already in use keep working.
 *
 * `acceptance` and `acceptanceRef` are both here on purpose. Text is what a small task carries;
 * a reference is a project-relative path plus the SHA-256 of its content at the moment of
 * assignment, so that a work order cannot be edited under the work and then be judged against its
 * new self. A task may carry either or both.
 */
export interface TaskContract {
  id: string
  projectId: string
  /** The accountable card. Null only while the task is `unbound`. */
  ownerId: string | null
  /** The card that created or bound it. Null only while the task is `unbound`. */
  assignerId: string | null
  /** A role the owner must have, or null for any. Checked on reassignment. */
  requiredRole: RoleClass | null
  /** Project-relative paths this work may write, or `[]` for none declared. */
  territory: string[]
  acceptance: string | null
  acceptanceRef: { path: string; sha256: string } | null
  /** The independent verifier, or null when none is required. Never the owner or the assigner. */
  verifierId: string | null
  parentId: string | null
  state: TaskState
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

/**
 * One change of hands, append-only.
 *
 * The current owner is on the task row; how it got there is here. The former owner, the
 * replacement, the checked reason, the note, the authorising card and the time are all on the row,
 * so a task that has moved three times can be read back rather than reconstructed.
 */
export interface TaskReassignment {
  id: string
  taskId: string
  projectId: string
  fromOwnerId: string | null
  toOwnerId: string
  reason: ReassignReason
  note: string
  /**
   * What Garden itself found true when it allowed the move, as opposed to `note`, which is the
   * dispatcher's own prose.
   *
   * Empty for most hand-offs, because most reasons are true in the ordinary way and the reason token
   * says all there is to say. It carries a sentence when the fact Garden allowed on is not visible
   * from the row months later: an owner card that had left the board entirely, so that a reader
   * cannot tell whether the reason was checked or waved through.
   *
   * Optional so a page talking to a server older than this field draws nothing rather than an empty
   * claim.
   */
  evidence?: string
  byId: string | null
  ts: number
}

/** What `task.create` needs. Refused naming the field when any of the required parts is missing. */
export interface TaskCreateInput {
  id: string
  ownerId: string
  /**
   * The card that hands the work out, and that `done` comes back to.
   *
   * Optional because a card creating a task is the assigner, so the server fills it in. Required in
   * practice from the board, where there is no acting card and the owner names one: a task with no
   * assigner has nobody to report to and nobody to confirm it, and `confirm` is the step that stops
   * work travelling up unread.
   */
  assignerId?: string
  requiredRole?: RoleClass | null
  territory?: string[]
  acceptance?: string | null
  /** A project-relative path. The server reads the file and stores its SHA-256 beside it. */
  acceptanceRef?: { path: string } | null
  verifierId?: string | null
  parentId?: string | null
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

/** Renderer to server. Every field is validated server-side before anything is spawned. */
export type ClientMessage =
  /**
   * Who is on the other end of this socket, said once at the start.
   *
   * It used to carry nothing, and a connection with nothing was treated as the owner. The socket is
   * loopback with no token, so any card with Bash could open one and be the owner: `session.create`
   * and `session.start` read a message with no `by` field as coming from him. That is the third of
   * the four holes canon 20 records.
   *
   * `key` is the owner's, written once to `~/.garden/owner.key` and handed to the page in the URL
   * the server prints at start. `token` is a card's `GARDEN_SESSION_TOKEN`, and a connection
   * carrying one is checked as that card for everything it sends afterwards. Neither makes it a
   * guest, which may read the board and change nothing.
   */
  | { t: 'hello'; key?: string; token?: string }
  /**
   * Nothing but proof the socket is alive.
   *
   * The server answers every one of these with a `pulse`, and the client closes a socket that has
   * gone quiet for too long. A protocol-level WebSocket ping would be cheaper, but the browser
   * answers those below JavaScript and never tells the page a pong arrived, so a page cannot use
   * them to tell a live socket from a half-open one. This can be seen at both ends.
   */
  | { t: 'pulse' }
  | { t: 'project.add'; path: string; name?: string }
  /** Opens the OS folder dialog on the server, then adds whatever was chosen. */
  | { t: 'project.pick' }
  | { t: 'project.remove'; projectId: string }
  | { t: 'project.open'; projectId: string }
  | { t: 'project.setProfile'; projectId: string; adapterId: AdapterId; profileId: string | null }
  | { t: 'profile.create'; name: string; adapterId: AdapterId }
  | { t: 'profile.delete'; profileId: string }
  | { t: 'profile.refresh' }
  /**
   * Make a card, with what it is for decided up front.
   *
   * The role has to travel with the creation rather than arriving in a second message. The CLI
   * reads its permissions once, at launch, so a card created and then given a role ran its entire
   * first session with none of that role's denials, and nothing said so. A manager made that way
   * could edit files until it was next turned off and on.
   */
  | {
      t: 'session.create'
      projectId: string
      adapterId: AdapterId
      profileId?: string | null
      title?: string
      roleClass?: RoleClass | null
      reportsTo?: string | null
      modelChoice?: string | null
      effortChoice?: string | null
      teamSize?: number | null
      /**
       * The files and folders this card is responsible for, project-relative.
       *
       * Omitted or empty means no limit, which is how every card behaved before this existed.
       */
      ownedPaths?: string[] | null
      /**
       * What this card is for, written by whoever is making it.
       *
       * A card no longer inherits the project's instructions or the user's, so this is the whole of
       * what it knows about its own job. It is stored below the marker in the card's own
       * `CLAUDE.md` and handed to the session at startup by the hook.
       *
       * It was previously reachable only through `POST /hire`, so an agent could give a card a brief
       * and the owner making a card by hand could not, which left his own cards as the only ones on
       * the board with nothing written for them.
       */
      roots?: string
      /** False to lay a card out without spending anything on it yet. */
      start?: boolean
      /**
       * The card that asked for this one, when it was not the owner's own hands.
       *
       * Set by the hiring endpoint from `GARDEN_SESSION_ID` and never read off a request body, so
       * an agent cannot present itself as a card it is not. Absent means the renderer, which is the
       * owner, and the owner is above the funnel. Present has to name a live card whose role may
       * create, or the create is refused.
       *
       * Stated rather than pretended away: an agent that deliberately overwrote its own
       * `GARDEN_SESSION_ID` could put another card's id here. What that buys is nothing, because the
       * ceiling is checked before this is, and it applies to every path including the owner's. A
       * forged id changes who is blamed for a card, not whether the board has room for it.
       */
      by?: string | null
      /**
       * Where to put it, in board coordinates.
       *
       * Sent when the card was made from a right-click, so it lands where he was pointing rather
       * than wherever the automatic placement finds room. Omitted, the usual placement applies.
       */
      x?: number
      y?: number
    }
  | { t: 'session.input'; sessionId: string; data: string }
  | { t: 'session.resize'; sessionId: string; cols: number; rows: number }
  /** Turn off: ends the process, keeps the card and its history on the board. */
  | { t: 'session.stop'; sessionId: string }
  /** Turn on: starts the process again for an existing card. */
  | { t: 'session.start'; sessionId: string }
  /**
   * Take a card off the board without destroying anything.
   *
   * Its process ends and its roots and history fold away, but the row, its notes, its mailbox, its
   * wires and its conversation all stay exactly as they were. It moves to the closed list, where it
   * can be brought back or deleted deliberately. This is what the delete button on a card should
   * have been doing all along: one press used to take an agent's whole history with it, and to
   * cascade into every card it had hired.
   */
  /**
   * Ask for a spawned agent's conversation, so its card can show what was actually said.
   *
   * A subagent card has no terminal and never will, because it is not a process Garden started.
   * Its transcript is on disk the whole time though, so the card reads that rather than showing
   * three lines of facts about a run nobody can see into.
   */
  | { t: 'agent.chat'; sessionId: string }
  /**
   * Send a line to a spawned agent, through the terminal of the card that hired it.
   *
   * A subagent has no process of its own, so this is the only route there is, and it can fail for
   * ordinary reasons: the agent finished, the parent is off, two agents look identical on screen.
   * The answer says which, because a card that quietly did nothing is worse than one that says so.
   */
  | { t: 'agent.say'; sessionId: string; text: string }
  | { t: 'session.close'; sessionId: string }
  /** Put a closed card back on the board, stopped, exactly where it was. */
  | { t: 'session.restore'; sessionId: string }
  /** The only thing that removes a card. Reachable from the closed list, which confirms first. */
  | { t: 'session.delete'; sessionId: string }
  | { t: 'session.rename'; sessionId: string; title: string }
  | { t: 'session.move'; sessionId: string; x: number; y: number }
  | { t: 'session.setRenderState'; sessionId: string; renderState: NodeRenderState }
  | { t: 'session.setPinned'; sessionId: string; pinned: boolean }
  | { t: 'session.setCollapsed'; sessionId: string; collapsed: boolean }
  | { t: 'session.setColor'; sessionId: string; color: string | null }
  /**
   * Set what a card is for and what it is allowed to do.
   *
   * Takes effect on the next start, because the CLI reads its permissions once at launch. The
   * card says so rather than pretending a running session changed.
   */
  | {
      t: 'session.setRole'
      sessionId: string
      roleClass?: RoleClass | null
      canSpawnAgents?: boolean
      canUseTeams?: boolean
      /**
       * This card's own answer about subagents. Null is not "no": it is the card withdrawing its
       * answer and following the board again, which is why this field has to be sent explicitly to
       * mean anything and an absent field changes nothing.
       */
      subagentsAllowed?: boolean | null
      teamSize?: number | null
      modelChoice?: string | null
      effortChoice?: string | null
      /** Null means it answers to the owner. Anything else must be another card in this project. */
      reportsTo?: string | null
    }
  /**
   * Change a running session's model or effort by typing the CLI's own slash command into it.
   *
   * The settings file is read once at launch, so it cannot reach a session that is already
   * running. The CLI does expose `/model` and `/effort` for exactly this, and Garden owns the
   * terminal, so it types the line rather than pretending the setting took effect.
   */
  | { t: 'session.applyNow'; sessionId: string; what: 'model' | 'effort' }
  /**
   * Step a card between its size presets.
   *
   * `width` and `height` are how the canvas tells the server what a preset it works out for itself
   * actually came to. Full means "as big as the viewport allows", which only the browser knows, and
   * while the server never heard the answer it kept placing that card's roots against the bottom
   * edge of the much smaller box it had on file, putting the block underneath the card.
   */
  | {
      t: 'session.setSize'
      sessionId: string
      size: 'normal' | 'large' | 'full'
      width?: number
      height?: number
    }
  /** Exact pixel size, from dragging a card's edge or corner. */
  | { t: 'session.setBox'; sessionId: string; width: number; height: number }
  | { t: 'session.setFontSize'; sessionId: string; fontSize: number | null }
  /** Terminal or conversation, per card. Stored, so it survives a reload and reaches other windows. */
  | { t: 'session.setBodyView'; sessionId: string; bodyView: 'terminal' | 'chat' }
  | { t: 'session.scrollback'; sessionId: string }
  | { t: 'doc.list'; projectId: string }
  | { t: 'doc.open'; projectId: string; relPath: string }
  /** Create a new empty file in the project and open it as a card. */
  /**
   * A new file, and a card for it.
   *
   * `x` and `y` are where the owner was pointing when he asked, in board coordinates, and they are
   * optional for the same reason they are on `session.create`. The server hard-coded the origin
   * before this existed, so every file card was made at 0,0 and, on any board where a single card
   * had ever been dragged, auto-packing was off and they piled up on top of each other there.
   */
  | { t: 'doc.create'; projectId: string; relPath: string; x?: number; y?: number }
  /** A message card, drawn empty. It binds to a card when a wire is drawn between the two. */
  | { t: 'channel.create'; projectId: string; x?: number; y?: number }
  /**
   * One thing the owner wants said, appended to the file and then announced to the card.
   *
   * Pressing Send is the whole trigger, at his choice: a nudge on every save would reach the card
   * with half a sentence in it, and a channel the card only reads when it happens to restart is a
   * noticeboard rather than a conversation. So the append and the wake are one action.
   */
  | { t: 'channel.send'; channelId: string; text: string }
  | { t: 'channel.read'; channelId: string }
  /**
   * Which days this card has a history for, without putting any of it on the board.
   *
   * Opening history used to lay out every turn a card had ever taken, which on the orchestrator is
   * dozens of cards arriving at once. It is the same complaint the roots had, and his words for that
   * one were "makes it too laggy the way it is right now". So the arrow asks for this instead, and a
   * day's turns arrive only when he opens that day.
   *
   * By day rather than by task because a turn has no task on it. A work record carries who asked,
   * what was asked, when it started and what it touched, and nothing that names a piece of work
   * across several turns. A day is the honest grouping available, and for a card that has been
   * running for a week it is also the useful one.
   */
  | { t: 'history.groups'; sessionId: string }
  /**
   * Stop this server and start it again, keeping the board.
   *
   * Asked for because a server change is not live until the backend restarts, and the owner had no
   * way to do that from the app: closing a board is not it, and neither is reloading the page. His
   * question was exactly that, "does closing board and re-opening count as a reset", and the answer
   * is no, twice over. Closing a board kills every process in it AND leaves the same server running,
   * so it costs the sessions and changes nothing about the code.
   *
   * Every card goes down with the server, because a Windows process cannot be re-parented into a new
   * instance. What comes back up is a new process resuming the same conversation, which `revive`
   * already does on every boot.
   */
  | { t: 'server.restart' }
  /**
   * The whole file, as the owner edited it on the card.
   *
   * Separate from `channel.send`, and the difference is the point. Sending adds what he wants to say
   * and tells the card to go and read it. Saving is him editing the record itself: fixing a line,
   * cutting something, writing a note he does not want to interrupt the card for. So this one writes
   * and does not wake anybody.
   *
   * `baseMtime` is what the card had when he started typing. A card is not the only thing that can
   * write this file, so an edit that began before the card appended to it would otherwise throw the
   * card's reply away without either of them noticing.
   */
  | { t: 'channel.save'; channelId: string; text: string; baseMtime?: number }
  | { t: 'channel.move'; channelId: string; x: number; y: number }
  | { t: 'channel.setBox'; channelId: string; width: number; height: number }
  | { t: 'channel.setFontSize'; channelId: string; fontSize: number | null }
  | { t: 'channel.delete'; channelId: string }
  | { t: 'doc.read'; cardId: string }
  | { t: 'doc.save'; cardId: string; content: string; baseMtime?: number }
  | { t: 'doc.close'; cardId: string }
  | { t: 'doc.move'; cardId: string; x: number; y: number }
  | { t: 'doc.setCollapsed'; cardId: string; collapsed: boolean }
  | { t: 'doc.setSize'; cardId: string; size: 'normal' | 'large' | 'full' }
  | { t: 'doc.setBox'; cardId: string; width: number; height: number }
  | { t: 'doc.setFontSize'; cardId: string; fontSize: number | null }
  /** Attach a loose document card to a session: wires it and moves it under that card. */
  | { t: 'doc.attach'; cardId: string; sessionId: string }
  | { t: 'doc.detach'; cardId: string }
  /** Clears every manual position in a project so the packer lays the board out again. */
  | { t: 'board.tidy'; projectId: string }
  /**
   * Where the client actually drew each card after auto-packing. Stored so the server places
   * new cards and webs against the real board rather than stale coordinates, without marking
   * anything as hand-positioned.
   */
  | { t: 'board.layout'; positions: Array<{ id: string; x: number; y: number }> }
  /**
   * Put the whole board where an arrangement says, in one go.
   *
   * Separate from `session.move` because moving cards one at a time is not the same operation.
   * Each single move is nudged clear of the cards that have not moved yet, so applying a layout
   * card by card measured every card against a half-old board and scrambled the shape it was
   * supposed to produce. An arrangement already computes a lattice where nothing overlaps, so it
   * is taken as given and applied whole.
   */
  | { t: 'board.arrange'; positions: Array<{ id: string; x: number; y: number }> }
  /** Save where every card is now, under a name you choose. Positions only. */
  | { t: 'layout.save'; projectId: string; name: string; basedOn?: string | null }
  /** Put every card back where a saved layout had it. Starts and stops nothing. */
  | { t: 'layout.restore'; layoutId: string }
  | { t: 'layout.delete'; layoutId: string }
  | { t: 'layout.list'; projectId: string }
  /**
   * Draw a connection the owner wants that no spawn created.
   *
   * Two-way unless it says otherwise, because a wire drawn by hand is the owner saying these two
   * should talk, and a line that silently refuses the reply is a line that looks connected and is
   * not. Every wire Garden draws for the chain itself is two-way for the same reason. One-way is
   * still a real thing to want, and the arrowhead says which it is either way.
   */
  | {
      t: 'wire.create'
      projectId: string
      sourceId: string
      targetId: string
      label?: string
      kind?: WireKind
      bidirectional?: boolean
    }
  | { t: 'wire.setKind'; wireId: string; kind: WireKind }
  /**
   * Which way a connection is allowed to carry work.
   *
   * A one-way wire says the arrow's direction is the only direction: a coder hands to a reviewer
   * and the reviewer reports to the lead, while the coder never speaks to the lead at all. Two-way
   * says both ends may start something. The arrowheads are the whole statement, so a wire with one
   * head means exactly one head's worth of permission.
   */
  | { t: 'wire.setDirection'; wireId: string; bidirectional: boolean }
  /** Unfold the web of files a session runs from, below its bottom connection point. */
  | {
      t: 'context.open'
      sessionId: string
      group?: 'instructions' | 'memory' | 'research' | 'settings' | 'skills' | 'agents' | 'hooks' | 'guards'
      /** Open only these, by their display path. Used by the grouped picker. */
      only?: string[]
      /**
       * Where this column's rows go, in board coordinates.
       *
       * The roots draw as a table: a row of equal-width pills under the card, one per column, and a
       * column's files open as rows directly beneath its own pill. So the client, which laid the
       * pills out, says where the rows belong. Without it the server centres the block under the card
       * and packs it, which is right for a whole web opening at once and wrong for one column: "i
       * want each column to open rows under their singular column".
       *
       * Advisory. The server still makes room and still moves other cards out of the way.
       */
      at?: { x: number; y: number }
    }
  /** What a session runs from, as a list to choose from rather than 68 cards at once. */
  | { t: 'context.list'; sessionId: string }
  /**
   * Fold the roots away. With a group, fold only that column back to its pill.
   *
   * Opening a column and having no way to shut it again is half a control. The dot still closes
   * everything, which is what it always did.
   */
  | { t: 'context.close'; sessionId: string; group?: string }
  /**
   * Close a tab: stop everything running in it and take it off the row, keeping the board.
   *
   * Not a delete. The cards, the wires and where he put them all stay exactly as they were, because
   * what he asked for was a way to put a project down and pick it up later. Reopening it brings the
   * whole layout back with its sessions stopped, which is the honest state: a Windows process does
   * not survive being closed and nothing here pretends it did.
   */
  | { t: 'project.close'; projectId: string }
  | { t: 'project.reopen'; projectId: string }
  /** The tabs he has closed, so one can be picked back up without hunting for the folder. */
  | { t: 'project.listClosed' }
  /**
   * Write this board into Garden's own directory, so it can be opened again from inside the app.
   *
   * Cards, where they are, what each is for, and every wire between them. Not what was running:
   * opening a saved board puts stopped cards on the screen, because that is what they are.
   */
  /**
   * How large this board may get, read and changed while it is running.
   *
   * A message rather than a constant because the owner changes it mid-task: a quiet afternoon on
   * one feature and a full department are different numbers, and stopping the app to edit a source
   * file is not a thing anybody does in the middle of work.
   *
   * Lowering a figure below what is already on the board is allowed and does nothing retroactive.
   * Cards that exist keep existing and the next create is refused. A limit that silently killed
   * running sessions would be worse than no limit at all.
   */
  | { t: 'limits.get'; projectId: string }
  | { t: 'limits.set'; projectId: string; limits: BoardLimits }
  /**
   * Ask whether this card could be restarted right now, and nothing more.
   *
   * A read. It answers and never acts: no card is ended, started or restarted by this message or
   * by anything it calls. The stage that acts is ordered separately, and when it exists this is
   * the question it will have to ask first.
   */
  | { t: 'update.boundary'; sessionId: string }
  /**
   * Write this card's checkpoint now, and say where it went.
   *
   * Also a read of the card, in the sense that it changes nothing about the process: it writes the
   * file canon 21 describes and hands back the path. Nothing calls it automatically. It is here so
   * the writer can be exercised, and so the owner can look at what a checkpoint would say before
   * anything is ever restarted on the strength of one.
   */
  | { t: 'update.checkpoint'; sessionId: string }
  | { t: 'board.save'; projectId: string; name?: string }
  | { t: 'board.list' }
  | { t: 'board.open'; file: string }
  | { t: 'board.delete'; file: string }
  /**
   * Move a whole web by hand, by the distance it was dragged.
   *
   * The owner asked for this because automatic placement can be wrong, and when it is he needs a
   * way to put the block where it belongs rather than waiting for the placement to be fixed. By
   * distance rather than to a position: a frame is drawn from wherever its cards are and has no
   * stored coordinate of its own.
   */
  | { t: 'web.move'; sessionId: string; web: 'context' | 'history'; dx: number; dy: number }
  /** Unfold the session's work history above it. */
  /**
   * Put one day of this card's history on the board.
   *
   * `group` is the day, as the server keyed it. Without one this opens nothing and answers with the
   * days available, which is what the arrow on the card does now: a card that has been working for a
   * week has dozens of turns, and dropping all of them on the board at once is the same fault the
   * roots had before they became columns.
   */
  | { t: 'history.open'; sessionId: string; group?: string }
  /** Fold one day back to its pill, leaving the rest of the history where it is. */
  | { t: 'history.closeGroup'; sessionId: string; group: string }
  | { t: 'history.close'; sessionId: string }
  /** Unfold the pictures a turn reviewed, to the right of that turn's card. */
  | { t: 'evidence.open'; cardId: string }
  | { t: 'evidence.close'; cardId: string }
  | { t: 'work.list'; sessionId: string }
  /** What this session's runs actually reached, stage by stage, from its own recorded events. */
  | { t: 'pipeline.get'; sessionId: string }
  /**
   * Open an agent's own transcript as a card.
   *
   * The transcripts have always existed on disk and rotate away after thirty days. This is the
   * one action that turns a subagent from something that happened into something readable.
   */
  | { t: 'transcript.open'; sessionId: string }
  /**
   * Post a message into the target session's mailbox and light the wire.
   *
   * Deliberately not typed into the other terminal. A wire that could inject text would be a way
   * for one agent to take over another mid-turn, and an agent reading its own mailbox when it
   * chooses to is both safer and closer to how the owner already works.
   */
  | { t: 'wire.send'; wireId: string; text: string }
  | { t: 'wire.label'; wireId: string; label: string }
  | { t: 'wire.delete'; wireId: string }
  /**
   * The task plane, as the twin of `POST /task`.
   *
   * Every one of these runs the same function its HTTP twin runs, including the dispatcher check.
   * Two implementations of "may this card reassign a task" is how a limit ends up holding on one
   * door and not the other, which is exactly what happened to "only the orchestrator creates
   * cards": it held on `/hire` and not on `session.create`.
   */
  | { t: 'task.list'; projectId: string }
  | { t: 'task.create'; projectId: string; task: TaskCreateInput }
  /** Give an owner to a task that has never had one. The only path out of `unbound`. */
  | { t: 'task.bind'; projectId: string; taskId: string; ownerId: string; assignerId: string; note: string }
  | {
      t: 'task.reassign'
      projectId: string
      taskId: string
      toOwnerId: string
      reason: ReassignReason
      note: string
      /**
       * The task this one is waiting on, for `blocked_elsewhere` and for nothing else.
       *
       * A field rather than something read out of `note`, because the note is prose: Garden used to
       * scan it for anything task-id shaped, which passed a note saying a dependency was finished
       * and refused one that named the dependency in a shape the pattern did not cut.
       */
      blockedBy?: string | null
    }
  /**
   * Break a task into subtasks with an owner each.
   *
   * This is what a verifier does instead of sending one remediation to whichever card is awake: a
   * fault outside the owner's territory is refused with the instruction to split, and each owner
   * then receives only its own.
   */
  | {
      t: 'task.split'
      projectId: string
      taskId: string
      into: Array<{ id: string; ownerId: string | null; territory?: string[] }>
    }
  | { t: 'task.verifier'; projectId: string; taskId: string; verifierId: string | null }
  /**
   * The card's own secret, so the board can show it and a shim can be handed one.
   *
   * Owner connections only, and never persisted: the server keeps `sha256(token) -> sessionId` in
   * memory for as long as the card runs and forgets it when the card stops.
   */
  | { t: 'session.token'; sessionId: string }

/** Server to renderer. */
export type ServerMessage =
  /** The answer to a `pulse`. Carries nothing: arriving at all is the entire message. */
  | { t: 'pulse' }
  | {
      t: 'state'
      projects: Project[]
      profiles: Profile[]
      sessions: TerminalSession[]
      docs: DocCard[]
      channels: Channel[]
      wires: Wire[]
      /** The account the unmanaged config dir is signed in as, so a tab can name it. */
      defaultAccount: AccountIdentity | null
      /**
       * Which build the SERVER is, which is not always the build the page is.
       *
       * The two halves are separate processes. The backend can be restarted on its own from the
       * header, and the page reloads on its own, so they drift apart and the result looks like a fix
       * that did not land rather than like two versions running at once. The page carries its own
       * version from its own package.json and compares it against this one.
       */
      build: { version: string; commit: string; startedAt: number }
      /**
       * Every task on every project, and how each one got its owner, at load.
       *
       * Carried in the full state rather than fetched per project because the board draws task
       * state on the face of a card, and a card is drawn before anything asks about its project.
       */
      tasks: TaskContract[]
      reassignments: TaskReassignment[]
      /**
       * What ownership stopped, or would have stopped in shadow.
       *
       * These are events on the sending card, and the client throws `event` messages away, so a
       * broadcast alone is gone the moment the page reloads. In shadow the whole point is that the
       * owner reads a list of what would have been refused before he turns enforcement on, and a
       * list that empties itself on refresh is not that. Newest first, capped.
       */
      refusals: AgentEvent[]
    }
  | { t: 'wire.added'; wire: Wire }
  | { t: 'wire.updated'; wire: Wire }
  | { t: 'wire.removed'; wireId: string }
  | { t: 'channel.added'; channel: Channel }
  | { t: 'channel.updated'; channel: Channel }
  | { t: 'channel.removed'; channelId: string }
  /**
   * What is in the channel's file right now.
   *
   * Sent whole rather than as a diff, and pushed when the file changes rather than polled. A channel
   * holds a handful of exchanges, so the whole of it is small, and sending the whole of it means the
   * board can never drift from the file: there is one copy of the conversation and it is on disk.
   */
  | { t: 'channel.text'; channelId: string; text: string; at: number }
  /**
   * Whether a save reached disk, addressed to the card that asked.
   *
   * Carries its failures rather than leaving them to a generic error frame, for the reason the doc
   * card's own handler records: a card resolves its save state by id, and a frame with no id cannot
   * reach it, so the failure badge existed there for a long time and was never once drawn. The same
   * mistake was available here and is not being made twice.
   */
  | { t: 'channel.saved'; channelId: string; at: number; error?: string }
  | { t: 'doc.list'; projectId: string; files: string[] }
  | { t: 'doc.added'; card: DocCard }
  | { t: 'doc.updated'; card: DocCard }
  | { t: 'doc.removed'; cardId: string }
  | { t: 'doc.content'; cardId: string; content: string; mtime?: number; error?: string }
  | {
      t: 'context.list'
      sessionId: string
      entries: Array<{ group: string; title: string; display: string; usage: string; open: boolean }>
    }
  /** Answer to a save. `error` means the file was NOT written. */
  | { t: 'doc.saved'; cardId: string; mtime: number; error?: string }
  | { t: 'project.added'; project: Project }
  | { t: 'project.updated'; project: Project }
  | { t: 'project.picked'; path: string | null }
  | { t: 'profiles'; profiles: Profile[]; defaultAccount: AccountIdentity | null }
  | { t: 'project.removed'; projectId: string }
  | { t: 'session.added'; session: TerminalSession }
  | { t: 'session.updated'; session: TerminalSession }
  | { t: 'session.removed'; sessionId: string }
  /** `seq` is the cumulative byte count for this session including this chunk. */
  | { t: 'session.data'; sessionId: string; data: string; seq: number }
  /** Snapshot of scrollback plus the `seq` it was taken at, so a late-attaching terminal can
   *  discard live chunks it already received inside the snapshot. */
  /**
   * `cols` and `rows` are the grid this stream was drawn against, and they are not decoration.
   *
   * Anything replaying these bytes has to interpret them at the same size the process was told it
   * had, because a terminal stream is drawing instructions rather than text: wrap at this column,
   * move up three rows, rewrite. Replayed at a different width the wraps land elsewhere, so a
   * cursor move arrives on the wrong line and overwrites something it was never meant to touch.
   * The card preview did exactly this, interpreting at 200 by 48 what was drawn for 120 by 30,
   * which put the right words on a card in the wrong order while the dock terminal was correct.
   */
  | { t: 'session.scrollback'; sessionId: string; data: string; seq: number; cols: number; rows: number }
  | { t: 'event'; event: AgentEvent }
  /**
   * A wire carried something just now. Transient and never stored: a wire only ever lights for an
   * event that actually fired, so there is nothing to replay on reconnect.
   */
  | { t: 'wire.pulse'; wireId: string; kind: WireKind }
  | { t: 'work'; sessionId: string; records: WorkRecord[] }
  /**
   * The days this card has a history for, and how many turns each holds.
   *
   * Sent in answer to `history.groups` and again whenever a day is opened or folded, so the pills on
   * the board always come from the server's own count rather than from whatever cards happen to be
   * drawn. `open` says which days have their turns on the board right now.
   */
  | {
      t: 'history.groups'
      sessionId: string
      groups: Array<{ group: string; label: string; count: number; latest: number }>
      open: string[]
    }
  /**
   * A spawned agent's conversation, read from its own transcript.
   *
   * `asked` is what it was given, `said` is what it answered, `did` is one line per tool call so a
   * run that mostly edited files still reads as work rather than as silence. Empty means nothing is
   * on disk yet, which is a real state for an agent that has only just started, and the card says
   * so rather than pretending the run was empty.
   */
  | {
      t: 'agent.chat'
      sessionId: string
      /** `full` is present only on a turn whose `text` is a shortened version of it. */
      turns: Array<{ role: 'asked' | 'said' | 'did'; text: string; at: number | null; full?: string }>
    }
  /** What happened to a line sent to a spawned agent. `reason` is present only when it did not go. */
  | { t: 'agent.said'; sessionId: string; ok: boolean; reason?: string }
  | { t: 'layouts'; projectId: string; layouts: SavedLayout[] }
  /** Tabs that are closed but kept, newest first. */
  | { t: 'projects.closed'; projects: Project[] }
  /** Boards saved into the Garden directory, newest first. */
  | {
      t: 'boards'
      boards: Array<{
        file: string
        name: string
        projectId: string
        projectPath: string
        savedAt: number
        cards: number
      }>
    }
  /**
   * One entry per turn, each carrying its stages.
   *
   * Deliberately not typed tightly here: the stage table lives in the server and will grow, and
   * pinning its shape in the contract would mean editing three files to add a stage. What the
   * renderer relies on is that every stage carries a state and a provenance, which it must draw
   * differently, and a reason it can show when a stage is not reached.
   */
  | { t: 'pipeline'; sessionId: string; runs: unknown[] }
  /**
   * The ceiling and what is currently counted against it, sent on request and after every change.
   *
   * The counts travel with the limits so the board can say "four of twelve" rather than making the
   * owner count cards himself, and so a refusal he reads names the same figures the control shows.
   *
   * `counted.subagents` is how many subagent records this project holds, and it is not counted
   * against `limits.subagents`. They are different questions: the limit is how many one card may run
   * at once, the count is how many the whole board has ever been told about. The panel draws no
   * "n of m" for that row for exactly this reason, since the two numbers do not divide.
   */
  | {
      t: 'limits'
      projectId: string
      limits: BoardLimits
      counted: { cards: number; running: number; subagents: number }
    }
  /** The answer to `update.boundary`, for one card. */
  | { t: 'update.boundary'; sessionId: string; result: BoundaryResult }
  /** The answer to `update.checkpoint`: where it was written, and what it says. */
  | { t: 'update.checkpoint'; sessionId: string; path: string; fields: string[] }
  /**
   * The answer to `hello`, saying which of the three things this connection turned out to be.
   *
   * Sent whatever the answer is, including `guest`, because a page that is silently read-only is a
   * page whose every write vanishes with no explanation. The identity is what every later message
   * on this socket is checked as.
   */
  | { t: 'hello.ok'; identity: 'owner' | 'guest' | { cardId: string } }
  /** One project's tasks, its reassignment history, and its refusals. The answer to `task.list`. */
  | {
      t: 'task.state'
      projectId: string
      tasks: TaskContract[]
      reassignments: TaskReassignment[]
      refusals: AgentEvent[]
    }
  /** One task changed: created, bound, reassigned, split, or moved by a piece of mail. */
  | { t: 'task.updated'; task: TaskContract }
  /** One new row in the append-only history. Broadcast beside the `task.updated` it explains. */
  | { t: 'task.reassigned'; row: TaskReassignment }
  /** A card's own secret, answered to owner connections only and never persisted anywhere. */
  | { t: 'session.token'; sessionId: string; token: string }
  | { t: 'error'; message: string; forT?: string }

/**
 * What each role may reach for, in one table that everything else reads.
 *
 * The chain the owner described is orchestrator hires boss, boss hires managers, managers hire
 * specialists, specialists do the work. Each rung keeps exactly the tools its job needs and loses
 * the ones that would let it quietly do the rung below's job instead, which is the behaviour he
 * actually complained about: a card that can do the work will do the work, and the team never runs.
 *
 * Bash is the entry that matters most and the one that was wrong. A card denied Write and Edit can
 * still write a file through a shell, so denying the editing tools alone does not stop it doing the
 * work, and Garden was telling managers in writing that it did. A role that has no sanctioned way
 * to put bytes on disk loses Bash too. The boss is the deliberate exception, because running the
 * test suite is its job, and its brief says so in those words rather than claiming more.
 *
 * Reading stays open everywhere. A card that cannot look at the code cannot brief anyone, and
 * reading puts nothing into the world.
 */
/**
 * The skills a role keeps. Everything else installed on the machine is denied to it.
 *
 * A keep list rather than a deny list, and the direction is the point. The skills directory is
 * shared by every project on this machine, so it holds work for repositories this one has never
 * heard of: a Blender preview convention, a Unity editor bridge. Naming those here to deny them
 * would mean this table needed editing every time the owner wrote a skill for something else, and
 * the failure would be silent, because a skill nobody remembered to deny simply shows up. Listing
 * what a role keeps fails the other way: something new is unavailable until somebody decides it
 * belongs, which is a decision rather than an oversight.
 *
 * His words, from the first time he raised it: "each window should only have the roots for its
 * role/function. so you technically dont need blender-prop-review because its outside of your
 * scope."
 *
 * The per-role differences are not tidiness either. Canon already claims a worker cannot run a
 * blind pass and a manager may not write canon, and both were true only because a related tool
 * happened to be denied. Taking `double-blind-review` off a worker and `canon-library` off a
 * manager makes those claims enforced rather than asked for, which is the distinction the whole
 * library is built on.
 */
export const ROLE_SKILLS: Record<string, string[]> = {
  orchestrator: ['canon-library', 'card-roots', 'double-blind-review', 'exit-interview', 'session-claims'],
  // No `canon-library`: a card that can both do the work and revise the description of what the
  // work was meant to be can never be found wrong. See the charter.
  manager: ['card-roots', 'double-blind-review', 'exit-interview', 'session-claims'],
  boss: ['card-roots', 'double-blind-review', 'exit-interview', 'session-claims'],
  delegator: ['card-roots', 'double-blind-review', 'exit-interview', 'session-claims'],
  // No `card-roots`, because a worker hires nobody, and no `double-blind-review`, because the role
  // is denied `Agent` and cannot spawn a reviewer at all. It would have been a brief describing
  // something the card would discover it could not do only at the moment of refusal.
  worker: ['exit-interview', 'session-claims'],
  specialist: ['exit-interview', 'session-claims'],
  reviewer: ['exit-interview'],
  // The same list as a reviewer's, for the same reason: it checks work and hands none out, so
  // `card-roots` and `double-blind-review` describe nothing it can do. Named rather than left to
  // the default, because falling through to `DEFAULT_SKILLS` would quietly give it
  // `session-claims`, which is for a card that edits a checkout somebody else is also editing.
  verifier: ['exit-interview'],
}

/** What a card with no role keeps: the project-agnostic ones, and nothing belonging to another repo. */
export const DEFAULT_SKILLS: string[] = ['exit-interview', 'session-claims']

export const ROLE_POWERS: Record<
  string,
  { denies: string[]; hires: boolean; creates: boolean; summary: string; enforced: string }
> = {
  /*
   * The one card that may cause a card to exist, and the one the owner talks to.
   *
   * `creates` is a separate bit from `hires` on purpose, because they were the same bit and that is
   * how a board reached thirty-eight cards with twenty running. `hires` is about the CLI's own Agent
   * tool, which spawns a helper that lives inside one session's turn and leaves when it ends.
   * `creates` is about a card on this board, which outlives the session that asked for it, keeps a
   * mailbox, and costs a window of context for as long as it is on. Every card with `hires` was
   * deciding its own fan-out and nothing counted the total, so the total was nobody's decision.
   *
   * Everything else asks this one, with `GARDEN_HIRE`, and gets an answer along a wire.
   *
   * Nothing is denied to it, and that is a deliberate reversal. It used to lose Edit and Bash on the
   * reasoning that canon is authored whole and the top of the chain should not be doing the work.
   * What that produced in practice was the owner asking the card he talks to for a change and being
   * told it could not make one, so every real edit landed back in his own hands at a terminal while
   * the board watched. The restriction only made sense while hiring worked, and hiring did not.
   */
  orchestrator: {
    denies: [],
    hires: true,
    creates: true,
    summary:
      'the owner talks to you, you own the canon, and you are the only card that may bring another ' +
      'card into existence',
    enforced:
      'Enforced: nothing is denied to you. You are the funnel rather than a restriction, so the ' +
      'limit that matters is the board ceiling, which refuses a card no matter who asks, including ' +
      'you. You can edit and run commands yourself, so a small job does not need a team built for it.',
  },
  /*
   * A layer the owner removed, kept readable rather than rewritten in the database.
   *
   * The chain used to be orchestrator, boss, managers, specialists. He took the boss out on
   * 2026-08-12 and canon recorded it as done; the deny arrays never changed, so for a while the
   * charter asserted a removal the code had not made. This is that decision landing.
   *
   * The row survives for the same reason `delegator` does. A card on his board is still stored with
   * `roleClass: 'boss'`, and a migration that rewrites a stored value on every start is exactly the
   * shape store.ts forbids. So an old boss card keeps the word it was made with and is run as a
   * manager until he changes it deliberately, and the powers below are the manager's.
   */
  boss: {
    denies: [],
    hires: true,
    creates: false,
    summary: 'a layer Garden no longer has, run as a manager',
    enforced:
      'Enforced: nothing is denied to you. This card was made under a role that no longer exists ' +
      'and is being run as a manager, so treat yourself as one.',
  },
  /*
   * A manager does its own work now, as well as planning it.
   *
   * It used to lose Edit and Bash, on the reasoning that a card with no sanctioned way to put bytes
   * on disk cannot quietly do the work it was supposed to hand out. What that produced was a card
   * that had to stand up a specialist for a two-line change, which is most of what the owner meant
   * when he called the spawning chaotic: the ceremony cost more than the work.
   *
   * It still hires, and `POWERS.md` still asks it to hand out what belongs to somebody else. That
   * is now a request backed by a reason rather than a restriction backed by a denial, which is the
   * honest place for it: whether a piece of work is somebody else's is a judgement, and denying a
   * tool cannot make that judgement.
   */
  manager: {
    denies: [],
    hires: true,
    creates: false,
    summary: 'you plan your department\'s work, hire the specialists, and do your own share of it',
    enforced:
      'Enforced: nothing is denied to you. Handing out what belongs to another card is asked of ' +
      'you rather than enforced, because whether a piece of work is somebody else\'s is a judgement ' +
      'and no denial can make it for you.',
  },
  worker: {
    denies: ['Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'],
    hires: false,
    creates: false,
    summary: 'you do the work itself, and you are the only role that changes the repository',
    enforced: 'Enforced: you cannot hire anyone, so the work is yours to do.',
  },
  reviewer: {
    denies: [
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
      'Agent',
      'SendMessage',
      'TaskCreate',
      'TaskUpdate',
      'TaskGet',
      'TaskList',
    ],
    hires: false,
    creates: false,
    summary: 'you read and report, and the orchestrator calls you rather than anyone else',
    enforced: 'Enforced: you can read and nothing else. You cannot write, run a command, or hire.',
  },
  /*
   * A reviewer that can report, which is the whole reason this exists beside `reviewer` rather than
   * instead of it.
   *
   * `reviewer` is denied Bash and Write. `garden-send.mjs` runs under Bash, and canon says a message
   * longer than one line goes in a file the shim reads, so a reviewer cannot write the file and
   * cannot run the shim. It can find something and has no way to tell anyone. Every blind pass on
   * this board has therefore been a subagent inside somebody else's turn, which ends when that turn
   * ends and cannot hold a task across a remediation round. An independent verifier that persists
   * has to be able to send.
   *
   * So the CLI lets it write and run commands, and the hook takes both back in the only two shapes
   * it needs them: a write inside its own mail and memory directories, and a Bash command that
   * begins with one of Garden's three shims. What that trades is real and is written in canon 20:
   * for every other role the CLI deny list is a backstop that holds even with the hook removed, and
   * for this one the hook is the only line. The alternative was a role that cannot report, which is
   * the thing being fixed.
   *
   * `hires` and `creates` are both false. A verifier that could bring a card into existence could
   * build the fix it just asked for, which is the independence this role is named after.
   */
  verifier: {
    denies: ['Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'MultiEdit', 'NotebookEdit'],
    hires: false,
    creates: false,
    summary:
      'you check work you did not do, and you report what you find rather than fixing it',
    enforced:
      'Enforced: you cannot hire, and you cannot spawn a subagent. Write and Edit reach your own ' +
      'mailbox and memory and nothing else, and Bash runs Garden\'s own shims and nothing else, so ' +
      'the only thing you can put into the world is a report. Both of those are refused by the hook ' +
      'rather than by the CLI, which is the one place your limits differ from every other role\'s.',
  },
  /*
   * The role Garden used to have, kept readable rather than rewritten in the database.
   *
   * Its old meaning, handing out work that was already specified, is what a manager does now.
   * Changing a stored value in a migration that runs on every start is exactly the shape store.ts
   * forbids, so an old card keeps its word and is run as a manager until the owner changes it
   * deliberately. It used to be run as a boss; that layer has since gone too.
   */
  delegator: {
    denies: [],
    hires: true,
    creates: false,
    summary: 'a role Garden no longer has, run as a manager',
    enforced:
      'Enforced: nothing is denied to you. This card was made under a role that no longer exists ' +
      'and is being run as a manager, so treat yourself as one.',
  },
}

/**
 * The order of the chain, and who each role naturally answers to.
 *
 * Used to fill in the reporting line when a card is created, so building the team is picking a role
 * rather than remembering the shape. It is a starting point and not a rule: the wires are what
 * actually permit anything, and the owner can draw whatever he likes.
 */
export const ROLE_CHAIN: Array<{ id: string; label: string; answersTo: string | null }> = [
  // The owner talks to this one, and it is the only card that may bring another into existence.
  { id: 'orchestrator', label: 'Orchestrator', answersTo: null },
  /*
   * No boss rung. The layer was removed on 2026-08-12 and this is where that shows: a manager
   * answers to the orchestrator directly, and so does a reviewer, which used to be the boss's own
   * call to make. The `boss` entry still exists in ROLE_POWERS so a card stored under that word
   * keeps working, but it is not offered as somewhere new work should sit.
   */
  { id: 'manager', label: 'Manager', answersTo: 'orchestrator' },
  { id: 'worker', label: 'Worker', answersTo: 'manager' },
  { id: 'reviewer', label: 'Reviewer', answersTo: 'orchestrator' },
  /*
   * Answers to the orchestrator and never to the card whose work it checks. A verifier reporting to
   * the manager that assigned the task would be checking its own supervisor's work and telling that
   * supervisor what it found, which is not independence however carefully it is written.
   */
  { id: 'verifier', label: 'Verifier', answersTo: 'orchestrator' },
]

/**
 * How large a board may get, and the only thing that actually bounds it.
 *
 * Every card that could hire was deciding its own fan-out and nothing counted the total, so one
 * request produced thirty-eight cards with twenty sessions running and no card had misbehaved:
 * each hired what its brief allowed. The total was nobody's decision. This is the count that makes
 * it somebody's.
 *
 * Enforced in the `session.create` handler rather than only at the hiring endpoint, so a scratch
 * script or a raw WebSocket call meets the same refusal an agent does. That includes the owner's
 * own hands, on purpose: a ceiling with an exception for whoever is most likely to be in a hurry
 * is not a ceiling.
 */
export interface BoardLimits {
  /** Cards with a live process, board-wide. */
  running: number
  /** Cards on this project's board that have not been closed, whatever their state. */
  cardsPerProject: number
  /** How many a single card may have reporting to it, when it has set no figure of its own. */
  childrenPerCard: number
  /**
   * How many subagents one card may run at once. The owner's words: "the number of subagents a card
   * is allowed to spawn for itself".
   *
   * The one limit in this interface that Garden does not check anywhere, and it must never be
   * described as though it does. Garden learns about a subagent from `SubagentStart`, which the CLI
   * fires after its own dispatch, so a check there would be refusing to record something already
   * running. What holds this number is the CLI: it goes into the card's settings file at launch as
   * `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (`server/src/hooks-install.ts`), the same file that
   * carries the deny list, and the CLI enforces its own rule. One authority for permissions, stated
   * in that authority's language.
   *
   * Two things it does not do, both of which a brief quoting it has to say out loud. It caps how
   * many run at the same moment, not how many a card spawns over a session, so five allowed means
   * five at a time and this field counts no totals. Whether a card may dispatch at all is
   * `subagentsAllowed` below: a different field, held by a different authority, and the two must
   * never be described as one number. See `docs/canonical/15-guardrails.md`. And it lands at
   * launch, because that is when the CLI reads settings, so changing it here reaches cards turned
   * on afterwards rather than one already going.
   *
   * A card that set its own `teamSize` is held to that; this is the fallback for a card that set
   * none, the same shape `childrenPerCard` has.
   *
   * Added on 2026-09-09 because the owner found the figure beside them was not editable: "make sub
   * agents field modifiable, its currently static and limits cant be changed", then named what it
   * should mean. It was briefly a retention cap that deleted the oldest spent records, which canon
   * 15 forbids in as many words: a limit refuses, it never removes.
   */
  subagents: number
  /**
   * Whether cards on this board may dispatch subagents at all.
   *
   * Yes or no, not a number, and the only subagent decision Garden holds itself. `subagents` above
   * is the CLI's concurrency cap and says nothing about permission; this says whether there is
   * anything to be concurrent about.
   *
   * What holds it is Garden's own hook, at `PreToolUse`, refusing the dispatch tool before the
   * subagent exists. That is the only point at which it can be held: Garden hears about a subagent
   * through `SubagentStart`, which the CLI fires after its own dispatch, so a check anywhere later
   * would be refusing to record something already running. Canon 15 sets this out in "The five
   * rows, and what holds each one", including why three rows on one panel are three different
   * mechanisms.
   *
   * It was a lifetime count for about an hour on 2026-09-09, and the owner rejected the shape
   * rather than the figure: "subagents are disposable i dontw ant to create a cap for how many iit
   * can create its whole life". A lifetime cap prices a thing that costs nothing to throw away, and
   * it bites hardest on the card that has been working longest, which is the wrong card to stop.
   *
   * Not the same thing as a card's own `SessionPowers.canSpawnAgents`, and both exist on purpose.
   * That flag is chosen when a card is made and reaches the CLI in the settings file at launch, so
   * changing it waits for the card to be turned on again. This is asked at the hook, per dispatch,
   * so switching it off here stops the next dispatch on a card that is already running.
   */
  subagentsAllowed: boolean
  /**
   * How many cards may be mid-turn at the same moment.
   *
   * A separate number from `running`, and it has to be. The owner's position is that being awake is
   * free: "sitting idle is free, i dont mind more than the cap sitting idle, but i want to be able
   * to establish the cap of concurrent work to prevent 50 sessions occurring at once". `running` is
   * what `overCeiling` already refuses cards against on create and on start, so sharing one number
   * would refuse the fourth card into existence before a work ceiling of two could ever be reached.
   * Two different questions, two numbers.
   *
   * Enforced where a message is typed into a card and thereby makes it work, not where a card is
   * started, because starting one does not make it do anything. At the ceiling the message waits
   * and is typed in when a slot frees; it is never refused, because canon forbids a guardrail from
   * stopping mail and a card that cannot say it is stuck turns a small problem into an invisible
   * one.
   */
  working: number
  /**
   * How hard the task ownership rules bite on this project.
   *
   * Here rather than in a config file because it is the same kind of decision as the ceilings
   * beside it: something the owner changes mid-afternoon from the board, per project, when he can
   * see what it is doing.
   */
  taskAuthority: TaskAuthority
  /**
   * How long an owner may be quiet before `owner_silent` is accepted as a reassignment reason.
   *
   * A number rather than a constant because the honest figure depends on the work. A card mid-way
   * through a long build is silent for reasons that are not abandonment, and a board where every
   * card answers in a minute wants a tighter figure than one where they do not.
   */
  silenceMinutes: number
  /**
   * What may authorize a restart when a card is running an old CLI.
   *
   * `manual` means nothing does: the pending state is shown and the owner decides, one card at a
   * time. `when-safe` means the owner has said in advance that a card may be restarted once it
   * reaches a safe boundary. Per project and set from a terminal, the same door as `taskAuthority`,
   * because it is the same kind of decision: a policy the owner changes mid-afternoon.
   *
   * Nothing consumes this yet. The stage that acts is ordered separately, and until it exists this
   * field is stored and reported and refuses nothing.
   */
  updatePolicy: UpdatePolicy
}

/**
 * What authorizes an update restart, per project.
 *
 * Two values rather than three, because "never" is `manual` with the owner never pressing the
 * button, and a third value would be a second way to say the same thing.
 */
export type UpdatePolicy = 'manual' | 'when-safe'

/**
 * Whether a card could be restarted right now without losing anything, or the one reason it could
 * not.
 *
 * A closed list rather than free text, because the reason is shown on the card face and read by a
 * person deciding whether to wait. Every value here is one of canon 21's boundary conditions.
 *
 * `mid-turn` the CLI has not finished the turn it is on. `tool-open` a tool call was started and
 * its result has not been recorded. `child-running` something the card started is still running.
 * `claim-held` the card holds a file claim its checkpoint does not say to keep. `composer-dirty`
 * the composer has had keystrokes since the last submit, and Garden cannot read a raw PTY draft
 * back, so it must assume there is one. `prompt-open` a permission or authentication prompt is on
 * screen, which only the owner answers. `not-running` there is no process to restart.
 */
export type BoundaryBlocker =
  | 'mid-turn'
  | 'tool-open'
  | 'child-running'
  | 'claim-held'
  | 'composer-dirty'
  | 'prompt-open'
  | 'not-running'

/** The boundary check's answer: safe, or the first blocker found, with a sentence for the owner. */
export interface BoundaryResult {
  safe: boolean
  blocker: BoundaryBlocker | null
  /** One sentence, written for the person reading the card face. */
  reason: string
  /** What was actually looked at, so an answer can be argued with rather than believed. */
  checked: {
    pid: number | null
    children: number[]
    lastInputAt: number | null
    lastStopAt: number | null
    openTools: number
    claims: string[]
  }
}

/**
 * Where a project starts before the owner has said otherwise.
 *
 * Twelve and six is roughly two departments, which refuses the thirty-eight-card afternoon well
 * before it starts while leaving a real team room to work. It is a starting point, not a policy:
 * the numbers are per project and the owner changes them from the board at any moment.
 */
export const DEFAULT_LIMITS: BoardLimits = {
  running: 6,
  cardsPerProject: 12,
  childrenPerCard: 4,
  /*
   * Five, because that is the figure the owner has given twice for how much should be happening at
   * once: "lets stick wtih 5 at a time max" and, when the distinction between awake and working was
   * drawn, "i dont mind more than the cap sitting idle, but i want to be able to establish the cap
   * of concurrent work to prevent 50 sessions occurring at once".
   *
   * Below `running` on purpose. Six cards may be awake and five of them may be mid-turn, which is
   * the shape he described: idle is free, work is what is rationed.
   *
   * Nothing enforces this yet. The field was declared by the manager card in the restart window
   * that ended the session before it could set a default, which left the build unable to compile;
   * this completes the declaration and no more. The enforcement it was designed for lives at the
   * quiet check in `flushMailWake` and is still unwritten, so a reader should treat this today as a
   * number the board will show and refuse nothing against.
   */
  working: 5,
  /*
   * Shadow, and not enforce, and this is the one default in this table that is a policy rather than
   * a guess at a good number.
   *
   * Canon 20 puts it plainly: nothing refuses until the owner turns it on. Every rule is evaluated
   * and every refusal is recorded as a `TaskWouldRefuse`, and then the message is delivered exactly
   * as it was before. So the first thing the owner sees is a list of what would have been stopped,
   * on a board that is still working, and he decides from that rather than from an argument. A
   * ruleset this wide arriving already enforced would refuse real mail on the first afternoon for
   * reasons nobody had tested against real traffic, and the refusals would look like the app being
   * broken.
   *
   * Sixty minutes for silence, which is longer than any hand-off on this board has taken and short
   * enough to be useful the same day.
   */
  taskAuthority: 'shadow',
  silenceMinutes: 60,
  /*
   * Five subagents at a time per card, which is the CLI's own default rather than a figure invented
   * here. A default that differed from the CLI's would change every card's behaviour the first time
   * Garden launched it, and would do it silently, since nothing on screen would say the number had
   * moved.
   */
  subagents: 5,
  /*
   * Subagents allowed, because this is the only setting on the panel that can stop work a card is
   * already doing, and a board that arrived switched off would look like the CLI was broken.
   *
   * The same answer is the migration's default for boards that predate the column, and for a
   * stronger version of the same reason: those cards are dispatching subagents today, and a
   * migration that answered no would refuse their next one for a decision nobody made.
   */
  subagentsAllowed: true,
  /*
   * Manual, because canon 21 says an update pending is never on its own a reason to restart and
   * something has to authorize it. A board that came back from a restart already set to restart
   * its own cards would be deciding for the owner in the one place he asked to decide.
   */
  updatePolicy: 'manual',
}

export const WS_PATH = '/ws'
export const DEFAULT_PORT = 5178

/**
 * The board's spacing, in one table because two copies of it is what put cards on top of each other.
 *
 * The owner's rule is that the board reads like photographs in an album: every card keeps a visible
 * gap from every other card, and the blocks that hang off a card (its roots below, its history
 * above) are cards like any other and obey it too.
 *
 * The part that kept breaking is that a web is drawn larger than the cards in it. A frame is painted
 * around the block with its own title bar and a row of column labels above the first row, and that
 * frame is what the eye sees as the edge of the web. The server was reserving space for the cards
 * and the client was drawing the frame around them from a separately maintained set of numbers, so
 * the frame reached 94 pixels above a block that had been placed 90 pixels below its card, and the
 * top of the web sat four pixels inside the card above it. Every one of those numbers now comes
 * from here, and the placement clears the frame rather than the cards.
 */
export const BOARD = {
  /** The clear space every card keeps from every other card. */
  GAP: 26,
  /** Border padding drawn around a web's cards, on all four sides. */
  FRAME_PAD: 18,
  /** The frame's own title bar, above that padding. */
  FRAME_HEAD: 30,
  /** The band of column labels between the title bar and the first row of cards. */
  FRAME_LABELS: 46,
  /**
   * How tall a collapsed card actually draws.
   *
   * Measured from the DOM rather than assumed: a collapsed card is a header, and a header whose
   * title wraps to a second line comes out taller than one that does not. Reserving the short
   * figure is why rows that were supposed to be 26 apart were drawn 14 apart. This is the tall
   * case, because over-reserving costs a little space and under-reserving costs the rule.
   */
  COLLAPSED_H: 52,
  /**
   * Row to row inside a web, which is tighter than the clearance two loose cards keep.
   *
   * GAP is the space a card keeps from a card that has nothing to do with it, and it is right for
   * that. The rows of a web are one thing: a column of files a card works from, or a column of the
   * turns it took. Held that far apart they read as a scattering of separate cards rather than as a
   * list, which is what the owner was looking at. A web is placed and moved as one block, so
   * nothing comes along afterwards and widens this back out.
   */
  WEB_ROW_GAP: 8,
  /**
   * How far a card's furniture hangs past its own border, top and bottom.
   *
   * The two web arrows sit astride the edge and each carries a label beside it, and the label is
   * the part that reaches furthest: 41 pixels, measured from the DOM, against the 6 the arrow
   * itself takes. Clearance measured from the border alone leaves those controls with about
   * thirteen pixels of room, which is the opposite of the owner asking for enough space to open
   * them.
   */
  PORT_REACH: 42,
  /**
   * What the Large preset actually measures.
   *
   * Here rather than only in the canvas, because the server places a card's webs from the stored
   * box. While this lived in the drawing code alone, a card set to Large was drawn at these
   * dimensions and stored at whatever it had been before, so its roots were placed against an edge
   * that was no longer where the card ended.
   */
  LARGE_W: 780,
  LARGE_H: 540,
} as const

/** Everything a web's frame adds above its first row of cards. */
export const FRAME_HEADROOM = BOARD.FRAME_PAD + BOARD.FRAME_HEAD + BOARD.FRAME_LABELS

/**
 * The window a card's tokens are measured against, from the model that card is actually running.
 *
 * Here, in shared, because there have now been three copies of this answer and they disagreed every
 * time. It was one flat million for the whole board first, which measured a Sonnet card against five
 * times its real window. Then `ingest.ts` grew its own table giving Opus 200,000 while `tokens.ts`
 * still said a million, so the same bar jumped by a factor of five depending on which source last
 * reported. Those two were reconciled and a third survived in the card itself, as the literal string
 * "of 1,000,000" beside the token count, which is what the owner was reading on 2026-08-15 while his
 * orchestrator ran Fable.
 *
 * Opus is a million. The marker only appears in the model name when the variant was picked by hand,
 * while the CLI reports plain `opus-5` and prints "Opus 5 (1M context)" in its own footer, so
 * measuring those against 200,000 made every Opus card look four fifths full before it had done
 * anything.
 *
 * A model this does not recognise returns null, and null means the card says it does not know rather
 * than showing a denominator nobody chose. That is the whole point of the gauge: it answers whether
 * a session is too full to trust, and a made-up denominator answers it confidently and wrongly. A
 * blank gauge on a new model is the table being honest, not the table being broken, and the fix is
 * to add the model here once its real window is known.
 */
export function contextWindowFor(model: string | null): number | null {
  if (!model) return null
  const m = model.toLowerCase()
  if (m.includes('[1m]') || m.includes('-1m')) return 1_000_000
  if (m.includes('opus')) return 1_000_000
  // Fable 5 ships at a million with no separate long-context variant, per the published model table.
  if (m.includes('fable')) return 1_000_000
  /*
   * The fifth generation of Sonnet is a million; the ones before it are not.
   *
   * Matched on the generation rather than the family, which is the whole care needed here. A plain
   * `sonnet` test would have measured a 3.5 card against five times its window, which is the same
   * error this function was written to fix, pointing the other way. Anything older keeps 200,000
   * below.
   */
  if (/sonnet[-\s]?5/.test(m)) return 1_000_000
  if (m.includes('sonnet') || m.includes('haiku')) return 200_000
  return null
}
