/**
 * Reads the account files on a thread of its own, so a slow disk cannot stop the board. Canon 01.
 *
 * The refresh runs every five seconds and reads each account's config file. On the server's own
 * thread, those reads stopped everything else while the disk was slow: on 2026-11-06 one refresh
 * took 5.1 s and used 16 ms of processor. This file is both halves: the main thread asks through
 * `readProfiles`, and the worker, started from this same file, does the reading and changes nothing.
 */
import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import { accountEmailOf, readAccountRule, type AccountRule } from './accounts.js'
import { discoverAccounts, readAccount, type AccountIdentity, type DiscoveredAccount } from './profiles.js'

export interface ProfileAsked {
  dataDir: string
  profiles: Array<{ adapterId: string; configDir: string }>
}

export interface ProfileReading {
  discovered: DiscoveredAccount[]
  rule: AccountRule | null
  /** By config directory, and only for directories that were read. */
  identities: Record<string, AccountIdentity | null>
  codexEmails: Record<string, string | null>
}

export function readProfilesNow(asked: ProfileAsked): ProfileReading {
  const discovered = discoverAccounts()
  const identities: ProfileReading['identities'] = {}
  const codexEmails: ProfileReading['codexEmails'] = {}
  for (const a of discovered) identities[a.configDir] = a.identity
  for (const p of asked.profiles) {
    if (p.adapterId === 'codex') codexEmails[p.configDir] = accountEmailOf('codex', p.configDir)
    else if (!(p.configDir in identities)) identities[p.configDir] = readAccount(p.configDir)
  }
  return { discovered, rule: readAccountRule(asked.dataDir), identities, codexEmails }
}

if (!isMainThread) {
  parentPort!.on('message', (asked: ProfileAsked) => {
    try {
      parentPort!.postMessage({ reading: readProfilesNow(asked) })
    } catch (err) {
      parentPort!.postMessage({ error: (err as Error).message })
    }
  })
}

let worker: Worker | null = null
let waiting: { resolve: (r: ProfileReading) => void; reject: (e: Error) => void } | null = null

function startWorker(): Worker {
  const w = new Worker(new URL(import.meta.url))
  w.unref()
  w.on('message', (m: { reading?: ProfileReading; error?: string }) => {
    const answer = waiting
    waiting = null
    if (m.reading) answer?.resolve(m.reading)
    else answer?.reject(new Error(m.error ?? 'no reading'))
  })
  const gone = (err: Error) => {
    if (worker === w) worker = null
    const answer = waiting
    waiting = null
    answer?.reject(err)
  }
  w.on('error', gone)
  w.on('exit', () => gone(new Error('the profile reader stopped')))
  return w
}

/** One question at a time: the caller waits for each answer before asking again. */
export function readProfiles(asked: ProfileAsked): Promise<ProfileReading> {
  return new Promise((resolve, reject) => {
    if (waiting) return reject(new Error('the profile reader is busy'))
    try {
      worker ??= startWorker()
      waiting = { resolve, reject }
      worker.postMessage(asked)
    } catch (err) {
      waiting = null
      reject(err as Error)
    }
  })
}

export async function stopProfileReader(): Promise<void> {
  const w = worker
  worker = null
  await w?.terminate()
}
