/**
 * What a first-time user has been shown, and nothing else.
 *
 * Canon 23 is the specification. The short version of it is the one rule this file has to hold: a
 * step is ticked because the thing actually happened, never because somebody pressed "next". A
 * walkthrough that congratulates you for a step you did not take is the exact failure this project
 * exists to refuse, and a first-time user is the one person with no way to tell it is lying.
 *
 * Five steps, in the order they happen in. Four of them are facts about the board and are read live
 * from it by the panel: a project is open, an orchestrator exists, a card it hired exists, a wire
 * exists. Only the last, that a right-click menu has been opened, is a thing the user did that the
 * board does not hold, so that one is remembered here. `mark` is called from the place where the
 * thing genuinely happens and nowhere else.
 */

/**
 * The steps, and the list is the owner's, given as five numbered items with "simple as possible"
 * after them: "1. seclect project. 2 create new orhcestrator card 3. have orchestrator create a
 * second card 4. wire tutorial. 5. right click tutorial".
 *
 * An earlier version had seven, including opening a card's history and its roots. Those are real
 * and they are still on the board; they are not what somebody needs in their first five minutes.
 * What this list teaches instead is the one thing a Garden board does that nothing else does, which
 * is that a card can bring another card into existence. History and roots are discoverable once
 * there is a board worth looking at; the board is not discoverable at all.
 */
export type FirstRunStep = 'project' | 'orchestrator' | 'hired' | 'wire' | 'rightClick'

/**
 * Per-browser, not per-machine, and that is the right choice rather than a limitation of where it
 * was easy to put. This records that a person has been shown something. Opening Garden in a second
 * browser is a second person as far as anything here can tell, and showing it again is correct.
 *
 * `dismissed` lives in the same object because it answers the same question.
 */
const KEY = 'garden.firstrun'

interface Saved {
  done: FirstRunStep[]
  dismissed?: boolean
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { done: [] }
    const parsed = JSON.parse(raw) as Partial<Saved>
    return {
      done: Array.isArray(parsed.done) ? (parsed.done.filter((s) => typeof s === 'string') as FirstRunStep[]) : [],
      dismissed: parsed.dismissed === true,
    }
  } catch {
    /*
     * A browser with storage switched off, or a value somebody else wrote. Either way the honest
     * answer is that nothing is known to have been shown yet, which shows the panel. Showing a
     * walkthrough to someone who has seen it is a small annoyance; hiding it from someone who has
     * not is the whole failure.
     */
    return { done: [] }
  }
}

let state: Saved = load()

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // Storage full or refused. The panel still works for this session; it will simply come back.
  }
}

const subs = new Set<() => void>()

/*
 * The snapshot is a string, on purpose.
 *
 * `useSyncExternalStore` compares snapshots by identity and re-renders forever if a new object comes
 * back each time it asks. A sorted comma-joined string compares by value, so an unchanged set of
 * steps is an unchanged snapshot without any caching to keep in step with the real state. The same
 * reasoning is written out at the refusal reader in `LimitsPanel.tsx`.
 */
let snapshot = ''
function recompute() {
  snapshot = [...state.done].sort().join(',') + (state.dismissed ? '|dismissed' : '')
}
recompute()

export function onFirstRun(fn: () => void) {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

export function firstRunSnapshot() {
  return snapshot
}

/**
 * Record that a step actually happened.
 *
 * Idempotent and one-way. A step is never un-ticked, which canon 23 states as a rule: deleting your
 * only wire does not put that step back, because what is recorded is that you have been shown
 * something and not that a condition currently holds.
 */
export function markFirstRun(step: FirstRunStep) {
  if (state.done.includes(step)) return
  state.done = [...state.done, step]
  save()
  recompute()
  for (const fn of subs) fn()
}

export function firstRunDone(step: FirstRunStep) {
  return state.done.includes(step)
}

export function firstRunDismissed() {
  return state.dismissed === true
}

export function dismissFirstRun() {
  if (state.dismissed) return
  state.dismissed = true
  save()
  recompute()
  for (const fn of subs) fn()
}
