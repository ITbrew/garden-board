import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { AdapterId, Profile } from '@garden/shared'
import { DATA_DIR } from './store.js'
import { approvalMode } from './hooks-install.js'

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

/**
 * PATH entries the registry has and this process does not, appended to the end.
 *
 * Windows hands a process its PATH once, at spawn, and never updates it. The Garden server runs for
 * days, so a tool the owner installs after the board came up is invisible to every card the server
 * launches: `baseEnv` copies `process.env`, and the server's copy predates the install. Reported as
 * "codex cards arent woring even tho i installed cli" (owner, 2026-09-18), and it was exactly that:
 * `codex.exe` was on disk and in the user PATH, `Get-Command codex` found nothing in the server's
 * tree, and a card got `'codex' is not recognized`. Two other entries were missing the same way
 * (`...\Local\Unity\bin` and `.dotnet\tools`), so this was never only about Codex.
 *
 * APPEND ONLY, and that is the whole safety argument. Nothing is removed and nothing is reordered,
 * so every name that resolves today resolves to the same file afterwards; the only possible change
 * is that a name which previously resolved to nothing now resolves to something. A refresh that
 * rebuilt PATH from the registry would be more correct and would also drop whatever the launcher
 * added for its own reasons, which is not a trade worth making inside a card launch.
 *
 * Read on every launch rather than cached, because the point is to notice a change made while the
 * server was running, and a cache is the bug again with a shorter clock. `reg query` twice costs
 * tens of milliseconds against a launch that takes seconds.
 *
 * Any failure returns the process PATH unchanged. A card that starts with a slightly short PATH is
 * a nuisance; a card that does not start because an environment probe threw is an outage.
 */
function pathWithRegistryAdditions(): string {
  const current = process.env.Path ?? process.env.PATH ?? ''
  if (!isWin) return current
  try {
    const read = (root: string, key: string): string => {
      const out = execFileSync('reg', ['query', root, '/v', key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      // "    Path    REG_EXPAND_SZ    C:\a;C:\b"  — the value is whatever follows the type.
      const m = out.match(/\s+Path\s+REG(?:_EXPAND)?_SZ\s+(.*)/i)
      return m ? m[1].trim() : ''
    }
    // A REG_EXPAND_SZ value holds %SystemRoot% and friends literally; the process would have had
    // them expanded at spawn, so expand them the same way before comparing or nothing matches.
    const expand = (s: string) =>
      s.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)

    const machine = read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path')
    const user = read('HKCU\\Environment', 'Path')

    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
    const have = new Set(current.split(';').filter(Boolean).map(norm))
    const extra: string[] = []
    for (const entry of expand(`${machine};${user}`).split(';')) {
      const e = entry.trim()
      if (!e || have.has(norm(e))) continue
      have.add(norm(e))
      extra.push(e)
    }
    return extra.length ? `${current};${extra.join(';')}` : current
  } catch {
    return current
  }
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v

  /*
   * Exactly one spelling reaches the child.
   *
   * Windows treats PATH and Path as one variable; a Record in Node does not, and which spelling
   * `process.env` reports depends on who started the server (this server, launched under Git Bash,
   * reports PATH; launched from Explorer it reports Path). Writing one and leaving the other is how
   * a child gets handed two PATHs that disagree, and which one wins is not ours to decide. So on
   * Windows every spelling is removed and a single `Path` is set. On POSIX the names are genuinely
   * different variables and only PATH means anything.
   */
  const refreshed = pathWithRegistryAdditions()
  if (refreshed) {
    if (isWin) {
      for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k]
      env.Path = refreshed
    } else {
      env.PATH = refreshed
    }
  }
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
  return `${resumeArg(extraEnv)}${settingsArg(extraEnv)}${pluginArg(extraEnv)}${briefArg(extraEnv)}${autocompactArg()}${modeArg()}`
}

/**
 * The permission mode, forced on the command line as well as set as the settings default.
 *
 * A resumed conversation restores the mode recorded in its own transcript, and that wins over
 * `defaultMode`. Measured on the owner's board after he chose no approval prompts: this card's settings
 * file said bypassPermissions, its transcript held `"type":"permission-mode","permissionMode":"auto"`
 * entries, and every hook after the relaunch reported auto. Every card resumes, so without this the
 * choice would only ever reach brand new cards. Canon 01 revision 3.
 */
function modeArg(): string {
  return ` --permission-mode ${approvalMode()}`
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

/**
 * The two folders outside Codex's workspace sandbox that a card has to write, added by name.
 *
 * Its own mailbox, where a message is written before `garden-send` carries it, and the project's
 * `.claude/sessions`, where a claim file goes. On 23 September both Codex cards in the validation
 * run lost their whole task to "retry without sandbox?" on their claim file, a prompt no one was
 * there to answer. The owner chose named folders over turning the sandbox off. Proved with one real
 * `codex exec` in a throwaway project outside the temp folder: the mailbox write was "rejected:
 * writing outside of the project" without this and written with it.
 *
 * TOML literal strings (single quotes), doubled for the single-quoted PowerShell string around them.
 */
function codexWritable(cwd: string, extraEnv?: Record<string, string>): string {
  if (!isWin) return ''
  const roots = [extraEnv?.GARDEN_MAIL_DIR, cwd ? join(cwd, '.claude', 'sessions') : undefined]
    .filter((p): p is string => !!p && !p.includes("'"))
    .map((p) => `''${p.replace(/\//g, '\\')}''`)
  return roots.length ? ` -c 'sandbox_workspace_write.writable_roots=[${roots.join(',')}]'` : ''
}

/**
 * Stop the CLI asking a card a question nobody is there to answer.
 *
 * Canon 12 already holds the rule: anything that would stop a card to ask a human must be settled
 * before the card starts. A Codex card that opens on a chooser is not slow, it is stuck, and the
 * owner finds out when the work did not happen. Worse, what gets sent to that card goes into the
 * chooser instead of into a prompt. Measured 2026-09-29: a card was sent "reply with the single
 * word: ok", the CLI quit, and the PowerShell behind it ran the tail of the line and answered with
 * a CommandNotFoundException. That reads as an input bug and is not one, which is the most
 * expensive kind of failure to have.
 *
 * **The update chooser is settled here.** `check_for_update_on_startup=false` for the cards Garden
 * launches and for nothing else: the owner's own `codex` still offers him the update, which is
 * where that offer belongs, because a person can answer it and a card cannot. Updating a CLI
 * underneath a board full of running cards is also not something a startup chooser should decide.
 * `GARDEN_CODEX_QUIET=0` turns it off.
 *
 * **The trust chooser is settled here too**, by `codexTrust` below. `GARDEN_CODEX_QUIET=0` turns
 * this one off as well, since both exist for the same reason and a card being debugged wants the
 * CLI's own unmodified startup. Canon 03.
 */
/**
 * No approval prompts on a Codex card either, when that is what the owner chose at first launch. Codex
 * does not read Claude's settings, so "never-ask" is its own flags: never ask, and no sandbox, which
 * is the Codex equivalent of Claude's bypass mode. Auto leaves Codex's defaults alone. Canon 01
 * revision 3.
 */
function codexApprovals(): string {
  return approvalMode() === 'bypassPermissions' ? ' --dangerously-bypass-approvals-and-sandbox' : ''
}

function codexQuiet(): string {
  if (!isWin) return ''
  if (process.env.GARDEN_CODEX_QUIET === '0') return ''
  return ` -c 'check_for_update_on_startup=false'`
}

/**
 * Trust the folder this card was hired into, through a config file rather than the launch line.
 *
 * "Trust this folder? 1. Trust and continue / 2. Quit" is the second chooser a Codex card opens on,
 * and the owner's answer was the obvious one: "im the admin ofc it is trusted". He had already
 * answered it for eleven other folders; `C:\Garden` was never one of them, and a card with an
 * account bound gets its own `CODEX_HOME` anyway, so it meets a blank config however many times he
 * has answered elsewhere.
 *
 * **`-c` cannot say this, and two shipped versions claimed otherwise.** It takes a bare dotted key
 * and nothing else: `-c projects.'<path>'.trust_level='trusted'` does not work, as a TOML literal
 * string or as a basic string, measured both ways against 0.158.0. The unquoted
 * `-c projects.c:\garden.trust_level=trusted` does work, and only because that path has no dot to
 * split the key on and no space to split the argument on. Every version of this was tested against
 * `C:\Garden`, which has neither, which is exactly why it looked settled twice.
 *
 * It was also worse than not working. On a path with a space PowerShell splits the override in two,
 * the CLI exits on the malformed argument, and the shell behind it drops to a prompt, which is the
 * original Codex failure this whole area exists to prevent. Measured on `gtest 0.5 stable`: the
 * file settles it, the override exits with 562 bytes and never reaches a prompt.
 *
 * So the entry goes in `<config home>/garden.config.toml` and the card launches with `-p garden`,
 * which layers that file on top of the base user config. No shell touches the path at any point.
 *
 * **Where it is written.** A card with an account bound has its own `CODEX_HOME` under
 * `~/.garden/profiles/<id>/codex/`, which is Garden's. A card without one falls back to the owner's
 * `~/.codex/`, and this writes there too. It is a NEW file beside his config rather than an edit to
 * it, and it is inert unless `-p garden` is passed, so his own `codex` is untouched in every
 * respect. A `garden.config.toml` that Garden did not write is left alone and the card launches
 * without the flag, because overwriting a file somebody else made is not a thing this does even to
 * fix itself.
 *
 * Lowercased, because that is how the CLI stores its own answers: every `projects.*` key in the
 * owner's config is lowercase, and a lowercase key settles the question for a folder spelled
 * `C:\Garden`, so it lowercases before it compares.
 */
/**
 * The layered profile Garden writes and loads. `-p <name>` reads `$CODEX_HOME/<name>.config.toml`
 * on top of the base user config, so the name is also a filename in a directory that may be the
 * owner's own.
 */
const TRUST_PROFILE = 'garden'

function codexTrust(cwd: string, configHome: string): string {
  if (!isWin) return ''
  if (process.env.GARDEN_CODEX_QUIET === '0') return ''
  if (!cwd) return ''
  const path = cwd.replace(/\//g, '\\').toLowerCase()
  const file = join(configHome, `${TRUST_PROFILE}.config.toml`)
  /*
   * A marker line, so a later launch can tell a file this wrote from one the owner put there. The
   * check is on the marker and not on the filename, because the whole point is that the name could
   * belong to somebody else.
   */
  const marker = '# written by Garden, safe to delete'
  /*
   * A TOML literal string for the key, which takes no escapes, so a Windows path goes in exactly as
   * it is. A path containing a single quote cannot be written this way and is skipped, the same rule
   * `codexWritable` uses: the card asks the trust question rather than Garden guessing at an
   * escaping it has not tested.
   */
  if (path.includes("'")) return ''
  const entry = `[projects.'${path}']\ntrust_level = "trusted"\n`
  try {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (before && !before.startsWith(marker)) return ''
    mkdirSync(configHome, { recursive: true })
    /*
     * Added to what is already there, never replacing it.
     *
     * Two Codex cards on two different boards share a config home whenever neither has an account
     * bound, because both fall back to the CLI's default. Writing only the current folder meant the
     * second launch erased the first one's answer: the running card would not notice, having read
     * its config at startup, and the next launch of it would meet the chooser again for no visible
     * reason. Found with a scratch folder sitting alone in the owner's own file, having displaced
     * whatever preceded it.
     */
    if (before.includes(`[projects.'${path}']`)) return ` -p ${TRUST_PROFILE}`
    writeFileSync(file, before ? `${before.trimEnd()}\n\n${entry}` : `${marker}\n${entry}`, 'utf8')
  } catch {
    // A config home that cannot be written is not worth failing a launch over. The card comes up on
    // the chooser, which is the behaviour before any of this existed.
    return ''
  }
  return ` -p ${TRUST_PROFILE}`
}

export const codexAdapter: CLIAdapter = {
  id: 'codex',
  label: 'Codex',
  configDirFor: (profile) => profile.configDir || join(DATA_DIR, 'profiles', profile.id, 'codex'),
  launch(cwd, profile, extraEnv) {
    const env = { ...baseEnv(), ...extraEnv }
    if (profile) env.CODEX_HOME = this.configDirFor(profile)
    /*
     * Where the trust file goes, which is wherever this card's CLI will actually look. A bound card
     * has its own config home under `~/.garden/profiles`; an unbound one falls back to the CLI's
     * default, the owner's `~/.codex`, because that is what the CLI does when `CODEX_HOME` is unset.
     */
    const configHome = env.CODEX_HOME || join(homedir(), '.codex')
    const start = `codex${codexQuiet()}${codexApprovals()}${codexTrust(cwd, configHome)}${codexWritable(cwd, extraEnv)}${codexBrief(extraEnv)}`
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
