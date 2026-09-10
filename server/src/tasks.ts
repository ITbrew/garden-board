/**
 * A task's journey, and the rule that stops it going round forever.
 *
 * The owner's words: when work comes back to him it should carry the completion summary and the
 * reviewer's notes, and he decides from there, because he does not want tasks in an endless
 * review and edit spiral. Both halves of that need the same thing, a record of where a task has
 * actually been, which Garden can build because every hand-off along a wire is a delivery it
 * wrote itself.
 *
 * Nothing here reads prose. A hop is a delivery that happened, its kind is what the sender
 * declared it to be, and a task that has been reviewed twice has two review hops. What the work is
 * worth is not in here and cannot be: the report says what was done and what the reviewer wrote,
 * and the judgement stays with the owner, which is the point.
 */
import type { AgentEvent, TaskContract, TaskState } from '@garden/shared'
import type { Store } from './store.js'

export type MailKind =
  | 'work'
  | 'question'
  | 'answer'
  | 'review'
  | 'done'
  | 'confirm'
  | 'assessment'
  | 'remediation'

/**
 * What each kind of message means, in one table that both validates a send and writes the list an
 * agent reads.
 *
 * The kind is a label the sender chose, not something Garden can verify, and the ledger says so.
 * What it buys is that a chain of hand-offs can be read back afterwards: which of these were
 * questions and which were work is the difference between a conversation and a blind pass down a
 * line, and the owner asked for the first one.
 *
 * A kind never restricts direction. The wire does that, and only the wire: if it has an arrowhead
 * at both ends then either card can start anything, including a manager asking its worker a
 * question and a worker asking one back. That is the whole reason the owner can draw a wire that no
 * spawn created and have it work immediately.
 */
export const MAIL_KINDS: Record<MailKind, string> = {
  work: 'here is something to do',
  question: 'I need to know something before I can go on',
  answer: 'the reply to a question',
  review: 'please look at this and tell me what you find',
  done: "I have finished what I was given, and here is what happened",
  confirm: 'I have looked at what you sent me and I accept it as done',
  assessment: 'how the finished work measures against what was actually asked for',
  remediation: 'this needs another pass, here is what to change',
}

export function isMailKind(x: string): x is MailKind {
  return Object.prototype.hasOwnProperty.call(MAIL_KINDS, x)
}

export interface Hop {
  ts: number
  fromId: string
  fromTitle: string
  toId: string
  toTitle: string
  kind: MailKind
  text: string
}

/**
 * Every delivery carrying one task id, oldest first.
 *
 * Read from the events Garden inserted when it delivered each message, so a hop exists only if a
 * message really moved. A hand-off somebody made by writing into a mailbox directly has no task id
 * and therefore no hop, which is why the ledger can have gaps and says so rather than closing them.
 *
 * Every delivery, through `listMailDelivered`, and never a page of events. This used to walk
 * `listEvents`, which is capped, and a card's deliveries are a small fraction of what it records: on
 * a working card the review hop falls out of the page while the task is still open, the spiral guard
 * counts zero rounds on a task that has been round one, and a remediation the owner's rule sends
 * upward goes back down instead. The guard's answer moved with the card's tool traffic rather than
 * with its work.
 */
export function hopsForTask(store: Store, projectId: string, taskId: string): Hop[] {
  const hops: Hop[] = []
  for (const session of store.listSessions().filter((s) => s.projectId === projectId)) {
    for (const e of store.listMailDelivered(session.id)) {
      const p = e.payload as any
      if (!p || p.taskId !== taskId) continue
      hops.push({
        ts: e.ts,
        fromId: p.from,
        fromTitle: p.fromTitle ?? 'a card',
        toId: session.id,
        toTitle: session.title,
        kind: (p.kind ?? 'work') as MailKind,
        text: String(p.text ?? ''),
      })
    }
  }
  return hops.sort((a, b) => a.ts - b.ts)
}

/**
 * How many times this task has been round the review loop.
 *
 * A round is a review hop: the boss sending it to a reviewer. Counting deliveries rather than
 * anything an agent says about itself keeps this a fact.
 */
export function reviewRounds(hops: Hop[]): number {
  return hops.filter((h) => h.kind === 'review').length
}

/**
 * Whether sending this work back down is allowed, or whether it has to go to the owner.
 *
 * The spiral the owner described happens when a boss keeps bouncing a task between a reviewer and
 * a worker, each round costing tokens and none of it reaching him. After the cap, remediation
 * downward is refused and the only way left is up, where he makes the call. The cap is a number he
 * can change, and the refusal says which task and how many rounds it has had, so it never reads as
 * a mysterious block.
 */
export function spiralGuard(
  hops: Hop[],
  kind: MailKind,
  maxRounds: number,
): { allowed: true } | { allowed: false; reason: string } {
  if (maxRounds <= 0) return { allowed: true }
  const rounds = reviewRounds(hops)
  if (kind === 'review' && rounds >= maxRounds) {
    return {
      allowed: false,
      reason:
        `this task has already been reviewed ${rounds} time${rounds === 1 ? '' : 's'}, which is the limit. ` +
        'Send it up with kind done, including the reviewer notes, and the owner decides what happens next.',
    }
  }
  if (kind === 'remediation' && rounds >= maxRounds) {
    return {
      allowed: false,
      reason:
        `this task has already been reviewed ${rounds} time${rounds === 1 ? '' : 's'}. Remediation now ` +
        'comes from the owner rather than from inside the chain, so send it up with kind done.',
    }
  }
  return { allowed: true }
}

/**
 * A card that was told something is done and has not said whether it accepts it.
 *
 * This is the step the owner added, and the reason he added it: work was being passed up the chain
 * unread, so a manager relayed its worker's word and a boss relayed the manager's, and nothing
 * between the worker and the owner had actually looked. A supervisor now has to answer the card
 * below it before it can speak for that card further up.
 *
 * A confirmation counts only if it went back to the card that reported done, and only if it came
 * after that report. Confirming somebody in advance is not looking at their work.
 */
export function unconfirmedReports(hops: Hop[], cardId: string): { title: string; ts: number }[] {
  const owed: { title: string; ts: number }[] = []
  for (const report of hops) {
    if (report.kind !== 'done' || report.toId !== cardId) continue
    const answered = hops.some(
      (h) => h.kind === 'confirm' && h.fromId === cardId && h.toId === report.fromId && h.ts >= report.ts,
    )
    if (!answered && !owed.some((o) => o.title === report.fromTitle)) {
      owed.push({ title: report.fromTitle, ts: report.ts })
    }
  }
  return owed
}

/**
 * Whether this card may speak for the work below it yet.
 *
 * Only bites when a card actually received a report, so it can never deadlock the bottom of the
 * chain: a worker who was given work and finished it has nothing to confirm and passes straight up.
 * The refusal names who is waiting and what to send, because a block an agent cannot act on is
 * indistinguishable from a broken app.
 */
export function confirmGuard(
  hops: Hop[],
  fromId: string,
  kind: MailKind,
): { allowed: true } | { allowed: false; reason: string } {
  if (kind !== 'done' && kind !== 'assessment') return { allowed: true }
  const owed = unconfirmedReports(hops, fromId)
  if (owed.length === 0) return { allowed: true }
  const who = owed.map((o) => `"${o.title}"`).join(' and ')
  return {
    allowed: false,
    reason:
      `${who} reported this task done to you and you have not confirmed it. Look at what was ` +
      `handed to you, then send kind confirm to ${who} saying you accept it. After that you can ` +
      'pass this up. Passing on a report you have not answered is the blind hand-off this chain exists to stop.',
  }
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * The report that lands with the owner when a task comes home.
 *
 * What he asked for: the completion summary and the reviewer's notes, together, so he can decide.
 * So the report is assembled from three things Garden already holds, each labelled with where it
 * came from: what the card that finished the work said when it handed it up, what any reviewer
 * wrote on its own hops, and the files that were actually written, which come from the CLI's own
 * tool calls rather than from anybody's account of themselves.
 *
 * There is no verdict line. Garden can say a review ran and quote it; whether the work is right is
 * the judgement the owner reserved, and a tick here would be the app's oldest failure mode.
 */
export function completionReport(store: Store, taskId: string, hops: Hop[], projectId: string): string {
  const done = [...hops].reverse().find((h) => h.kind === 'done')

  /*
   * Anything a reviewer touched, in either direction. The request and the reply are both part of
   * what the owner asked to see, and only one of them is a `review` hop: what comes back from a
   * reviewer is an answer, so filtering on kind alone showed him the question and hid the finding.
   */
  const reviewerIds = new Set(
    store
      .listSessions()
      .filter((s) => s.roleClass === 'reviewer')
      .map((s) => s.id),
  )
  const reviews = hops.filter(
    (h) => h.kind === 'review' || reviewerIds.has(h.fromId) || reviewerIds.has(h.toId),
  )
  const assessments = hops.filter((h) => h.kind === 'assessment')
  const confirms = hops.filter((h) => h.kind === 'confirm')
  const talk = hops.filter((h) => h.kind === 'question' || h.kind === 'answer')

  /*
   * The contract goes first, and it is the part of this report that is not anybody's account of
   * anything: who owned the work, who handed it out, what it was allowed to touch, and what it was
   * to be measured against. Reading a completion summary without it is reading an answer with the
   * question missing, which is how a task quietly becomes whatever the card doing it decided.
   *
   * A task id with no contract row still gets the heading and a sentence saying so, rather than a
   * report that silently looks the way it did before ownership existed.
   */
  const contract = store.getTask(projectId, taskId)
  const name = (id: string | null) => {
    if (!id) return 'nobody'
    return store.getSession(id)?.title ?? id
  }

  const lines = [
    `# Task ${taskId}`,
    '',
    `Assembled by Garden from ${hops.length} hand-off${hops.length === 1 ? '' : 's'} it recorded.`,
    '',
    '## The contract',
    '',
  ]

  if (!contract) {
    lines.push(
      'Garden holds no task contract under this id, so there is nothing here saying who owned this ' +
        'work or what it was measured against.',
      '',
    )
  } else {
    lines.push(
      '| | |',
      '| --- | --- |',
      `| id | ${contract.id} |`,
      `| state | ${contract.state} |`,
      `| owner | ${name(contract.ownerId)} |`,
      `| assigner | ${name(contract.assignerId)} |`,
      `| verifier | ${name(contract.verifierId)} |`,
      `| required role | ${contract.requiredRole ?? 'any role'} |`,
      `| territory | ${contract.territory.length ? contract.territory.join(', ') : 'none declared'} |`,
      `| parent | ${contract.parentId ?? 'none'} |`,
      contract.acceptanceRef
        ? `| acceptance | ${contract.acceptanceRef.path}, sha256 ${contract.acceptanceRef.sha256} |`
        : `| acceptance | ${contract.acceptance ? 'stated below' : 'none recorded'} |`,
      '',
    )
    if (contract.acceptance) {
      lines.push('Acceptance criteria as they stood when the task was opened:', '', contract.acceptance.slice(0, 4000), '')
    }
    if (contract.acceptanceRef) {
      lines.push(
        `The criteria were hashed at ${contract.acceptanceRef.path} when the task was assigned, so ` +
          'whether they have been edited since is something anybody can check rather than argue about.',
        '',
      )
    }
  }

  lines.push('## What was reported done', '')

  if (done) {
    lines.push(`From **${done.fromTitle}**, ${stamp(done.ts)}:`, '', done.text.slice(0, 6000), '')
  } else {
    lines.push('Nothing has been handed up as done yet, so there is no summary to show.', '')
  }

  /*
   * The assessment against what was asked for. This is the boss's own reading rather than a
   * reviewer's, and it is kept separate because they answer different questions: a reviewer says
   * what it found in the work, and this says whether the work is the thing that was requested.
   */
  lines.push('## How it measures against what was asked for', '')
  if (assessments.length === 0) {
    lines.push('No assessment was written for this task.', '')
  } else {
    for (const a of assessments) {
      lines.push(`From **${a.fromTitle}**, ${stamp(a.ts)}:`, '', a.text.slice(0, 6000), '')
    }
  }

  lines.push('## What the reviewer said', '')
  if (reviews.length === 0) {
    // Not "it passed". No review hop means no review happened, which is a different fact.
    lines.push('No review hand-off was recorded for this task.', '')
  } else {
    for (const r of reviews) {
      lines.push(`From **${r.fromTitle}** to **${r.toTitle}**, ${stamp(r.ts)}:`, '', r.text.slice(0, 4000), '')
    }
  }

  /*
   * Who checked whom. Each line is one supervisor saying it looked at the card below it and
   * accepted the work, which is the part that stops a report travelling up the chain unread.
   */
  lines.push('## Who confirmed the work below them', '')
  if (confirms.length === 0) {
    lines.push('Nobody confirmed anybody, so nothing here was checked on the way up.', '')
  } else {
    for (const c of confirms) {
      lines.push(`- ${stamp(c.ts)}  **${c.fromTitle}** accepted **${c.toTitle}**'s work: ${c.text.slice(0, 300)}`)
    }
    lines.push('')
  }

  if (talk.length > 0) {
    lines.push('## What they asked each other', '')
    for (const t of talk) {
      lines.push(`- ${stamp(t.ts)}  **${t.fromTitle}** to **${t.toTitle}** (${t.kind}): ${t.text.slice(0, 300)}`)
    }
    lines.push('')
  }

  /*
   * The files, from the CLI's own tool calls rather than from what anyone said they did. This is
   * the part of the report that does not depend on an agent describing itself accurately.
   */
  const touched = new Set<string>()
  const images = new Set<string>()
  for (const hop of hops) {
    for (const rec of store.listWork(hop.toId)) {
      if (rec.promptId && rec.promptId !== taskId) continue
      for (const f of rec.filesTouched) touched.add(f)
    }
  }
  for (const hop of hops) {
    for (const doc of store.listDocs().filter((d) => d.ownerId === hop.toId)) {
      for (const img of doc.images) images.add(img)
    }
  }

  lines.push('## Files written during this task', '')
  if (touched.size === 0) lines.push('No writes were recorded against this task.', '')
  else for (const f of touched) lines.push(`- ${f}`)

  if (images.size > 0) {
    lines.push('', '## Images opened', '')
    for (const i of images) lines.push(`- ${i}`)
  }

  lines.push('', '## Where it went', '')
  for (const h of hops) {
    lines.push(`- ${stamp(h.ts)}  ${h.fromTitle} to ${h.toTitle}, as ${h.kind}`)
  }

  /*
   * How the work changed hands, and what ownership stopped along the way. Both at the bottom, where
   * canon 20 puts them, because they are the record rather than the report: somebody reading to
   * decide reads the summary first and comes down here when a name or a gap does not add up.
   *
   * Newest first, and a task with no rows says so in a sentence rather than dropping the heading.
   * An absent section reads as "this never happens here"; an empty one reads as "it did not happen
   * to this task", and only the second is a fact Garden knows.
   */
  const handovers = store.listReassignments(projectId).filter((r) => r.taskId === taskId)
  lines.push('', '## How it changed hands', '')
  if (handovers.length === 0) {
    lines.push('This task stayed with the card it was opened on. Nobody reassigned it.', '')
  } else {
    for (const r of [...handovers].sort((a, b) => b.ts - a.ts)) {
      lines.push(
        `- ${stamp(r.ts)}  **${name(r.fromOwnerId)}** to **${name(r.toOwnerId)}**, reason \`${r.reason}\`` +
          `${r.byId ? `, by ${name(r.byId)}` : ''}${r.note ? `: ${r.note.slice(0, 300)}` : ''}`,
      )
      // What Garden found, under what the dispatcher wrote and marked as Garden's rather than his,
      // so the two are never read as one claim.
      if (r.evidence) lines.push(`  Garden found: ${r.evidence.slice(0, 300)}`)
    }
    lines.push('')
  }

  const refusals = store
    .listTaskRefusals(projectId)
    .filter((e) => (e.payload as { taskId?: string } | null)?.taskId === taskId)
  lines.push('## Refused', '')
  if (refusals.length === 0) {
    lines.push('Ownership stopped nothing on this task.', '')
  } else {
    for (const e of refusals) {
      const p = (e.payload ?? {}) as { rule?: string; kind?: string; reason?: string }
      lines.push(
        `- ${stamp(e.ts)}  \`${e.type}\`  ${p.kind ?? 'unknown kind'}, rule \`${p.rule ?? 'unnamed'}\`: ` +
          `${(p.reason ?? '').slice(0, 400)}`,
      )
    }
    lines.push(
      '',
      '`TaskRefused` means the message or the write did not happen. `TaskWouldRefuse` means the board ' +
        'was in shadow and it went through anyway, recorded so it can be seen before a refusal costs ' +
        'anybody a turn.',
      '',
    )
  }

  lines.push(
    '',
    '---',
    '',
    'Garden records hand-offs and file writes. It does not judge whether the work is right, and',
    'nothing above should be read as saying it is.',
    '',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Ownership: who may send what about which task
// ---------------------------------------------------------------------------

/**
 * The card-shaped facts the ownership rules need, and no more.
 *
 * Named rather than taking a `TerminalSession`, so the pure functions below can be driven from a
 * test's own fixtures without a database behind them. Everything here is read; nothing is written.
 */
export interface CardFacts {
  id: string
  title: string
  status: string
  closedAt: number | null
  roleClass: string | null
  ownedPaths: string[] | null
}

export interface GuardLookups {
  /** How a card is named to the sender. Falls back to the raw id, which beats "a card". */
  titleOf?: (id: string | null) => string
  /** Who a card answers to, or null when it answers to the owner. Used only by `assessment`. */
  reportsToOf?: (id: string) => string | null
}

/**
 * `reason` on an allow is for the case where the allow itself is worth saying out loud: a
 * reassignment away from a card that is no longer on the board at all is permitted, and the person
 * reading the reply should be told that is what happened rather than left to infer it from silence.
 */
export type GuardResult =
  | { allowed: true; next?: TaskState; reason?: string }
  | { allowed: false; rule: string; reason: string }

/** The kinds that must carry a task id. `question` and `answer` are deliberately not here. */
export const LIFECYCLE_KINDS: MailKind[] = ['work', 'review', 'remediation', 'done', 'confirm', 'assessment']

export function isLifecycleKind(kind: MailKind): boolean {
  return LIFECYCLE_KINDS.includes(kind)
}

/**
 * The sentence a sender reads when a lifecycle kind arrives with no task id.
 *
 * Shared with `garden-send.mjs`, which refuses the same thing locally before it posts, so a card
 * that forgot the flag reads one wording rather than two that differ by where it was caught.
 */
export function taskRequiredReason(kind: MailKind): string {
  return (
    `kind ${kind} is part of a task's life and has to say which task, so pass --task <id>. ` +
    'Without one Garden cannot tell whose work this is, and a message with no task id used to walk ' +
    'past the review-round and confirmation guards entirely, because an empty ledger has nothing in it.'
  )
}

/**
 * Who is allowed to be in a conversation about a task at all.
 *
 * The owner, the assigner, the verifier, and the owner of the parent task. Narrower than the wire,
 * on purpose: a wire says two cards may talk, and this says they may talk about this particular
 * piece of work.
 */
export function participantsOfTask(task: TaskContract, parentOwnerId: string | null): Set<string> {
  const s = new Set<string>()
  for (const id of [task.ownerId, task.assignerId, task.verifierId, parentOwnerId]) {
    if (id) s.add(id)
  }
  return s
}

/**
 * Canon 20's table of what each kind of mail means, as one function with no default that allows.
 *
 * Pure, so a test can walk every branch without a socket and so `/mail` and the `task.*` socket
 * handlers cannot drift into two readings of the same rule. It decides nothing about wires, review
 * rounds or confirmations: those guards ran before this one and still run after it, and ownership
 * only ever narrows what they already allowed.
 *
 * `next` is the state the task moves to when the send is allowed, absent when the kind changes
 * nothing. The caller writes it; this function touches no storage.
 */
export function ownershipGuard(
  task: TaskContract | undefined,
  kind: MailKind,
  fromId: string,
  toId: string,
  taskId: string | null,
  participantsOf: (t: TaskContract) => Set<string>,
  lookups: GuardLookups = {},
): GuardResult {
  const name = (id: string | null) => lookups.titleOf?.(id) ?? (id ? id : 'nobody')

  // A `question` or `answer` with no task id is a conversation, and Garden has never had anything
  // to say about those. They change no state and are not refused.
  if (!taskId) {
    if (isLifecycleKind(kind)) {
      return { allowed: false, rule: 'task-required', reason: taskRequiredReason(kind) }
    }
    return { allowed: true }
  }

  if (!task) {
    return {
      allowed: false,
      rule: 'no-such-task',
      reason:
        `no task ${taskId} on this board. Create it with garden-task.mjs create, naming the owner, ` +
        'then send this again. Garden will not open a task from the message itself, because a task ' +
        'nobody declared has no owner, and an ownerless task is what this guard exists to stop.',
    }
  }

  if (kind === 'question' || kind === 'answer') {
    const people = participantsOf(task)
    if (!people.has(fromId) || !people.has(toId)) {
      const who = !people.has(fromId) ? name(fromId) : name(toId)
      return {
        allowed: false,
        rule: 'not-participant',
        reason:
          `${who} is not part of task ${task.id}. Its owner is ${name(task.ownerId)}, it was assigned ` +
          `by ${name(task.assignerId)}, and its verifier is ${name(task.verifierId)}. Ask without a ` +
          '--task id if this is a general question.',
      }
    }
    return { allowed: true }
  }

  /*
   * A legacy task, which is most of what is on this board: an id Garden saw in its own mail history
   * and for which nobody ever declared an owner. Refused rather than guessed, because the sender is
   * the obvious guess and is wrong whenever a manager was relaying somebody else's work.
   */
  if (task.state === 'unbound' || !task.ownerId || !task.assignerId) {
    return {
      allowed: false,
      rule: 'unbound',
      /*
       * Bind, and never create.
       *
       * Two readers who had only the screen took the create-it wording next to a Bind button as two
       * ways of doing one job and could not tell which was meant. They are not two ways: the row
       * already exists, so creating is refused, and only a bind moves it out of `unbound`. The
       * remedy names the button first because that is what the reader is looking at.
       */
      reason:
        `${task.id} is on this board from old mail and nobody owns it yet. Its id appeared in ` +
        "Garden's mail history, where a task id was a label rather than a record, so there is a row " +
        'and no owner. Bind it, from the Tasks panel or with garden-task.mjs bind --task ' +
        `${task.id} --owner <card>, naming the owner. Do not create it: the row is already here, and ` +
        'nothing infers the owner from who sent this message.',
    }
  }

  const owner = task.ownerId
  const assigner = task.assignerId
  const verifier = task.verifierId

  const wrongState = (allowedStates: TaskState[]): GuardResult => ({
    allowed: false,
    rule: 'wrong-state',
    reason:
      `task ${task.id} is ${task.state}, and ${kind} applies when it is ${allowedStates.join(' or ')}. ` +
      'Nothing is guessed from the text of the message: the state is what the recorded hand-offs made it.',
  })

  switch (kind) {
    /*
     * Work goes from the card that assigned it to the card accountable for it, and nowhere else. A
     * dispatcher handing the same task to a second card is what "the work returns to the card that
     * built it" is written against, and it is refused here rather than discouraged in a brief.
     */
    case 'work': {
      if (fromId !== assigner) {
        return {
          allowed: false,
          rule: 'not-owner',
          reason:
            `task ${task.id} was assigned by ${name(assigner)}, so work on it comes from there. If it ` +
            'should be yours to hand out, reassign it with a reason first.',
        }
      }
      if (toId !== owner) {
        return {
          allowed: false,
          rule: 'not-owner',
          reason:
            `work on ${task.id} goes to its owner, ${name(owner)}, not to ${name(toId)}. If the work ` +
            'has genuinely moved, reassign it with a reason, or split it so each piece has an owner of ' +
            'its own.',
        }
      }
      if (task.state !== 'assigned') return wrongState(['assigned'])
      return { allowed: true, next: 'working' }
    }

    case 'review': {
      if (fromId !== owner && fromId !== assigner) {
        return {
          allowed: false,
          rule: 'not-owner',
          reason:
            `${name(fromId)} is neither the owner nor the assigner of ${task.id}, so it cannot send it ` +
            `for review. Its owner is ${name(owner)}.`,
        }
      }
      if (!verifier) {
        return {
          allowed: false,
          rule: 'no-verifier',
          reason:
            `${task.id} has no independent verifier, so there is nobody for a review to go to. Set one ` +
            `with garden-task.mjs verifier --task ${task.id} --to <card>. It has to be a card that is ` +
            'neither the owner nor the assigner, which is what makes the check worth having.',
        }
      }
      if (toId !== verifier) {
        return {
          allowed: false,
          rule: 'not-verifier',
          reason:
            `review of ${task.id} goes to its verifier, ${name(verifier)}, not to ${name(toId)}. Picking ` +
            'a different reader for one round is how a task quietly stops being checked by somebody ' +
            'independent.',
        }
      }
      if (task.state !== 'working' && task.state !== 'remediating') {
        return wrongState(['working', 'remediating'])
      }
      return { allowed: true, next: 'in_review' }
    }

    /*
     * Criticism goes back to the card that built the thing. This is the rule the whole document is
     * for: a verifier that finds two faults in two cards' territory splits the task rather than
     * handing the fix to whoever is awake, and the refusal below says so.
     */
    case 'remediation': {
      if (fromId !== verifier && fromId !== assigner) {
        return {
          allowed: false,
          rule: 'not-verifier',
          reason:
            `remediation on ${task.id} comes from its verifier, ${name(verifier)}, or from the card that ` +
            `assigned it, ${name(assigner)}. ${name(fromId)} is neither.`,
        }
      }
      if (toId !== owner) {
        return {
          allowed: false,
          rule: 'not-owner',
          reason:
            `remediation on ${task.id} goes to its owner, ${name(owner)}, not to ${name(toId)}. If the ` +
            'fault is in work that card did not do, split the task so the piece has an owner, with ' +
            'garden-task.mjs split, and send each owner its own. Handing a fix to whichever card is ' +
            'awake is how the card that built something stops being the card that learns from it.',
        }
      }
      if (task.state !== 'in_review' && task.state !== 'done') {
        return wrongState(['in_review', 'done'])
      }
      return { allowed: true, next: 'remediating' }
    }

    case 'done': {
      if (fromId !== owner) {
        return {
          allowed: false,
          rule: 'not-owner',
          reason:
            `${task.id} is owned by ${name(owner)}, so only that card reports it done. ${name(fromId)} ` +
            'reporting on its behalf is the blind hand-off the chain exists to stop.',
        }
      }
      if (toId !== assigner) {
        return {
          allowed: false,
          rule: 'not-owner',
          reason: `done on ${task.id} goes back to ${name(assigner)}, which assigned it, not to ${name(toId)}.`,
        }
      }
      if (task.state !== 'working' && task.state !== 'remediating' && task.state !== 'in_review') {
        return wrongState(['working', 'remediating', 'in_review'])
      }
      return { allowed: true, next: 'done' }
    }

    case 'confirm': {
      if (fromId !== assigner) {
        return {
          allowed: false,
          rule: 'not-owner',
          reason:
            `${task.id} was assigned by ${name(assigner)}, and confirming work is that card saying it ` +
            `looked. ${name(fromId)} cannot accept it on their behalf.`,
        }
      }
      if (toId !== owner) {
        return {
          allowed: false,
          rule: 'not-owner',
          reason: `confirmation of ${task.id} goes to its owner, ${name(owner)}, not to ${name(toId)}.`,
        }
      }
      if (task.state !== 'done') return wrongState(['done'])
      return { allowed: true, next: 'confirmed' }
    }

    /*
     * An assessment is somebody saying whether the finished work is the thing that was asked for,
     * and it travels upward past the assigner.
     *
     * The recipient check is the one place this function is narrower than canon reads. Canon says it
     * goes to "the card above the assigner"; who that is lives in the org chart rather than on the
     * task, so it is checked only when the caller supplies a reporting line and the assigner has
     * one. An assigner that answers to the owner directly has no card above it, and refusing every
     * assessment on that board would be this rule inventing a chain that does not exist.
     */
    case 'assessment': {
      if (fromId !== verifier && fromId !== assigner) {
        return {
          allowed: false,
          rule: 'not-verifier',
          reason:
            `an assessment of ${task.id} comes from its verifier, ${name(verifier)}, or from ` +
            `${name(assigner)} which assigned it. ${name(fromId)} is neither.`,
        }
      }
      if (task.state !== 'done' && task.state !== 'confirmed') {
        return wrongState(['done', 'confirmed'])
      }
      const above = lookups.reportsToOf?.(assigner) ?? null
      if (above && toId !== above) {
        return {
          allowed: false,
          rule: 'not-participant',
          reason:
            `an assessment of ${task.id} goes above the card that assigned it, which is ${name(above)}, ` +
            `not ${name(toId)}.`,
        }
      }
      return { allowed: true }
    }
  }

  /*
   * No default that allows. A kind this function has not been taught is refused, because the one
   * failure mode a guard must not have is growing a hole every time something new is added beside it.
   */
  return {
    allowed: false,
    rule: 'wrong-state',
    reason: `Garden has no ownership rule for kind ${kind} on a task, so it refused rather than guessed.`,
  }
}

// ---------------------------------------------------------------------------
// Reassignment: the reason has to be true, not merely chosen
// ---------------------------------------------------------------------------

export interface ReassignLookups {
  now: number
  silenceMinutes: number
  lastActivityFor: (cardId: string) => number
  /** Another task on this board by id, for `blocked_elsewhere`. */
  taskById: (id: string) => TaskContract | undefined
  /** What `--blocked-by` named, for `blocked_elsewhere`, and nothing read out of the note. */
  blockedBy?: string | null
  titleOf?: (id: string | null) => string
}

/**
 * Whether the stated reason for moving a task is actually true right now.
 *
 * Every reason on the list is something Garden can check for itself, and that is the design rather
 * than a convenience: the owner's requirement is that work does not drift to whichever card is free,
 * and a reason nobody verifies is a free-text field with a dropdown in front of it. There is no
 * `convenience` and no `available`, so a reassignment for speed cannot be expressed at all.
 *
 * Pure. The caller writes the row; this only says whether it may.
 */
export function reassignEvidence(
  task: TaskContract,
  owner: CardFacts | undefined,
  to: CardFacts | undefined,
  reason: string,
  note: string,
  look: ReassignLookups,
): GuardResult {
  const name = (id: string | null) => look.titleOf?.(id) ?? (id ? id : 'nobody')

  if (!to) {
    return { allowed: false, rule: 'no-such-card', reason: 'the card to move this to is not on this board.' }
  }
  if (to.closedAt !== null) {
    return {
      allowed: false,
      rule: 'no-such-card',
      reason: `${to.title} has been taken off the board, so it cannot be given work.`,
    }
  }

  switch (reason) {
    case 'legacy_bind': {
      if (task.state !== 'unbound') {
        return {
          allowed: false,
          rule: 'wrong-state',
          reason:
            `${task.id} already has an owner, ${name(task.ownerId)}, so this is a reassignment rather ` +
            'than a bind. Give the real reason it is moving.',
        }
      }
      return { allowed: true }
    }

    case 'owner_stopped': {
      /*
       * No owner row at all is the strongest form of stopped: the card is not on the board any more.
       * It was already allowed, silently, which read from outside exactly like a check that had not
       * run. The allow is the same; it now says which of the two facts it allowed on.
       */
      if (!owner) {
        return {
          allowed: true,
          reason:
            `${name(task.ownerId)} is not on this board at all any more, which is owner_stopped in its ` +
            'strongest form: there is no card left to do the work.',
        }
      }
      const gone = owner.closedAt !== null || owner.status === 'stopped' || owner.status === 'failed'
      if (!gone) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason:
            `${owner.title} is ${owner.status} and still on the board, so owner_stopped is not true of ` +
            'it. A card that is merely busy is not a card that has stopped.',
        }
      }
      return { allowed: true }
    }

    case 'owner_silent': {
      /*
       * A card that is gone has not gone quiet, and this used to allow it. The two facts want
       * different rows in the history: silence is a card that is still there and gave no answer,
       * which is worth reading later as a card that could not keep up, and absence is a card that
       * no longer exists. Recording the second as the first loses the difference for good.
       */
      if (!owner) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason:
            `${name(task.ownerId)} is not on this board any more, so it has not gone quiet, it is gone. ` +
            'owner_stopped is the reason that is true of a card that is no longer there, and it is ' +
            'allowed for exactly this case.',
        }
      }
      const last = look.lastActivityFor(owner.id)
      /*
       * Never seen doing anything is not the same fact as gone quiet, and it is refused. A card made
       * a minute ago and not yet started has no activity, and accepting silence as the reason there
       * would let a dispatcher move work off a card before it had the chance to do any.
       */
      if (last === 0) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason:
            `Garden has never recorded ${owner.title} doing anything, so it has not gone quiet, it has ` +
            'not started. If it will not start, owner_stopped is the reason that is true.',
        }
      }
      const quietMs = look.now - last
      if (quietMs < look.silenceMinutes * 60_000) {
        const mins = Math.round(quietMs / 60_000)
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason:
            /*
             * This used to end "Change that figure on the board if it is wrong for this work". The
             * control it referred to was taken off the Ceiling panel on 2026-09-09, at the owner's
             * request and in his words: "remove 'silence before silent' field, idk what that is". A
             * sentence telling a card to go and change something that no longer has anywhere to be
             * changed from is worse than no sentence, so it says the figure and stops there.
             */
            `${owner.title} was last active ${mins} minute${mins === 1 ? '' : 's'} ago, and this board ` +
            `treats silence as ${look.silenceMinutes} minutes, so it has not been quiet long enough ` +
            'for owner_silent to be true yet.',
        }
      }
      return { allowed: true }
    }

    case 'missing_capability': {
      if (!task.requiredRole) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason: `${task.id} names no required role, so nobody can be missing it.`,
        }
      }
      if (owner && owner.roleClass === task.requiredRole) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason: `${owner.title} is a ${owner.roleClass}, which is what ${task.id} requires.`,
        }
      }
      if (to.roleClass !== task.requiredRole) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason:
            `${task.id} requires a ${task.requiredRole} and ${to.title} is ` +
            `${to.roleClass ?? 'not set to any role'}, so moving it there does not fix the thing being ` +
            'named as the reason.',
        }
      }
      /*
       * Deciding on the destination alone is right when the owner row is gone, and saying so is the
       * other half of it. The check that would have compared the old owner's role could not run, so
       * a row that does not mention it reads exactly like a row where it ran and passed.
       */
      if (!owner) {
        return {
          allowed: true,
          reason:
            `${name(task.ownerId)} is not on this board any more, so nothing could be compared ` +
            `against its role. Allowed on ${to.title} being a ${task.requiredRole}, which is what ` +
            `${task.id} requires.`,
        }
      }
      return { allowed: true }
    }

    case 'missing_territory': {
      if (task.territory.length === 0) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason: `${task.id} declares no territory, so no card can be missing it.`,
        }
      }
      if (owner && coversTerritory(owner.ownedPaths, task.territory)) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason: `${owner.title} already owns ${task.territory.join(', ')}, so missing_territory is not true of it.`,
        }
      }
      if (!coversTerritory(to.ownedPaths, task.territory)) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason:
            `${to.title} does not own ${task.territory.join(', ')} either, so the move does not fix the ` +
            'reason given for it. Widen what that card owns first.',
        }
      }
      // Same as `missing_capability` above: the owner-side half of the check could not run, and the
      // row says which half it allowed on rather than leaving a reader to assume both.
      if (!owner) {
        return {
          allowed: true,
          reason:
            `${name(task.ownerId)} is not on this board any more, so nothing could be compared ` +
            `against what it owned. Allowed on ${to.title} owning ${task.territory.join(', ')}.`,
        }
      }
      return { allowed: true }
    }

    /*
     * The blocking task is named in a field of its own, never scanned out of the note.
     *
     * It used to be read out of the note with a word-shaped regex, which is two bugs wearing one
     * coat: a note that mentions any task id in passing, in a sentence saying that task is finished,
     * passes; and a note that names the blocking task in prose Garden's pattern does not cut the
     * same way is refused for saying exactly the right thing. A field is unambiguous, and it leaves
     * the note as what a note is, free text nobody parses.
     */
    case 'blocked_elsewhere': {
      const wanted = String(look.blockedBy ?? '').trim()
      if (!wanted) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason:
            'blocked_elsewhere means this work is waiting on another task that somebody else holds, so ' +
            'name it with --blocked-by <task id>. Garden reads that field and nothing else; the note is ' +
            'yours to write and is never scanned for ids.',
        }
      }
      const found = look.taskById(wanted)
      if (!found) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason: `--blocked-by names ${wanted}, and there is no task with that id on this board.`,
        }
      }
      if (found.id === task.id) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason: `${task.id} cannot be blocked on itself.`,
        }
      }
      if (!found.ownerId || found.ownerId === task.ownerId) {
        return {
          allowed: false,
          rule: 'reason-untrue',
          reason:
            `${found.id} is owned by ${name(found.ownerId)}, so it is not work somebody else is holding ` +
            'this task up on. blocked_elsewhere is for a dependency in another card\'s hands.',
        }
      }
      return { allowed: true }
    }
  }

  return {
    allowed: false,
    rule: 'no-such-reason',
    reason:
      `${reason} is not one of the reasons work may change hands. They are owner_stopped, owner_silent, ` +
      'missing_capability, missing_territory, blocked_elsewhere and legacy_bind. There is deliberately ' +
      'no reason meaning "this card is free", because work moving to whoever is free is the thing task ' +
      'ownership exists to stop.',
  }
}

/**
 * Whether a card's owned paths cover every path a task claims.
 *
 * Null or empty owned paths means the card was given no territory at all, which everywhere else in
 * Garden reads as no restriction, so it covers anything.
 */
export function coversTerritory(ownedPaths: string[] | null, territory: string[]): boolean {
  if (!ownedPaths || ownedPaths.length === 0) return true
  return territory.every((t) => pathInsideAny(t, ownedPaths))
}

/**
 * Whether one path sits inside one of a list of paths.
 *
 * The matching is the hook's, deliberately, because the same question is asked in two places and two
 * answers to it would be a hole: a folder covers everything under it, a file matches itself, and the
 * comparison is on a path boundary so that owning `src/app` does not silently claim
 * `src/application`. Territory is written project-relative and the path arriving from a tool call is
 * absolute, which is why a suffix match counts.
 */
export function pathInsideAny(target: string, paths: string[]): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const file = norm(target)
  return paths.some((p) => {
    if (typeof p !== 'string' || !p) return false
    const own = norm(p)
    return file === own || file.startsWith(`${own}/`) || file.endsWith(`/${own}`) || file.includes(`/${own}/`)
  })
}

/**
 * Every verifier standing over this task or anything it descends from.
 *
 * A card cannot be handed a task it is verifying, and it cannot be handed a subtask of one either:
 * splitting a task and giving a piece to its verifier is the same loss of independence taken one
 * step at a time, and it would be easy to do by accident while doing the right thing everywhere
 * else. Walks upward, with a depth stop so a parent loop written by hand cannot hang the server.
 */
export function verifierAncestry(
  task: TaskContract,
  taskById: (id: string) => TaskContract | undefined,
): Set<string> {
  const out = new Set<string>()
  let cur: TaskContract | undefined = task
  let depth = 0
  while (cur && depth < 32) {
    if (cur.verifierId) out.add(cur.verifierId)
    cur = cur.parentId ? taskById(cur.parentId) : undefined
    depth++
  }
  return out
}
