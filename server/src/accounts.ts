import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAccount } from './profiles.js'

/**
 * Garden runs as one account. Canon 29.
 *
 * The rule is a file on this machine, `<data dir>/accounts.json`, never anything in the repository:
 * the allowed email is the owner's and Garden only ever compares it with what a config directory
 * says it is signed in as. Without the file there is no rule and Garden behaves as it always has.
 */
export interface AccountRule {
  /** Lowercased emails a Claude or Codex card may run as. */
  allowed: string[]
  /** The config directory every project's Claude cards run from. */
  claude: string | null
  /** The CODEX_HOME every project's Codex cards run from. */
  codex: string | null
}

export function readAccountRule(dataDir: string): AccountRule | null {
  const file = join(dataDir, 'accounts.json')
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const allowed = Array.isArray(raw?.allowed)
      ? raw.allowed.filter((e: unknown): e is string => typeof e === 'string').map((e: string) => e.trim().toLowerCase())
      : []
    return {
      allowed,
      claude: typeof raw?.claude === 'string' && raw.claude ? raw.claude : null,
      codex: typeof raw?.codex === 'string' && raw.codex ? raw.codex : null,
    }
  } catch {
    /*
     * A rule file that cannot be read is a rule that allows nothing, not one that allows everything.
     * Falling open here would put every card back on whatever account the defaults are signed in as,
     * which is the failure this file exists to stop.
     */
    return { allowed: [], claude: null, codex: null }
  }
}

/**
 * The email a Codex home is signed in as, from the `email` claim of the identity token in
 * `auth.json`, decoded in memory. Nothing else in the file is read or kept, and the token itself
 * never leaves this function. An API-key sign-in has no email and answers null. The owner chose
 * this over leaving Codex unchecked, 2026-10-09.
 */
export function readCodexEmail(codexHome: string): string | null {
  const file = join(codexHome, 'auth.json')
  if (!existsSync(file)) return null
  try {
    const token = JSON.parse(readFileSync(file, 'utf8'))?.tokens?.id_token
    if (typeof token !== 'string') return null
    const payload = token.split('.')[1]
    if (!payload) return null
    const email = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.email
    return typeof email === 'string' ? email : null
  } catch {
    return null
  }
}

/** Who a config directory is signed in as, for the CLI that uses it. */
export function accountEmailOf(adapterId: string, configDir: string): string | null {
  if (adapterId === 'codex') return readCodexEmail(configDir)
  return readAccount(configDir)?.email ?? null
}

/** The stable profile id Garden binds every project to, per CLI. */
export function ruleProfileId(adapterId: 'claude' | 'codex'): string {
  return `garden-account:${adapterId}`
}

/**
 * Why a card with this account may not start, or null when it may. Only Claude and Codex have
 * accounts; a shell card is never refused here.
 */
export function accountRefusal(
  rule: AccountRule | null,
  adapterId: string,
  configDir: string | null,
): string | null {
  if (!rule) return null
  if (adapterId !== 'claude' && adapterId !== 'codex') return null
  const cli = adapterId === 'codex' ? 'Codex' : 'Claude'
  if (!configDir) return `${cli} has no Garden account directory set in accounts.json, so it would run as whatever the default is signed in as`
  const email = accountEmailOf(adapterId, configDir)
  if (!email) {
    return `${configDir} is not signed in. Sign it in as the Garden account first (canon 29)`
  }
  if (!rule.allowed.includes(email.toLowerCase())) {
    return `${configDir} is signed in as ${email}, which is not Garden's account. Sign it in as the Garden account (canon 29)`
  }
  return null
}

/**
 * Settle the CLI's "trust this folder?" question for Garden's projects in Garden's own Claude
 * directory, so a card never opens on a chooser nobody is there to answer (canon 12). The owner's
 * old config held these answers; a fresh directory has none, and every card would stop on it.
 *
 * Only in a directory that is already signed in, so this never makes a first-run install look
 * finished, and only at boot, before any card is running, because the CLI rewrites this file as it
 * goes and two writers would lose each other's changes. Existing entries are kept, only the flag is
 * added. Returns how many folders it settled.
 */
export function trustFolders(configDir: string, folders: string[]): number {
  const file = join(configDir, '.claude.json')
  if (!existsSync(file)) return 0
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed?.oauthAccount) return 0
    const projects = (parsed.projects ??= {}) as Record<string, Record<string, unknown>>
    let added = 0
    for (const folder of folders) {
      const key = folder.replace(/\\/g, '/')
      if (projects[key]?.hasTrustDialogAccepted === true) continue
      projects[key] = { ...(projects[key] ?? {}), hasTrustDialogAccepted: true }
      added++
    }
    if (added) {
      const tmp = `${file}.garden-${process.pid}`
      writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf8')
      renameSync(tmp, file)
    }
    return added
  } catch {
    return 0
  }
}
