/**
 * Installing Garden's observer hooks without touching the owner's own configuration.
 *
 * This machine already has 23 guards dispatched from a registry, an account check, and a stop
 * guard that refuses to end a turn until a screenshot has been reviewed. Merging a block into
 * `~/.claude/settings.json` to sit alongside that is how a tool ends up owning a file it did not
 * write, and how a bad merge one day switches somebody else's guards off.
 *
 * So Garden writes its own settings file, containing nothing but its hooks, and passes it with
 * `--settings`. That is a documented CLI flag whose values merge with every other settings layer
 * rather than replacing them, and it lives entirely inside `~/.garden`. Removing Garden removes
 * every trace of this.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from './store.js'

const here = dirname(fileURLToPath(import.meta.url))

/** The observer script, found relative to this file so a built and a source tree both work. */
export function hookScriptPath(): string {
  return resolve(here, '..', 'hooks', 'garden-hook.mjs')
}

/** The shim a card runs to send along a wire, found the same way. */
function sendShimPath(): string {
  return resolve(here, '..', 'bin', 'garden-send.mjs')
}

function hireShimPath(): string {
  return resolve(here, '..', 'bin', 'garden-hire.mjs')
}

function taskShimPath(): string {
  return resolve(here, '..', 'bin', 'garden-task.mjs')
}

/**
 * Events with no matcher support take no matcher field, and events that have one take `.*`.
 * Getting this backwards does not error: the hook simply never fires, which is the worst possible
 * failure here because the board then looks calm and says nothing is happening.
 */
const MATCHERLESS = new Set(['UserPromptSubmit', 'Stop', 'TaskCreated', 'TaskCompleted'])

const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
]

/**
 * What a card is allowed to do, expressed in the CLI's own permission language.
 *
 * Garden does not intercept a dispatch and it does not argue with a decision the CLI has already
 * made. It writes a deny entry into the settings file it was going to pass anyway, and the CLI
 * enforces its own rule. That keeps one authority in charge of permissions, which is the whole
 * reason this app refuses to be a second one.
 *
 * A denial only takes effect at launch, because that is when the CLI reads its settings. The card
 * says so rather than implying a running session changed underneath the owner.
 */
/*
 * The role table moved to @garden/shared so the form that creates a card and the settings file that
 * restricts it read the same rows. It was here alone while the only thing that needed it was the
 * server; the moment the canvas needed to describe a role, keeping it here meant a second copy, and
 * a second copy of this table is what once had Garden telling managers in writing about a denial it
 * had not written.
 */
import { ROLE_POWERS, ROLE_SKILLS, DEFAULT_SKILLS } from '@garden/shared'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * Every skill installed on this machine, user-level and project-level.
 *
 * Read rather than listed, because the deny list is built by subtraction: a role keeps what
 * `ROLE_SKILLS` names and loses everything else, and "everything else" cannot be known without
 * looking. A hardcoded list would go stale the moment the owner writes a skill for another
 * repository, and it would go stale silently, which is the failure mode this whole table exists to
 * avoid.
 *
 * Both directories, because they are additive: a project skill and a personal skill both load, and
 * a card should not keep one merely because it was installed in the other place.
 */
function installedSkills(projectPath?: string): string[] {
  const dirs = [join(homedir(), '.claude', 'skills')]
  if (projectPath) dirs.push(join(projectPath, '.claude', 'skills'))
  const found = new Set<string>()
  for (const dir of dirs) {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) found.add(e.name)
    } catch {
      // No such directory is the ordinary case, not a fault.
    }
  }
  return [...found]
}
export { ROLE_POWERS }

export interface SessionPowers {
  canSpawnAgents: boolean
  canUseTeams: boolean
  /**
   * What this card is for, which decides which tools it is allowed to reach for.
   *
   * This is the part that makes a pipeline happen rather than be drawn. A manager that CAN do the
   * work will do the work: it is faster in the moment, and the result is one session holding
   * everything and a team of cards that never ran. Denying a manager the editing tools removes
   * the choice, so the only way it can act on the world is by hiring someone. That is the CLI's
   * own permission layer refusing a tool, not Garden nagging.
   */
  /** Any key of ROLE_POWERS. Kept as a string so the table is the only list of role names. */
  roleClass?: string | null
  /** How many agents may run at once. Null leaves the CLI's own default alone. */
  teamSize?: number | null
  /** An alias like opus, or a full model id. Null means whatever the account defaults to. */
  model?: string | null
  /** low, medium, high, xhigh, max, ultracode or auto. Null leaves it alone. */
  effort?: string | null
}

export function buildHookSettings(port: number, powers?: SessionPowers): unknown {
  // Forward slashes so the JSON needs no escaping and the command reads the same on any shell.
  const command = `node "${hookScriptPath().replace(/\\/g, '/')}"`
  const hooks: Record<string, unknown[]> = {}
  for (const event of EVENTS) {
    const entry: Record<string, unknown> = { hooks: [{ type: 'command', command, timeout: 5 }] }
    if (!MATCHERLESS.has(event)) entry.matcher = '.*'
    hooks[event] = [entry]
  }
  /*
   * The tool names, checked against the CLI's own documentation rather than guessed.
   *
   * An earlier version denied "Task" and three invented team tool names. Task is what the matcher
   * syntax calls the dispatch tool, but the permission entry is Agent, and the team tools are the
   * Task* family plus SendMessage. A deny list with the wrong names is the worst possible outcome
   * here: the card says a card may not hire and the CLI happily lets it.
   */
  const deny: string[] = []
  const noHiring = powers && (!powers.canSpawnAgents || powers.teamSize === 0)
  if (noHiring) deny.push('Agent')

  // Whatever this role is not allowed to reach for, from the one shared table.
  const role = powers?.roleClass ? ROLE_POWERS[powers.roleClass] : undefined
  if (role) for (const t of role.denies) if (!deny.includes(t)) deny.push(t)
  if (powers && !powers.canUseTeams) {
    deny.push('SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList')
  }

  const env: Record<string, string> = { GARDEN_PORT: String(port) }
  /*
   * A cap on how many agents run at once, which is the one part of team size the CLI enforces.
   * It does not limit how many are hired over a whole session, so the card must not claim it does.
   */
  if (powers?.teamSize && powers.teamSize > 0) {
    env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(powers.teamSize)
  }

  /*
   * Cards open in auto mode, and their own send command is allowed outright.
   *
   * The owner's words: cards should start in auto mode so they can communicate with each other from
   * the start. Watching a live demo showed why. A card asked to write to another card stopped on a
   * permission prompt for the shell command that does the writing, and a board of agents that talk
   * to each other cannot ask him to approve every sentence. `permissions.defaultMode` is the same
   * setting the footer of the terminal cycles with shift+tab, so a card now opens where he would
   * have put it by hand.
   *
   * The send shim is allowed by name on top of that, because auto mode runs a classifier and a
   * classifier can decline. Mail is the one thing on this board that must not depend on a judgement
   * call: a refused send is a message the sender believes it delivered.
   *
   * Note what this does not touch. The deny list below still applies and still wins, so a manager
   * that may not edit files still cannot, in auto mode or any other.
   */
  const shim = sendShimPath().replace(/\\/g, '/')
  const hire = hireShimPath().replace(/\\/g, '/')
  const taskShim = taskShimPath().replace(/\\/g, '/')
  const permissions: Record<string, unknown> = {
    defaultMode: 'auto',
    /*
     * The hire shim is allowed by name for the same reason the send shim is. A card that has to
     * stop and ask the owner before it may even ask for a card is a card the owner has to babysit,
     * and the first live run stalled on exactly this class of prompt. The shim itself creates
     * nothing: what it can do is bounded by the role check and the board ceiling on the server,
     * both of which are enforced whether this allow entry is here or not.
     */
    allow: [
      `Bash(node "${shim}"*)`,
      'Bash(node *garden-send.mjs*)',
      `Bash(node "${hire}"*)`,
      'Bash(node *garden-hire.mjs*)',
      /*
       * The task shim is allowed by name for the same reason the other two are, and for one more.
       * A card that has to stop and ask the owner before it may read its own task contract is a
       * card that will not read it, and will then work to what it remembers being told rather than
       * to what it was given. What the shim can do is bounded by the dispatcher check on the
       * server, which applies whether this entry is here or not.
       */
      `Bash(node "${taskShim}"*)`,
      'Bash(node *garden-task.mjs*)',
      /*
       * Looking at things is never a question.
       *
       * The owner's first real run stalled on a stream of permission prompts, and a board whose
       * whole promise is that it runs while he is not watching cannot ask him to approve reading a
       * file. Every entry below only reads: it prints, lists, searches or reports, and none of them
       * puts a byte on disk or starts anything.
       *
       * This is not a widening of what a card may do. The deny list is evaluated first and still
       * wins, so a reviewer that may not run a shell at all still cannot run any of these, and the
       * owned-paths hook still refuses a write outside a card's own territory. What it removes is
       * the prompt in front of the things that were never in question.
       */
      'Bash(git status*)',
      'Bash(git diff*)',
      'Bash(git log*)',
      'Bash(git show*)',
      'Bash(git branch*)',
      'Bash(ls*)',
      'Bash(cat*)',
      'Bash(head*)',
      'Bash(tail*)',
      'Bash(rg*)',
      'Bash(grep*)',
      /*
       * `find` is deliberately absent from this list even though it belongs to the same family.
       * `-delete` and `-exec` make it a writing tool wearing a reading tool's name, and a prefix
       * match cannot tell the two apart. `rg --files` covers what a card actually wants it for.
       */
      'Bash(node --version*)',
      'Bash(npm ls*)',
      'Bash(npm run build*)',
      'Bash(npx tsc --noEmit*)',
      'Read',
      'Glob',
      'Grep',
    ],
  }
  if (deny.length) permissions.deny = deny
  const settings: Record<string, unknown> = {
    hooks,
    env,
    permissions,
    claudeMdExcludes: CLAUDE_MD_EXCLUDES,
    /*
     * The CLI's own auto-memory, off, and it is the same argument as the excludes above.
     *
     * It defaults to `~/.claude/projects/<sanitized-cwd>/memory/`, and every Garden card on a board
     * is spawned in the same working directory, so that one directory is shared by all of them: what
     * one card wrote there, every other card reads. Turning it off was not obvious from reading
     * anything. It came out of asking a real session what it had loaded after the excludes were in
     * place, and getting back "NONE" for CLAUDE.md files followed by the auto-memory index, which
     * would have left the shared half of the problem quietly in place.
     *
     * Nothing is lost. A card already has its own notes directory, keyed to the card rather than to
     * the working directory, which is the thing auto-memory was standing in for and doing worse.
     */
    autoMemoryEnabled: false,
    /*
     * The project's own MCP servers, approved in advance.
     *
     * Without this a freshly created card opens on an interactive prompt, "2 new MCP servers found
     * in this project, select any you wish to enable", and stops there. It cannot be answered by
     * whoever created the card and it cannot be answered by the card, because a card is a session
     * with nobody sitting at it. Found live on 2026-08-14 when the first card hired under the new
     * roots came up red and its terminal was frozen at that prompt with its process gone.
     *
     * Scoped to `.mcp.json` in the project the card was launched into, which is the owner's own
     * repository and the same file his own sessions already run with. It approves nothing from
     * anywhere else.
     */
    enableAllProjectMcpServers: true,
  }
  if (powers?.model) settings.model = powers.model
  if (powers?.effort) settings.effortLevel = powers.effort
  return settings
}

/**
 * A card starts knowing nothing except what its creator wrote for it.
 *
 * The CLI walks from a session's working directory to the filesystem root loading every `CLAUDE.md`
 * it passes, and reads the user-level one as well. Every Garden card is spawned in the project root,
 * so every card on a board loaded the same project instructions, the same user instructions, and
 * anything else those import. The owner's words: "i want each card to load with an empty set of
 * roots that its creator writes for them. currently each claude session gets every .md ever
 * created."
 *
 * That is the whole complaint, and it is the opposite of what a board of cards is for. A shared
 * document describes the project, which is the one thing a card could have looked up anyway. What it
 * cannot derive is what it is for, what it owns and who it answers to, and that is exactly what got
 * buried under documents written for somebody else.
 *
 * `claudeMdExcludes` is the CLI's own switch for this. It takes globs matched against absolute paths
 * and applies to User, Project and Local memory; managed policy files cannot be excluded and are
 * deliberately left alone. It lives here, in the per-card settings file handed over with
 * `--settings`, so it travels with the card rather than being a machine-wide setting.
 *
 * The card is not left with nothing. Its own brief, its powers, its peers and its unread mail arrive
 * through the `SessionStart` hook in `server/hooks/garden-hook.mjs`, which is the CLI's supported
 * door for adding context. So what a card knows is exactly what Garden and its creator put there.
 */
const CLAUDE_MD_EXCLUDES = ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/AGENTS.md']

/**
 * A settings file for one session, holding its hooks and its permissions.
 *
 * Per session rather than one shared file, because two cards on the same board can legitimately
 * have different powers: an orchestrator that hires and a specialist that must do the work it was
 * given. Named by card id so it is stable across restarts and obvious on disk.
 */
export function installSessionHooks(port: number, sessionId: string, powers: SessionPowers): string {
  const dir = join(DATA_DIR, 'hooks', 'sessions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.json`)
  writeFileSync(file, JSON.stringify(buildHookSettings(port, powers), null, 2), 'utf8')
  return file
}

/**
 * Write the settings file and return its path.
 *
 * Rewritten on every start rather than created once, so a changed port or a moved install cannot
 * leave a stale file pointing a hook at nothing.
 */
export function installHooks(port: number): string {
  const dir = join(DATA_DIR, 'hooks')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'settings.json')
  writeFileSync(file, JSON.stringify(buildHookSettings(port), null, 2), 'utf8')
  return file
}
