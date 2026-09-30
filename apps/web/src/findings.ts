/**
 * The watchdog's live findings, for the rail's Health section. docs/canonical/27-the-overseer.md.
 *
 * The server sends the whole live list every time any finding opens, moves or closes, and the
 * state snapshot carries it too, so this only ever replaces the list. The array is swapped rather
 * than mutated, which is what makes `getFindings` safe as a `useSyncExternalStore` snapshot.
 */
import type { Finding, KeeperState, OverseerView, ServerMessage } from '@garden/shared'
import { conn } from './connection'

const NONE: Finding[] = []
let list: Finding[] = NONE
const subs = new Set<() => void>()

function take(next: unknown) {
  if (!Array.isArray(next)) return
  list = next.length ? (next as Finding[]) : NONE
  for (const fn of subs) fn()
}

conn.on((msg: ServerMessage) => {
  // Guarded: a server older than the watchdog sends a snapshot without the field.
  if (msg.t === 'state') take((msg as { findings?: unknown }).findings)
  else if (msg.t === 'findings') take(msg.findings)
})

export function onFindings(fn: () => void) {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

export function getFindings(): Finding[] {
  return list
}

export function dismissFinding(id: string) {
  conn.send({ t: 'finding.dismiss', id })
}

/*
 * The Keeper's state, beside the findings because the same section shows both. A new object on
 * every message, so it too is a safe snapshot.
 */
const NO_KEEPER: KeeperState = { present: false, running: false, paused: false }
let keeper: KeeperState = NO_KEEPER

conn.on((msg: ServerMessage) => {
  const next =
    msg.t === 'state' ? (msg as { keeper?: KeeperState }).keeper : msg.t === 'keeper' ? msg : undefined
  if (!next) return
  keeper = { present: next.present === true, running: next.running === true, paused: next.paused === true }
  for (const fn of subs) fn()
})

export function getKeeper(): KeeperState {
  return keeper
}

export function pauseKeeper(paused: boolean) {
  conn.send({ t: 'keeper.pause', paused })
}

/*
 * The overseer card's picture: the Keeper, the machine, the rhythm and what was done lately. Sent
 * whole every ten seconds and in the snapshot, so this too only ever replaces.
 */
let overseer: OverseerView | null = null

conn.on((msg: ServerMessage) => {
  const next = msg.t === 'state' ? (msg as { overseer?: OverseerView }).overseer : msg.t === 'overseer' ? msg.view : undefined
  if (!next) return
  overseer = next
  keeper = next.keeper
  for (const fn of subs) fn()
})

export function getOverseer(): OverseerView | null {
  return overseer
}
