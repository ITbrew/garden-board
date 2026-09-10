import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface AccountIdentity {
  email: string | null
  displayName: string | null
  organizationName: string | null
}

/**
 * Which account a config directory is signed in as.
 *
 * Read from `.config.json`, falling back to `.claude.json`. Newer builds prefer the first when it
 * exists, and reading the wrong one is not harmless: the account guard in C:\Work\App\1.0
 * documents that doing so once produced a silent false all-clear.
 *
 * Only `oauthAccount` is touched, which holds no secret. Tokens live in `.credentials.json`,
 * which Garden never opens.
 */
export function readAccount(configDir: string): AccountIdentity | null {
  for (const name of ['.config.json', '.claude.json']) {
    const file = join(configDir, name)
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const acct = parsed?.oauthAccount
      if (!acct) continue
      return {
        email: acct.emailAddress ?? null,
        displayName: acct.displayName ?? null,
        organizationName: acct.organizationName ?? null,
      }
    } catch {
      // A malformed config is the same as not knowing. Never guess an account.
    }
  }
  return null
}

/** The default config directory, used when a project has no profile bound to it. */
export function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function ensureConfigDir(dir: string) {
  mkdirSync(dir, { recursive: true })
}

export interface DiscoveredAccount {
  configDir: string
  /** The email the map declares for this directory. */
  declaredEmail: string | null
  /** What the directory is actually signed in as right now. */
  identity: AccountIdentity | null
  /**
   * Working-directory prefixes this account owns, from the map. Empty when it declares none.
   *
   * A list, not one path, because one account legitimately owns several roots. The map on this
   * machine has three roots across two config directories, and while this held a single prefix the
   * second root sharing a directory was thrown away with it: `C:\Work\App` claimed the directory
   * first and `C:\Garden` was silently dropped, so no account owned the Garden folder and every
   * card there launched unbound. That is the failure the account shim then refused at, and the
   * owner spent it typing `claude` into card after card by hand.
   */
  prefixes: string[]
}

/**
 * Accounts the owner already has, read from their own account map.
 *
 * `~/.claude-account-map.json` is this machine's existing convention: it maps a config directory
 * to an account and to the path prefix that account owns. Garden reads it rather than asking for
 * profiles to be re-created, so the picker offers the two real accounts and a project can bind
 * itself to the right one by its own path.
 *
 * Honours CLAUDE_ACCOUNT_MAP, the same override the account-check hook uses.
 */
export function discoverAccounts(): DiscoveredAccount[] {
  const mapPath = process.env.CLAUDE_ACCOUNT_MAP || join(homedir(), '.claude-account-map.json')
  const out: DiscoveredAccount[] = []
  const seen = new Set<string>()

  /*
   * One entry per config directory, but every prefix that directory owns is kept.
   *
   * Deduping on the directory alone is right for the picker, since two entries for one account
   * would offer the owner the same thing twice. It was wrong for ownership: the second root
   * pointing at an already-seen directory returned early and took its prefix with it.
   */
  const push = (dir: string, declaredEmail: string | null, prefix: string | null) => {
    if (!existsSync(dir)) return
    const key = dir.toLowerCase()
    const already = seen.has(key) ? out.find((a) => a.configDir.toLowerCase() === key) : undefined
    if (already) {
      if (prefix && !already.prefixes.some((p) => p.toLowerCase() === prefix.toLowerCase())) {
        already.prefixes.push(prefix)
      }
      return
    }
    seen.add(key)
    out.push({
      configDir: dir,
      declaredEmail,
      identity: readAccount(dir),
      prefixes: prefix ? [prefix] : [],
    })
  }

  try {
    const map = JSON.parse(readFileSync(mapPath, 'utf8'))
    for (const root of map?.roots ?? []) {
      if (typeof root?.dir === 'string') {
        push(root.dir, root.email ?? null, root.prefix ?? null)
      }
    }
  } catch {
    // No map, or an unreadable one, just means nothing to discover. Never invent an account.
  }

  // The directory in use right now, in case the map does not list it.
  push(defaultConfigDir(), null, null)
  return out
}

/**
 * The discovered account whose declared prefix owns this path, if any.
 *
 * Longest prefix wins, which is the same rule the account map itself documents, so a root nested
 * inside another root beats the one it sits in rather than tying with it.
 */
export function accountForPath(accounts: DiscoveredAccount[], projectPath: string) {
  const p = projectPath.toLowerCase()
  let best: DiscoveredAccount | undefined
  let bestLen = -1
  for (const a of accounts) {
    for (const prefix of a.prefixes) {
      const pre = prefix.toLowerCase()
      if (p.startsWith(pre) && pre.length > bestLen) {
        best = a
        bestLen = pre.length
      }
    }
  }
  return best
}
