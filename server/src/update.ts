/**
 * What Garden knows about a card running an old CLI, and nothing it does about it.
 *
 * Canon 21 revision 2 decides the shape; `.claude/work-orders/cli-update-evidence.md` is where each
 * fact used here was measured. Everything in this file either reads or answers. Nothing in it ends,
 * starts, restarts or resumes anything, and the stage that acts is ordered separately.
 *
 * The rule that governs all of it: terminal text is never evidence. The CLI draws "Update
 * installed · Restart to update" in its own status line, that phrase appears in quoted prose and
 * tool results and in this comment, and a card must never be restarted because a phrase matched.
 * The two facts Garden compares are the version the process recorded for itself in the CLI's
 * registry, and the version the executable on disk reports.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BoundaryBlocker, BoundaryResult, TerminalSession } from '@garden/shared'

/**
 * The installed version, cached against the executable's own mtime.
 *
 * The mtime is the cache key rather than a clock because that is exactly what an update changes:
 * the native install renames the running `claude.exe` out of the way and puts the new build at the
 * same path, so a swap under a running server moves the mtime and the next read runs the executable
 * again. Two seconds of staleness would be fine; an hour of it would mean a board that never
 * noticed an update it was written to notice.
 */
const versionCache = new Map<string, { mtimeMs: number; version: string | null }>()

/** Where a CLI lives, resolved from PATH once, because PATH does not change while a server runs. */
const pathCache = new Map<string, string | null>()

function resolveExecutable(command: string): string | null {
  if (pathCache.has(command)) return pathCache.get(command) ?? null
  let found: string | null = null
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(finder, [command], { encoding: 'utf8', timeout: 5000 })
    const hits = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && existsSync(s))
    /*
     * The first line is not the answer on Windows, and finding that out cost two failing runs.
     * `where claude` on this machine lists three, in this order: an extensionless shell script the
     * native installer leaves in `.local\shim`, then its `.cmd`, then the real
     * `.local\bin\claude.exe`. `execFile` will not run the first (ENOENT, no extension Windows can
     * execute) and refuses the second outright (EINVAL: node stopped spawning `.cmd` and `.bat`
     * without a shell when it closed CVE-2024-27980). A failed probe reads as an unknown version,
     * and unknown is never pending, so taking the first line would have left the whole feature
     * silently off on exactly the installation it was written for, with nothing on screen to say
     * so. A real executable first, and a batch shim only as a fallback, run the one way that works.
     */
    const real = hits.find((h) => /\.(exe|com)$/i.test(h))
    const batch = hits.find((h) => /\.(cmd|bat)$/i.test(h))
    found = process.platform === 'win32' ? (real ?? batch ?? null) : (hits[0] ?? null)
  } catch {
    // Not on PATH, or the lookup itself failed. Null means unknown, which is never pending.
    found = null
  }
  pathCache.set(command, found)
  return found
}

/**
 * `<cli> --version`, run for its answer and for nothing else.
 *
 * `DISABLE_AUTOUPDATER=1` in the child's environment, and it is not a detail. One installation
 * serves every card on this machine, so a version probe that quietly installed an update would have
 * changed the thing it was asked to measure, under sixteen live processes, without anybody asking
 * for it. Garden coordinates restarts; it never installs.
 */
function askVersion(exe: string): string | null {
  try {
    /*
     * A `.cmd` shim has to go through `cmd.exe`, because node will not spawn one directly any more.
     * The path goes in as its own argument rather than inside a command string, so node quotes it
     * and cmd's own quote rules never come into it. Nothing here is user input either way: the path
     * came from `where`, and an npm global install of Codex is exactly this shape.
     */
    const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)
    const out = batch
      ? execFileSync('cmd.exe', ['/d', '/c', exe, '--version'], {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
        })
      : execFileSync(exe, ['--version'], {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
        })
    const m = /(\d+\.\d+\.\d+)/.exec(out)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * The version on disk for one adapter, or null when it cannot be read.
 *
 * Null everywhere it is not certain: no such command, an executable that will not answer, an answer
 * with no version in it. Canon's rule is that unknown is never pending, and it is carried by these
 * nulls rather than by a check somewhere downstream.
 */
export function installedVersionFor(adapterId: string): string | null {
  const command = adapterId === 'claude' ? 'claude' : adapterId === 'codex' ? 'codex' : null
  if (!command) return null
  const exe = resolveExecutable(command)
  if (!exe) return null

  let mtimeMs = 0
  try {
    mtimeMs = statSync(exe).mtimeMs
  } catch {
    return null
  }
  const hit = versionCache.get(exe)
  if (hit && hit.mtimeMs === mtimeMs) return hit.version
  const version = askVersion(exe)
  versionCache.set(exe, { mtimeMs, version })
  return version
}

/** Only for tests, which change an executable's mtime faster than a filesystem timestamp resolves. */
export function forgetVersionCache(): void {
  versionCache.clear()
  pathCache.clear()
}

/**
 * What Codex records about its own updates.
 *
 * Codex keeps the comparison Garden has to make for Claude in a file of its own,
 * `~/.codex/version.json`, holding the latest version it has seen, when it last looked, and a
 * version the owner has dismissed. The dismissal is the owner saying not now, and Garden reads it
 * so it can say so too rather than stepping over it.
 */
export interface CodexUpdateState {
  latestVersion: string | null
  lastCheckedAt: string | null
  dismissedVersion: string | null
}

export function codexUpdateState(codexHome?: string): CodexUpdateState {
  const home = codexHome || process.env.CODEX_HOME || join(homedir(), '.codex')
  try {
    const raw = JSON.parse(readFileSync(join(home, 'version.json'), 'utf8')) as Record<string, unknown>
    return {
      latestVersion: typeof raw.latest_version === 'string' ? raw.latest_version : null,
      lastCheckedAt: typeof raw.last_checked_at === 'string' ? raw.last_checked_at : null,
      dismissedVersion: typeof raw.dismissed_version === 'string' ? raw.dismissed_version : null,
    }
  } catch {
    return { latestVersion: null, lastCheckedAt: null, dismissedVersion: null }
  }
}

/** Everything the update state of one card is computed from, so the computation can be tested alone. */
export interface UpdateFacts {
  adapterId: string
  /** From the CLI's registry entry for this card's live process. Null when unknown. */
  runningVersion: string | null
  /** From the executable on disk. Null when unknown. */
  installedVersion: string | null
  /** The conversation Garden could reopen, or null when there is none to reopen. */
  resumeId: string | null
  /**
   * What Codex itself has recorded about updates, for a Codex card. Ignored for anything else.
   *
   * Carried into the reason rather than into the flags, because a newer Codex being available is
   * true and useful and still not a reason to restart a card Garden cannot resume. A version the
   * owner has dismissed is his answer already, and Garden says so instead of repeating the offer.
   */
  codex?: CodexUpdateState
}

export interface UpdateState {
  runningVersion: string | null
  installedVersion: string | null
  updatePending: boolean
  updateEligible: boolean
  updateReason: string | null
}

/**
 * Pending, and eligible, which are two different questions and are answered separately on purpose.
 *
 * Pending is about versions: this process is older than what is installed. Eligible is about
 * whether a restart could put the card back where it was at all, which for a Codex card is no,
 * whatever its versions say, because Garden's adapter passes no resume flag and has never recorded
 * a Codex conversation id. Saying "update pending" on a card that cannot come back with its work
 * would be an invitation to lose it.
 *
 * Unknown is never pending, in either direction: one null version and the answer is false.
 */
export function updateStateFor(facts: UpdateFacts): UpdateState {
  const { runningVersion, installedVersion } = facts
  const pending = !!runningVersion && !!installedVersion && runningVersion !== installedVersion

  let eligible = true
  let reason: string | null = null
  if (facts.adapterId !== 'claude' || !facts.resumeId) {
    eligible = false
    reason = 'no conversation to resume'
  }
  /*
   * For a Codex card, say what Codex knows as well, because "not eligible" on its own reads as
   * Garden having nothing to say about a card that is in fact a version behind.
   */
  if (facts.adapterId === 'codex' && facts.codex) {
    const latest = facts.codex.latestVersion
    if (latest && installedVersion && latest !== installedVersion) {
      reason = facts.codex.dismissedVersion === latest
        ? `no conversation to resume, and Codex records ${latest} as available and dismissed`
        : `no conversation to resume, and Codex records ${latest} as available`
    }
  }

  return {
    runningVersion,
    installedVersion,
    /*
     * A Codex card is never pending, per canon, even when the two versions differ. The point of the
     * flag is that a restart would gain something, and for a card that cannot be resumed it would
     * cost the whole conversation. Its state is still honest: the versions are reported and the
     * reason is on the card.
     */
    updatePending: facts.adapterId === 'claude' ? pending : false,
    updateEligible: eligible,
    updateReason: reason,
  }
}

/** Everything the boundary check looks at. Gathered by the caller, so this stays a pure answer. */
export interface BoundaryFacts {
  /** The pid Garden holds for the card's shell, or null when nothing is running. */
  pid: number | null
  /** Live descendants of that pid, found in the process table BEFORE anything is killed. */
  children: number[]
  /** When the card was last given input, from its own events. */
  lastInputAt: number | null
  /** When the CLI last said the turn was over. */
  lastStopAt: number | null
  /** Tool calls started since the last input with no result recorded. */
  openTools: number
  /** File claims this card holds, by path. */
  claims: string[]
  /** True when the composer has had keystrokes since the last submit. */
  composerDirty: boolean
  /** True when a permission or authentication prompt is on screen. */
  promptOpen: boolean
}

const SENTENCES: Record<BoundaryBlocker, string> = {
  'not-running': 'there is no process to restart.',
  'prompt-open': 'a permission or authentication prompt is on screen, and only the owner answers those.',
  'composer-dirty': 'the composer has had keystrokes since the last submit, and a raw terminal draft cannot be read back, so it has to be assumed there is one.',
  'tool-open': 'a tool call was started and its result has not been recorded.',
  'mid-turn': 'the card has not finished the turn it is on.',
  'child-running': 'something this card started is still running.',
  'claim-held': 'the card holds a file claim its checkpoint does not say to keep.',
}

/**
 * Safe, or the first reason it is not.
 *
 * Ordered by what the owner most needs to know rather than by what is cheapest to check: a prompt
 * on screen is a person's decision, a dirty composer is words nobody has sent yet, and both of
 * those matter more than a build still running. One blocker rather than a list, because the card
 * face has room for one sentence and a card that is blocked for four reasons is blocked.
 *
 * Silence is deliberately not a boundary. A card whose terminal has been quiet for a minute may be
 * waiting on a build, a test, an import, a deployment, or a child that does not survive its parent,
 * which is why `children` is measured from the process table and not inferred from the terminal
 * being still. That children survive a kill of the pty is measured, not assumed: see section 6 of
 * the evidence file.
 */
export function boundaryFrom(facts: BoundaryFacts): BoundaryResult {
  const checked = {
    pid: facts.pid,
    children: facts.children,
    lastInputAt: facts.lastInputAt,
    lastStopAt: facts.lastStopAt,
    openTools: facts.openTools,
    claims: facts.claims,
  }
  const answer = (blocker: BoundaryBlocker | null): BoundaryResult => ({
    safe: blocker === null,
    blocker,
    reason: blocker === null ? 'nothing is in the way.' : SENTENCES[blocker],
    checked,
  })

  if (!facts.pid) return answer('not-running')
  if (facts.promptOpen) return answer('prompt-open')
  if (facts.composerDirty) return answer('composer-dirty')
  if (facts.openTools > 0) return answer('tool-open')
  /*
   * A turn is over when the CLI said so after the last input. A card that has never been given
   * input has no turn to be mid-way through, which is why the missing `lastInputAt` is safe and the
   * missing `lastStopAt` is not.
   */
  if (facts.lastInputAt !== null && (facts.lastStopAt === null || facts.lastStopAt < facts.lastInputAt)) {
    return answer('mid-turn')
  }
  if (facts.children.length > 0) return answer('child-running')
  if (facts.claims.length > 0) return answer('claim-held')
  return answer(null)
}

/** What a checkpoint says. Every field is one canon 21 names, and there are no others. */
export interface CheckpointFacts {
  cardId: string
  cardTitle: string
  generation: number
  claudeSessionId: string | null
  transcriptPath: string | null
  adapterId: string
  executable: string | null
  runningVersion: string | null
  installedVersion: string | null
  configDir: string
  cwd: string
  taskId: string | null
  taskState: string | null
  acceptanceRef: string | null
  nextAction: string | null
  changedPaths: string[]
  openClaims: string[]
  operations: string[]
  pendingMailIds: string[]
  uncertainInput: string | null
}

/**
 * The checkpoint, written where canon says and in the shape canon lists.
 *
 * It references and never copies: a transcript path rather than a transcript, an acceptance file
 * rather than its contents. And it carries no token, no key and no environment secret, which is not
 * only a rule about what to leave out. The CLI's registry keeps a peer token in a file beside the
 * entry this card's version came from, so the one place a secret could get in is the one place this
 * writer reads from, and it takes only the fields on `CheckpointFacts`.
 *
 * Nothing calls this automatically. It is callable so it can be exercised and so the owner can read
 * what a checkpoint would say before anything is ever restarted on the strength of one.
 */
export function writeCheckpoint(dir: string, facts: CheckpointFacts): { path: string; fields: string[] } {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'CHECKPOINT.md')
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- none')
  const line = (label: string, value: string | number | null) => `- ${label}: ${value ?? 'not known'}`

  const body = [
    `# Checkpoint: ${facts.cardTitle}`,
    '',
    'Written before a restart was asked for, so this card can be handed back what it was doing.',
    'It references its transcript and its acceptance file rather than copying them, and it carries',
    'no token, key or environment value.',
    '',
    '## Which card, and which process',
    line('card', facts.cardId),
    line('generation', facts.generation),
    line('conversation', facts.claudeSessionId),
    line('transcript', facts.transcriptPath),
    line('adapter', facts.adapterId),
    line('executable', facts.executable),
    line('running version', facts.runningVersion),
    line('installed version', facts.installedVersion),
    line('config directory', facts.configDir),
    line('working directory', facts.cwd),
    '',
    '## The work',
    line('task', facts.taskId),
    line('stage', facts.taskState),
    line('measured against', facts.acceptanceRef),
    line('next action', facts.nextAction),
    '',
    '## What is open',
    '### Changed paths',
    list(facts.changedPaths),
    '### Claims held',
    list(facts.openClaims),
    '### Operations in flight',
    list(facts.operations),
    '### Mail waiting',
    list(facts.pendingMailIds),
    line('input whose acceptance is uncertain', facts.uncertainInput),
    '',
  ].join('\n')

  writeFileSync(path, body, 'utf8')
  return {
    path,
    fields: [
      'card', 'generation', 'conversation', 'transcript', 'adapter', 'executable',
      'running version', 'installed version', 'config directory', 'working directory',
      'task', 'stage', 'measured against', 'next action',
      'changed paths', 'claims held', 'operations in flight', 'mail waiting',
      'input whose acceptance is uncertain',
    ],
  }
}

/** The JSON twin, for the store, with exactly the same facts and the same omissions. */
export function checkpointRecord(facts: CheckpointFacts, path: string): Record<string, unknown> {
  return { ...facts, path, writtenAt: Date.now() }
}

/** Kept beside the writer so a caller cannot accidentally hand a session object straight in. */
export function checkpointFactsFrom(
  session: TerminalSession,
  extra: Omit<CheckpointFacts, 'cardId' | 'cardTitle' | 'generation' | 'claudeSessionId' | 'transcriptPath' | 'adapterId' | 'cwd'>,
): CheckpointFacts {
  return {
    cardId: session.id,
    cardTitle: session.title,
    generation: session.generation,
    claudeSessionId: session.claudeSessionId,
    transcriptPath: session.transcriptPath,
    adapterId: session.adapterId,
    cwd: session.cwd,
    ...extra,
  }
}
