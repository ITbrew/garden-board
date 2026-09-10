import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const MAX_BYTES = 512 * 1024
const MAX_RESULTS = 400

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'obj', 'bin', 'Library', 'Temp',
  '.vs', '.vscode', '.idea', 'coverage', 'out', '.next', '.cache',
])

/**
 * Resolve a project-relative path and refuse anything that escapes the project folder.
 *
 * The renderer supplies this string, so it is untrusted by definition. Symlinks are resolved
 * before the containment check, so a link pointing outside the project is rejected too.
 */
export function safeJoin(projectPath: string, relPath: string): string {
  const root = resolve(projectPath)
  // Accept either separator: paths are typed by a person and Windows uses both.
  const target = resolve(root, relPath.replace(/\\/g, '/'))
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) {
    throw new Error('path escapes the project folder')
  }
  return target
}

/** Markdown files inside a project, nearest first, skipping build and dependency folders. */
export function listMarkdown(projectPath: string): string[] {
  const root = resolve(projectPath)
  const out: string[] = []

  const walk = (dir: string, depth: number) => {
    if (out.length >= MAX_RESULTS || depth > 6) return
    let entries: import('node:fs').Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_RESULTS) return
      if (e.name.startsWith('.') && e.name !== '.claude') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(full, depth + 1)
      // Any text file worth putting on the board, not only markdown. Restricting this to .md
      // meant a .ts, .json or .py could not be opened by hand at all, on a tool whose job
      // includes editing the files a session works with.
      } else if (
        e.isFile() &&
        /\.(md|markdown|txt|png|jpe?g|gif|webp|svg|json|jsonc|ya?ml|toml|ini|cfg|env|ts|tsx|js|jsx|mjs|cjs|py|ps1|sh|cs|css|html?|xml|sql|log)$/i.test(
          e.name,
        )
      ) {
        out.push(relative(root, full).split(sep).join('/'))
      }
    }
  }

  walk(root, 0)
  // Shallow paths first, so CLAUDE.md and AGENTS.md surface above deep canon docs.
  out.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  return out
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i

/** Text or image, decided by the file itself rather than by anything the renderer claims. */
export function kindOf(path: string): 'text' | 'image' {
  return IMAGE_RE.test(path) ? 'image' : 'text'
}

export function contentTypeOf(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  }
  return map[ext] ?? 'application/octet-stream'
}

export function readDoc(projectPath: string, relPath: string): string {
  const file = safeJoin(projectPath, relPath)
  const st = statSync(file)
  if (!st.isFile()) throw new Error('not a file')
  if (st.size > MAX_BYTES) {
    return readFileSync(file, 'utf8').slice(0, MAX_BYTES) + '\n\n... truncated by Garden ...'
  }
  return readFileSync(file, 'utf8')
}

/**
 * Read a file outside the project.
 *
 * Only ever called with an absolute path this server produced from its own scan of a session's
 * context, never with one the renderer supplied, so the path boundary in `safeJoin` still holds
 * for everything the renderer can reach.
 */
export function readExternalDoc(abs: string): string {
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('not a file')
  if (st.size > MAX_BYTES) {
    return readFileSync(abs, 'utf8').slice(0, MAX_BYTES) + '\n\n... truncated by Garden ...'
  }
  return readFileSync(abs, 'utf8')
}

export function writeExternalDoc(abs: string, content: string, baseMtime?: number): number {
  if (content.length > MAX_BYTES) throw new Error('document too large to save')
  guardUnchanged(abs, baseMtime)
  writeFileSync(abs, content, 'utf8')
  return statSync(abs).mtimeMs
}

/**
 * Refuse the write if the file moved on since the card read it.
 *
 * These cards sit beside agents editing the same files, so an unconditional write is a silent
 * data-loss path: the card's snapshot wins and whatever the agent wrote in between disappears.
 */
function guardUnchanged(abs: string, baseMtime?: number) {
  if (!baseMtime) return
  let current: number
  try {
    current = statSync(abs).mtimeMs
  } catch {
    return
  }
  if (Math.abs(current - baseMtime) > 1) {
    throw new Error('this file changed on disk since the card read it, so the save was refused')
  }
}

/** When a file was last written, used to make the guard above possible. */
export function mtimeOf(projectPath: string, relPath: string, external: boolean): number {
  try {
    return statSync(external ? relPath : safeJoin(projectPath, relPath)).mtimeMs
  } catch {
    return 0
  }
}

export function writeDoc(
  projectPath: string,
  relPath: string,
  content: string,
  baseMtime?: number,
): number {
  const file = safeJoin(projectPath, relPath)
  if (content.length > MAX_BYTES) throw new Error('document too large to save')
  guardUnchanged(file, baseMtime)
  writeFileSync(file, content, 'utf8')
  return statSync(file).mtimeMs
}
