import { ensureRoots } from './roots.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { DATA_DIR } from './store.js'

export interface ContextEntry {
  /** Absolute path on disk. Produced by this scan, never by the renderer. */
  abs: string
  /** Shown on the card. */
  title: string
  /** Project-relative when inside the project, otherwise the absolute path. */
  display: string
  external: boolean
  group:
    | 'instructions'
    | 'memory'
    | 'research'
    | 'settings'
    | 'skills'
    | 'agents'
    | 'guards'
    | 'hooks'
  /**
   * How often this file is actually in play. Instructions and this card's own memory are read
   * every time; a skill or an agent definition is only used when something invokes it. Saying so
   * is the difference between a list of files and an honest picture of what shapes a session.
   */
  usage: 'always' | 'sometimes'
}

/**
 * The files a session actually runs from.
 *
 * This answers "what is this agent working from", which is currently invisible: the files are
 * scattered across a project folder and a user folder and nothing surfaces them together.
 *
 * Guards are read from `hooks/lib/registry.mjs` rather than from `settings.json`, because a
 * project can dispatch dozens of guards from that registry while `settings.json` mentions only
 * the dispatcher. Reading settings.json alone would show none of them.
 *
 * Guards and hooks are two different things and are kept apart deliberately. Guards are this
 * machine's own dispatched checks, which every session in the project inherits. Hooks are the
 * ones Garden itself wrote into this one card's settings file and handed to the CLI at launch,
 * so they are the only ones this card can be proven to be running.
 *
 * `cardId` is optional because the callers pass a memory directory and not an id. When it is
 * missing the id is recovered from that directory's name, and only when exactly one settings
 * file matches, because a half-matched id would put another card's hooks on this card.
 *
 * `ownedPaths` is the area this card is responsible for. Without it every card in a project got
 * the same roots, so a card hired to own one corner of the repository opened with the project's
 * generic instructions in front of it and none of its own code. With it the research column is
 * weighted toward that corner. What it never does is take the shared essentials away: the
 * instructions, this card's memory, settings, guards and hooks apply whatever the card owns, and
 * a specialist that cannot see the project it works in is worse off, not better.
 */
export function scanContext(
  projectPath: string,
  configDir?: string,
  memoryDir?: string,
  cardId?: string,
  ownedPaths?: string[] | null,
  /** Which role's roots apply to this card. Null means it has no role and gets only the shared one. */
  roleClass?: string | null,
): ContextEntry[] {
  const out: ContextEntry[] = []
  const userDir = configDir || join(homedir(), '.claude')
  const owned = resolveOwned(projectPath, ownedPaths)

  const add = (
    abs: string,
    title: string,
    group: ContextEntry['group'],
    usage: ContextEntry['usage'] = 'always',
  ) => {
    if (!existsSync(abs)) return
    try {
      if (!statSync(abs).isFile()) return
    } catch {
      return
    }
    const rel = relative(projectPath, abs)
    const external = rel.startsWith('..') || rel.includes(`..${sep}`)
    out.push({
      abs,
      title,
      display: external ? abs : rel.split(sep).join('/'),
      external,
      group,
      usage,
    })
  }

  /*
   * Instructions, and there is now exactly one of them.
   *
   * A card used to load the project's `CLAUDE.md`, the user's, and every other one between its
   * working directory and the filesystem root, which is why the owner said "each claude session gets
   * every .md ever created". Garden now excludes those per card, in the settings file it hands over
   * with `--settings`, and injects this one through the `SessionStart` hook instead. So this column
   * lists the card's own brief and nothing else, which is the truth about what it runs from.
   *
   * The shared files are deliberately not listed as unavailable or greyed out. They are still there
   * and still readable, a card simply is not given them; showing them here would say they are in
   * play, which is the kind of claim this project exists not to make.
   */
  const roots = ensureRoots(roleClass ?? null)
  add(roots.shared, 'ALL.md (every card)', 'instructions')
  if (roots.role) add(roots.role, `${roleClass}.md (this role)`, 'instructions')
  if (memoryDir) {
    add(join(memoryDir, 'CLAUDE.md'), 'CLAUDE.md (this card)', 'instructions')
  }

  // This card's own accumulated notes, which is what makes a role improve rather than start
  // from nothing every time it is turned on.
  if (memoryDir) {
    /*
     * Lessons are `always` because they are genuinely injected at startup now. Notes and playbook
     * are `sometimes` because they are named in ROOTS.md and opened when the task calls for it.
     *
     * All three used to be marked `always` while nothing loaded any of them: the hook named the
     * directory in one line and left the card to decide whether to look. A column claiming `always`
     * for a file nothing reads is the same overstatement this whole scan exists to avoid.
     */
    add(join(memoryDir, 'LESSONS.md'), 'LESSONS.md (this card)', 'memory')
    add(join(memoryDir, 'ROOTS.md'), 'ROOTS.md (what to read, when)', 'memory')
    add(join(memoryDir, 'NOTES.md'), 'NOTES.md (this card)', 'memory', 'sometimes')
    // The procedure this card has worked out for its own job, which is the part that makes a
    // long-lived card better at its spot than a fresh one.
    add(join(memoryDir, 'PLAYBOOK.md'), 'PLAYBOOK.md (this card)', 'memory', 'sometimes')
  }

  /*
   * Research: what the project knows, as opposed to what it instructs.
   *
   * Canon docs, worklogs, design notes and working papers. Marked as occasional because an agent
   * reads the one it needs rather than all of them, and capped, because a canon folder can hold
   * well over a hundred files and a column that long is not a column.
   */
  const RESEARCH_DIRS = [
    ['docs', 'canonical'],
    ['docs', 'agent-log'],
    ['docs', 'working'],
    ['docs', 'understanding'],
    ['docs', '0.6-design'],
    ['docs', 'failures'],
    ['docs', 'agents'],
    ['docs', 'research'],
    ['research'],
  ]
  const RESEARCH_CAP = 40
  let researchCount = 0
  const claimed = new Set<string>()
  const collectResearch = (dir: string, depth: number) => {
    if (researchCount >= RESEARCH_CAP || depth > 3) return
    for (const name of safeList(dir)) {
      if (researchCount >= RESEARCH_CAP) return
      const full = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) collectResearch(full, depth + 1)
      else if (/\.(md|markdown|txt)$/i.test(name)) {
        // Skipped only when the owned pass below already put this exact file on the card. With no
        // owned paths the set is empty and this walk behaves as it always did.
        if (claimed.has(full)) continue
        add(full, name.replace(/\.(md|markdown|txt)$/i, ''), 'research', 'sometimes')
        researchCount++
      }
    }
  }

  /*
   * The owned area goes in first and takes the larger half of the same budget.
   *
   * Order is the whole point. The column is capped, so whatever is added first is what survives,
   * and a specialist that has to scroll past thirty generic design notes to reach its own files is
   * in the same position as one with no area at all. Generic docs are therefore genuinely dropped
   * here: a card owning an area sees at most RESEARCH_CAP minus what its own area filled, which on
   * a project with a large docs folder means roughly sixteen of them instead of forty.
   *
   * The area's own source counts as research, not as instruction. It is what this card has to
   * understand rather than what it is told to do, which is the line this group already draws.
   */
  const OWNED_RESEARCH_CAP = 24
  if (owned.dirs.length > 0 || owned.files.length > 0) {
    const docs: string[] = []
    const code: string[] = []
    const walkOwned = (dir: string, depth: number) => {
      if (depth > 3) return
      for (const name of safeList(dir)) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        const full = join(dir, name)
        let isDir = false
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
        if (isDir) walkOwned(full, depth + 1)
        else if (/\.(md|markdown|txt)$/i.test(name)) docs.push(full)
        else if (CODE_EXT.test(name)) code.push(full)
      }
    }
    for (const dir of owned.dirs) walkOwned(dir, 0)
    for (const file of owned.files) {
      if (/\.(md|markdown|txt)$/i.test(file)) docs.push(file)
      else if (CODE_EXT.test(file)) code.push(file)
    }

    // Notes about the area before the area itself, because a document explaining why the code is
    // the shape it is saves more reading than any one file of the code does.
    for (const full of [...docs, ...code]) {
      if (researchCount >= OWNED_RESEARCH_CAP) break
      if (claimed.has(full)) continue
      const name = full.split(sep).pop() || full
      const isDoc = /\.(md|markdown|txt)$/i.test(name)
      add(full, isDoc ? name.replace(/\.(md|markdown|txt)$/i, '') : name, 'research', 'sometimes')
      claimed.add(full)
      researchCount++
    }
  }

  add(join(projectPath, 'README.md'), 'README', 'research', 'sometimes')

  /*
   * The routing documents go in ahead of the documents they route to.
   *
   * The walk is depth-first in directory order against a cap of 40, and canon on the 0.5 board is
   * 107 documents. Measured 2026-08-14: it filled the whole column inside `06-operators`, so nothing
   * from `07-ai-quality` or `08-presentation` appeared, and `docs/canonical/README.md` never
   * appeared at all, because it sits beside the numbered folders and the cap ran out before the walk
   * reached it. That file is the table of contents this project's own instructions say to read
   * first, so the one document that would have made the other 66 findable was the one omitted.
   */
  for (const parts of RESEARCH_DIRS) {
    const dir = join(projectPath, ...parts)
    for (const name of ['README.md', 'INDEX.md']) {
      const file = join(dir, name)
      if (existsSync(file)) {
        add(file, `${parts[parts.length - 1]} contents`, 'research', 'sometimes')
        claimed.add(file)
        researchCount++
      }
    }
  }
  for (const parts of RESEARCH_DIRS) {
    const dir = join(projectPath, ...parts)
    if (existsSync(dir)) collectResearch(dir, 0)
  }

  // Settings layers, kept separate rather than merged, so it is obvious which file to change.
  add(join(projectPath, '.claude', 'settings.json'), 'settings.json (project)', 'settings')
  add(join(projectPath, '.claude', 'settings.local.json'), 'settings.local.json', 'settings')
  add(join(userDir, 'settings.json'), 'settings.json (user)', 'settings')

  /*
   * Skills and agent definitions are available but not automatically in play, so they are
   * marked as occasional rather than listed as though every session reads all of them.
   *
   * All three layers the CLI actually loads, not just the project one. Scanning the project
   * folder alone showed an empty column on a machine carrying a shelf of user level skills,
   * which reads as "this card has no skills" when the truth is the opposite. User level ones are
   * labelled the way CLAUDE.md (user) is, because a name on its own does not say which file a
   * change to it would have to touch.
   */
  const addSkills = (dir: string, suffix: string) => {
    for (const d of safeList(dir)) {
      add(join(dir, d, 'SKILL.md'), suffix ? `${d} ${suffix}` : d, 'skills', 'sometimes')
    }
  }
  /*
   * This card's own first, because they are the ones it is guaranteed to have.
   *
   * A card is launched with `--plugin-dir <memoryDir>` and `--setting-sources project`, so what is
   * in its own directory is added and the user layer is dropped. The user-level entries below are
   * therefore no longer in play for a card and are not listed. Project ones still are, because
   * excluding them would take this project's guards with them.
   */
  if (memoryDir) addSkills(join(memoryDir, 'skills'), '(this card)')
  addSkills(join(projectPath, '.claude', 'skills'), '')
  for (const p of pluginSkillDirs(projectPath, userDir)) addSkills(p.dir, `(${p.plugin})`)

  const agentDirs = [
    ...(memoryDir ? [{ dir: join(memoryDir, 'agents'), suffix: ' (this card)' }] : []),
    { dir: join(projectPath, '.claude', 'agents'), suffix: '' },
  ]
  for (const { dir: agentsDir, suffix } of agentDirs) {
    if (!existsSync(agentsDir)) continue
    for (const f of safeList(agentsDir)) {
      if (f.endsWith('.md')) add(join(agentsDir, f), f.replace(/\.md$/, '') + suffix, 'agents', 'sometimes')
    }
  }

  for (const g of scanGuards(projectPath)) out.push(g)

  const id = cardId || (memoryDir ? cardIdFromMemoryDir(memoryDir) : null)
  if (id) {
    for (const h of sessionHookFiles(projectPath, id)) add(h.abs, h.title, 'hooks', h.usage)
  }

  return out
}

/** Folders that are on disk but are not this card's work: build output and dependencies. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git'])

/** What counts as the area's own source rather than an artefact sitting next to it. */
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|cs|java|rb|php|sql|css|scss|html|sh|ps1)$/i

/**
 * The owned paths that are real, split into folders and files.
 *
 * Two rules do the work here. A path that escapes the project is dropped, because an owned path is
 * declared project-relative and one that climbs out of the project is a mistake rather than a
 * claim. And a path that is not on disk is dropped, because this app does not show the owner a row
 * it cannot prove, and an owned path is a statement of intent that may name a folder nobody has
 * created yet.
 */
function resolveOwned(
  projectPath: string,
  ownedPaths?: string[] | null,
): { dirs: string[]; files: string[] } {
  const dirs: string[] = []
  const files: string[] = []
  if (!Array.isArray(ownedPaths)) return { dirs, files }
  const seen = new Set<string>()
  for (const raw of ownedPaths) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(projectPath, raw)
    const rel = relative(projectPath, abs)
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) continue
    if (seen.has(abs)) continue
    seen.add(abs)
    try {
      const st = statSync(abs)
      if (st.isDirectory()) dirs.push(abs)
      else if (st.isFile()) files.push(abs)
    } catch {
      continue
    }
  }
  return { dirs, files }
}

/** A short label for an owned folder, so two nested CLAUDE.md rows do not read as the same file. */
function shortRel(projectPath: string, abs: string): string {
  const rel = relative(projectPath, abs).split(sep).join('/')
  return rel === '' ? '.' : rel
}

/**
 * Where the plugins this project has actually switched on keep their skills.
 *
 * The marketplace folder holds every plugin that was ever offered, so listing it wholesale would
 * put dozens of skills on a card that cannot invoke a single one of them. Only the entries named
 * in an `enabledPlugins` block count, and only when the folder they name is really there.
 */
function pluginSkillDirs(projectPath: string, userDir: string): { dir: string; plugin: string }[] {
  const enabled = new Set<string>()
  const settingsFiles = [
    join(projectPath, '.claude', 'settings.json'),
    join(projectPath, '.claude', 'settings.local.json'),
    join(userDir, 'settings.json'),
  ]
  for (const file of settingsFiles) {
    const parsed = readJson(file)
    const block = isRecord(parsed) ? parsed.enabledPlugins : undefined
    if (!isRecord(block)) continue
    for (const [name, on] of Object.entries(block)) if (on !== false) enabled.add(name)
  }

  const out: { dir: string; plugin: string }[] = []
  for (const name of enabled) {
    // Written as plugin@marketplace. A bare name has no marketplace to look in, so it is skipped
    // rather than searched for under a guessed one.
    const at = name.lastIndexOf('@')
    if (at <= 0) continue
    const plugin = name.slice(0, at)
    const marketplace = name.slice(at + 1)
    const roots = [
      join(userDir, 'plugins', 'marketplaces', marketplace, 'plugins', plugin, 'skills'),
      join(userDir, 'plugins', 'marketplaces', marketplace, 'external_plugins', plugin, 'skills'),
      join(userDir, 'plugins', 'repos', marketplace, plugin, 'skills'),
    ]
    for (const dir of roots) if (existsSync(dir)) out.push({ dir, plugin })
  }
  return out
}

/**
 * The hooks this card is running, read from the settings file Garden handed the CLI for it.
 *
 * This file is the honest source: it is what the process was launched with, so anything in it is
 * loaded and anything absent from it is not. The scripts it names are resolved and confirmed on
 * disk, and a command whose script cannot be found is dropped, because a row pointing at nothing
 * is exactly the kind of painted-green claim this app exists to refuse.
 */
function sessionHookFiles(
  projectPath: string,
  cardId: string,
): { abs: string; title: string; usage: ContextEntry['usage'] }[] {
  const file = join(DATA_DIR, 'hooks', 'sessions', `${cardId}.json`)
  const parsed = readJson(file)
  if (!isRecord(parsed)) return []

  // Counted per script rather than listed per event, because one script answering fourteen events
  // is one file to open and fourteen identical rows would say nothing the first one did not.
  const events = new Map<string, Set<string>>()
  const hooks = parsed.hooks
  if (isRecord(hooks)) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        const list = isRecord(group) ? group.hooks : undefined
        if (!Array.isArray(list)) continue
        for (const entry of list) {
          if (!isRecord(entry) || typeof entry.command !== 'string') continue
          const abs = scriptFromCommand(entry.command, projectPath)
          if (!abs) continue
          const seen = events.get(abs) || new Set<string>()
          seen.add(event)
          events.set(abs, seen)
        }
      }
    }
  }

  const out: { abs: string; title: string; usage: ContextEntry['usage'] }[] = [
    // The settings file itself, so the owner can read the thing that was actually loaded rather
    // than take this column's word for what is in it.
    { abs: file, title: 'hook settings (this card)', usage: 'always' },
  ]
  for (const [abs, seen] of events) {
    const base = abs.split(/[\\/]/).pop() || abs
    const name = base.replace(/\.(mjs|js|cjs|ts|py|sh|ps1)$/i, '')
    out.push({
      abs,
      title: seen.size > 1 ? `${name} (${seen.size} events)` : `${name} (${[...seen][0]})`,
      // A hook fires on its own events without anyone invoking it, so it shapes every run.
      usage: 'always',
    })
  }
  return out
}

/**
 * The script a hook command runs, if there is one on disk.
 *
 * Commands are written as an interpreter plus a quoted path, so the quoted part is tried first;
 * an unquoted command falls back to whichever token looks like a script. Anything that resolves
 * to no real file returns null and the caller drops it.
 */
function scriptFromCommand(command: string, projectPath: string): string | null {
  const candidates: string[] = []
  for (const m of command.matchAll(/["']([^"']+)["']/g)) candidates.push(m[1]!)
  for (const token of command.split(/\s+/)) {
    if (/\.(mjs|js|cjs|ts|py|sh|ps1)$/i.test(token)) candidates.push(token.replace(/^["']|["']$/g, ''))
  }
  for (const c of candidates) {
    const abs = isAbsolute(c) ? resolve(c) : resolve(projectPath, c)
    try {
      if (statSync(abs).isFile()) return abs
    } catch {
      continue
    }
  }
  return null
}

/**
 * The card id behind a memory directory.
 *
 * Memory directories carry only the first eight characters of the id, so this matches settings
 * files by that prefix and gives up unless exactly one matches. Two matches means the honest
 * answer is not known, and showing one card another card's hooks would be worse than showing none.
 */
function cardIdFromMemoryDir(memoryDir: string): string | null {
  const base = memoryDir.split(/[\\/]/).filter(Boolean).pop() || ''
  const m = /-([0-9a-f]{8})$/i.exec(base)
  if (!m) return null
  const prefix = m[1]!.toLowerCase()
  const hits = safeList(join(DATA_DIR, 'hooks', 'sessions')).filter(
    (f) => f.toLowerCase().startsWith(prefix) && f.endsWith('.json'),
  )
  return hits.length === 1 ? hits[0]!.replace(/\.json$/, '') : null
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Missing or malformed is the same answer here: nothing that can be proven.
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Guards, read from the dispatcher's registry.
 *
 * The registry is JavaScript, not data, so this pulls the referenced file names out by pattern
 * and then confirms each one exists on disk. Anything that cannot be resolved is dropped rather
 * than shown as a card pointing at nothing.
 */
function scanGuards(projectPath: string): ContextEntry[] {
  const guardsDir = join(projectPath, '.claude', 'hooks', 'guards')
  if (!existsSync(guardsDir)) return []

  const registry = join(projectPath, '.claude', 'hooks', 'lib', 'registry.mjs')
  const named = new Set<string>()
  if (existsSync(registry)) {
    try {
      const src = readFileSync(registry, 'utf8')
      for (const m of src.matchAll(/['"`]([\w.-]+\.mjs)['"`]/g)) named.add(m[1]!)
      for (const m of src.matchAll(/guards\/([\w.-]+)(?:\.mjs)?/g)) named.add(`${m[1]!}.mjs`)
    } catch {
      // A registry we cannot read just means falling back to the directory listing.
    }
  }

  const files = safeList(guardsDir).filter((f) => f.endsWith('.mjs'))
  const chosen = named.size > 0 ? files.filter((f) => named.has(f)) : files
  const list = chosen.length > 0 ? chosen : files

  return list.map((f) => {
    const abs = join(guardsDir, f)
    return {
      abs,
      title: f.replace(/\.mjs$/, ''),
      display: relative(projectPath, abs).split(sep).join('/'),
      external: false,
      group: 'guards' as const,
      // A guard runs on every matching hook event, so it shapes the session whether or not
      // anyone invokes it.
      usage: 'always' as const,
    }
  })
}
