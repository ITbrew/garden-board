import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { AdapterId, Profile } from '@garden/shared'
import { DATA_DIR } from './store.js'

export interface LaunchSpec {
  file: string
  args: string[]
  env: Record<string, string>
}

/**
 * A CLI adapter turns (project cwd, profile) into a command line. The renderer never supplies
 * any part of this, which is the whole point: an id is not an executable.
 */
export interface CLIAdapter {
  id: AdapterId
  label: string
  /** Where this adapter keeps a profile's config, so accounts stay isolated. */
  configDirFor(profile: Profile): string
  launch(cwd: string, profile: Profile | null, extraEnv?: Record<string, string>): LaunchSpec
}

const isWin = process.platform === 'win32'

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  // Strip Garden's own config scoping so a child never inherits the wrong account by accident.
  delete env.CLAUDE_CONFIG_DIR
  delete env.CODEX_HOME

  /*
   * A session Garden launches is its own session, not a child of whatever started Garden.
   *
   * When the server is started from inside a Claude Code session, its environment carries that
   * session's markers, and every terminal Garden then spawns inherits them. The CLI reads the
   * child marker and turns transcript saving OFF, printing "Transcript saving is off, inherited
   * CLAUDE_CODE_CHILD_SESSION marker" in its own footer. That is why transcripts for
   * Garden-launched sessions were never appearing on disk, which in turn is why the context gauge
   * had nothing to read: the file it was waiting for was never going to be written.
   *
   * Found by capturing a live session's terminal buffer and reading the warning the CLI was
   * printing all along.
   */
  delete env.CLAUDE_CODE_CHILD_SESSION
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CLAUDE_CODE_ENTRYPOINT

  /*
   * The same trap as the markers above, one layer along.
   *
   * Every other GARDEN_ variable is set on every launch, so an inherited copy is always overwritten
   * and inheriting them is the point: a hook five processes down still knows which card it belongs
   * to. GARDEN_RESUME is the exception, because it is set only when there is something to resume.
   * When there is not, an inherited value is not overwritten, it is obeyed. Start the Garden server
   * from inside a card's own shell and every new card on the board would open into that card's
   * conversation, which is the loudest possible version of the bug this whole change exists to fix.
   */
  delete env.GARDEN_RESUME
  // And its companion, for the same reason and one step worse: this one is only ever ABSENT when
  // the answer is no, so an inherited copy is never overwritten by anything.
  delete env.GARDEN_RESUME_FORK
  return env
}

export const shellAdapter: CLIAdapter = {
  id: 'shell',
  label: 'Shell',
  configDirFor: () => '',
  launch(cwd, _profile, extraEnv) {
    return {
      file: isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'),
      args: isWin ? ['-NoLogo'] : [],
      env: { ...baseEnv(), ...extraEnv, GARDEN_CWD: cwd },
    }
  },
}

/**
 * Garden's own settings file, holding nothing but its observer hooks.
 *
 * Passed with `--settings`, which merges with every other settings layer instead of replacing
 * them, so the owner's 23 guards and his account check keep running untouched. Quoted because
 * this path can contain spaces on a normal Windows install.
 */
function settingsArg(extraEnv?: Record<string, string>): string {
  // A session's own file when it has one, so its permissions travel with it, and the shared file
  // otherwise. Both carry the same hooks; only the deny list differs.
  const file = extraEnv?.GARDEN_SESSION_SETTINGS || process.env.GARDEN_HOOK_SETTINGS
  return file ? ` --settings '${file.replace(/\\/g, '/')}'` : ''
}

/**
 * The auto-compact window, forced on the command line rather than left to the settings layers.
 *
 * The owner set `autoCompactWindow` to 250000 in his USER settings and no card ever saw it. The
 * reason is two functions below this one: `pluginArg` passes `--setting-sources project`, which is
 * what stops each card seeing every other project's skills, and the same flag drops the user layer
 * entirely. So the one place he had configured it was the one layer a Garden card does not read.
 *
 * A flag outranks every settings layer, so this holds regardless of which sources are enabled and
 * regardless of what any project's `.claude/settings.json` happens to say. It also survives a
 * resume, which the in-session `/autocompact` command does not: that command writes to the user
 * config dir, which is the dropped layer, so its value is gone the next time the card starts.
 *
 * `GARDEN_AUTOCOMPACT` overrides it, and `off` removes the flag and hands the decision back to the
 * settings layers. The CLI accepts `auto` or a token count.
 */
function autocompactArg(): string {
  const want = process.env.GARDEN_AUTOCOMPACT ?? '400000'
  if (want === 'off') return ''
  // Only `auto` or a plain token count. Anything else is not going near a shell command line, and
  // a bad value here would take every card on the board down at once.
  if (!/^(auto|\d{4,8}|\d{2,4}k)$/i.test(want)) return ''
  return ` --autocompact ${want}`
}

/**
 * The conversation this card already had, if it still exists.
 *
 * A card is a durable thing: it keeps its id, its role, its notes directory and its inbox across
 * being turned off and on. Its conversation was the one part that did not, because the launch was
 * a bare `claude`. So turning a card back on produced a session that had never heard of the work
 * the card was in the middle of, and the `claudeSessionId` Garden had been recording all along was
 * used for attribution and nothing else.
 *
 * The id is only ever handed over by `startSession`, and only after it has checked that the
 * transcript is on disk. Passing an id whose conversation is gone does not fail quietly: the CLI
 * exits with an error and the card is left sitting at a bare shell prompt, which looks exactly
 * like a crash. Not resuming is a worse outcome than resuming, but a card that lies about which
 * conversation it is in is worse than both.
 */
function resumeArg(extraEnv?: Record<string, string>): string {
  const id = extraEnv?.GARDEN_RESUME
  // A session id is a uuid. Anything else is not going near a shell command line.
  if (!id || !/^[0-9a-fA-F-]{8,64}$/.test(id)) return ''
  /*
   * `--fork-session` when something else is already sitting in that conversation.
   *
   * The CLI will not put two processes in one session, and it does not degrade gracefully: it
   * prints "Session ... is currently running as a background agent (bg)", suggests this exact flag,
   * and exits, leaving the card at a bare shell prompt. Which is what a Garden restart produces,
   * because a session the CLI has moved into its own daemon is not in the process tree Garden kills.
   *
   * The branch carries every turn up to now and gets a new id of its own, so the card comes back
   * with its work in front of it instead of empty. The decision is made in `startSession`, which is
   * the only place that can see the CLI's registry; this just spells it.
   */
  return extraEnv?.GARDEN_RESUME_FORK === '1' ? ` --resume ${id} --fork-session` : ` --resume ${id}`
}

/** A path on a command line built as a string. Windows installs have spaces in them. */
function quoted(path: string): string {
  return `'${path.replace(/\\/g, '/')}'`
}

/**
 * The card's own directory, loaded as a plugin for this session only.
 *
 * This is the one mechanism that makes skills, agent definitions and hooks per CARD rather than per
 * machine. Skill discovery is otherwise fixed to the working directory and the user config
 * directory, and every card on a board shares one working directory, so without this every card saw
 * every skill installed anywhere, including other projects' entirely.
 *
 * Only passed when the directory really is a plugin. A `--plugin-dir` pointing at a directory with
 * no manifest is an error the owner would meet as a card that will not start, and a card that
 * starts with a generic skill set is a smaller failure than a card that does not start at all.
 */
function pluginArg(extraEnv?: Record<string, string>): string {
  const dir = extraEnv?.GARDEN_MEMORY_DIR
  if (!dir || !existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return ''
  /*
   * `--plugin-dir` only ADDS. Measured against the installed CLI rather than assumed: a session
   * given a plugin directory holding one invented skill could see that skill AND the machine's
   * user-level ones, so "its own skills" was half a claim.
   *
   * `--setting-sources project` is what makes it the whole claim. It drops the user layer, which is
   * where another project's skills live, and keeps the project layer, which is where this project's
   * guards live. Dropping project as well would take the guards with it, and safety is not
   * tailored. Verified that a `--settings` file's hooks still fire alongside it, because if they
   * did not this flag would take every card on the board dark at once.
   */
  return ` --plugin-dir ${quoted(dir)} --setting-sources project`
}

/**
 * The card's brief, at the system prompt level rather than through the startup hook.
 *
 * It used to travel as one section of the `SessionStart` hook's `additionalContext`, sharing a
 * 10,000 character ceiling with five other sections and holding a 3000 character allowance of its
 * own. Measured on 2026-08-14: a real boss brief was 5236 characters and lost 43% of itself, a real
 * manager brief was 7410 and lost 60%, and what fell off the end was the reporting rules and the
 * standards. The cut announced itself in a trailing note naming the file, which nothing ever
 * followed, because a note that names a path without saying what is in it is not an instruction.
 *
 * There is no budget on this route, so the brief arrives whole however long it grows.
 */
function briefArg(extraEnv?: Record<string, string>): string {
  const dir = extraEnv?.GARDEN_MEMORY_DIR
  if (!dir) return ''
  const file = join(dir, 'CLAUDE.md')
  return existsSync(file) ? ` --append-system-prompt-file ${quoted(file)}` : ''
}

/**
 * The whole command line after `claude`, in one place so both platforms build the same thing.
 *
 * Order is resume, settings, plugin, brief, autocompact. Nothing here depends on order, and keeping it fixed
 * means a launch can be compared against a recorded one by string equality.
 */
function claudeArgs(extraEnv?: Record<string, string>): string {
  return `${resumeArg(extraEnv)}${settingsArg(extraEnv)}${pluginArg(extraEnv)}${briefArg(extraEnv)}${autocompactArg()}`
}

export const claudeAdapter: CLIAdapter = {
  id: 'claude',
  label: 'Claude Code',
  /*
   * CLAUDE_CONFIG_DIR scopes credentials and settings, which is the only supported way to run
   * two accounts side by side.
   *
   * A profile that already names a directory wins. Discovered accounts point at directories the
   * owner is ALREADY signed in to, and an earlier version ignored that and computed a fresh
   * Garden-managed path instead. The session then launched into an empty, signed-out directory,
   * which is exactly why every new window started by asking which account to use.
   */
  configDirFor: (profile) => profile.configDir || join(DATA_DIR, 'profiles', profile.id, 'claude'),
  launch(cwd, profile, extraEnv) {
    const env = { ...baseEnv(), ...extraEnv }
    /*
     * Tell the startup hook the brief is already on the command line, so it does not send a second
     * truncated copy. Two copies of the same instructions, one of them cut off mid-sentence, is
     * worse than either alone: the card cannot tell which is authoritative.
     */
    if (briefArg(extraEnv)) env.GARDEN_BRIEF_DELIVERED = '1'
    if (profile) {
      const dir = this.configDirFor(profile)
      env.CLAUDE_CONFIG_DIR = dir
      /*
       * This machine puts an account shim in front of the CLI, which picks a config directory
       * from the current folder and asks when the folder maps to nothing. Asking is right in a
       * terminal the owner is sitting at, and wrong here: a card spawned by an agent would stop
       * dead on a question nobody is watching. Garden already knows which account this project is
       * bound to, so it names it through the shim's own documented override rather than leaving
       * it to be guessed or asked. A machine without the shim ignores this variable entirely.
       */
      env.CLAUDE_ACCOUNT = dir
    }
    return {
      // Launched through a shell so the CLI is resolved from PATH the same way it is in a
      // normal terminal, and so the user keeps a shell to return to when it exits.
      file: isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'),
      args: isWin
        ? ['-NoLogo', '-NoExit', '-Command', `claude${claudeArgs(extraEnv)}`]
        : ['-lc', `claude${claudeArgs(extraEnv)}; exec $SHELL`],
      env,
    }
  },
}

/**
 * The one line that tells a Codex card it is on a board.
 *
 * A Claude card learns who it is and who it may talk to from the `SessionStart` hook, which injects
 * its roots, its powers and its wire list before it does anything. Codex has no such hook, so a
 * Codex card was launched knowing nothing: Garden wrote its `PEERS.md`, its `POWERS.md` and its
 * outbox, wired it to the orchestrator on the board, and never once mentioned any of it. The owner
 * asked it to message the orchestrator and it answered, in its own terminal:
 *
 *   I tried again, but this session still exposes no Wire messaging endpoint or orchestrator
 *   recipient. Nothing was sent, and I won't claim otherwise.
 *
 * Which is the correct answer to the question it was actually able to see. The wire worked, the
 * mailbox existed, and the card had no way of knowing.
 *
 * Codex takes an optional prompt as its first positional argument, which is the only per-launch
 * briefing route it documents. So the prompt is kept to a pointer and the substance stays in the
 * files, exactly as it does for a Claude card: the files are already written, already per card, and
 * already correct. Short also matters because this costs a turn on every start.
 *
 * Written with no apostrophes and no double quotes on purpose. It travels inside a single-quoted
 * PowerShell string, and a quote in there is the same class of failure the send shim carries three
 * paragraphs of comment about.
 */
function codexBrief(extraEnv?: Record<string, string>): string {
  /*
   * `GARDEN_CODEX_BRIEF=0` starts a Codex card without it, the same way `GARDEN_CONPTY_DLL=0` exists.
   *
   * A prompt makes the session take a turn the moment it opens, which is right for a card that has
   * to know who it is and wrong for a harness that only needs a process. Without this, every test
   * that starts a Codex card would quietly begin spending the owner's tokens.
   */
  if (process.env.GARDEN_CODEX_BRIEF === '0') return ''
  const dir = extraEnv?.GARDEN_MAIL_DIR
  if (!dir) return ''
  const card = (extraEnv?.GARDEN_CARD ?? 'a card').replace(/['"]/g, '')
  const where = dir.replace(/\\/g, '/')
  const brief =
    `You are the Garden card called ${card}. Before anything else, read PEERS.md and POWERS.md in ` +
    `${where}. They name the cards you are wired to and give the exact command for sending a ` +
    `message along a wire. Your INBOX.md in the same folder is where messages to you arrive. Do no ` +
    `other work yet. Reply with one short line saying what you may talk to.`
  return ` '${brief}'`
}

export const codexAdapter: CLIAdapter = {
  id: 'codex',
  label: 'Codex',
  configDirFor: (profile) => profile.configDir || join(DATA_DIR, 'profiles', profile.id, 'codex'),
  launch(cwd, profile, extraEnv) {
    const env = { ...baseEnv(), ...extraEnv }
    if (profile) env.CODEX_HOME = this.configDirFor(profile)
    const start = `codex${codexBrief(extraEnv)}`
    return {
      file: isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'),
      args: isWin ? ['-NoLogo', '-NoExit', '-Command', start] : ['-lc', `${start}; exec $SHELL`],
      env,
    }
  },
}

const ADAPTERS: Record<AdapterId, CLIAdapter> = {
  shell: shellAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
}

export function getAdapter(id: AdapterId): CLIAdapter {
  const a = ADAPTERS[id]
  if (!a) throw new Error(`unknown adapter: ${id}`)
  return a
}

export function isAdapterId(v: unknown): v is AdapterId {
  return v === 'shell' || v === 'claude' || v === 'codex'
}
