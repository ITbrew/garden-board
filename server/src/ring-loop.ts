/**
 * What a loop that follows its tab's ring should do next. Canon 25 and 28.
 *
 * Pure, so the rule that stops a loop running forever can be tested without waiting for a clock. The
 * owner: "there should be a loop active when there are x/y remaining" and "its ur job to write loops
 * that dont loop forever for the rings".
 */
export type RingLoopStop = 'owner' | 'ring' | 'stuck' | 'disabled' | null

/** Unchanged list, nothing working, this many times typed: the loop is telling nobody anything new. */
export const RING_STUCK_AFTER = 3

export type RingLoopFacts = {
  enabled: boolean
  stoppedBy: RingLoopStop
  /** Goals on the ring not yet done, and goals on it. */
  left: number
  total: number
  /** Whether the list file has changed since the loop last typed. */
  listChanged: boolean
  /** Times typed since the list last changed. */
  firesUnchanged: number
  /** Whether any card on the tab is mid-turn, so progress may still be coming. */
  anyWorking: boolean
}

export type RingLoopStep = 'carry-on' | 'finish' | 'pause' | 'resume' | 'stay-stopped'

/** Only a full ring turns cards off. A pause knows the list did not change, not that nothing is running. */
export function ringTurnsCardsOff(stoppedBy: 'ring' | 'stuck'): boolean {
  return stoppedBy === 'ring'
}

export function ringLoopStep(f: RingLoopFacts): RingLoopStep {
  if (f.enabled) {
    if (f.left === 0) return 'finish'
    if (f.firesUnchanged >= RING_STUCK_AFTER && !f.anyWorking) return 'pause'
    return 'carry-on'
  }
  // Stopped by hand stays stopped: Start is the owner's or the orchestrator's to press.
  if (f.left === 0 || f.stoppedBy === 'owner' || f.stoppedBy === 'disabled' || f.stoppedBy === null) return 'stay-stopped'
  // A full ring with new goals on it, or a stuck list someone has changed since.
  if (f.stoppedBy === 'ring' || f.listChanged) return 'resume'
  return 'stay-stopped'
}
