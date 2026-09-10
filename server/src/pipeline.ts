/**
 * The owner's standing request, made checkable.
 *
 * He describes the same workflow every time in prose: turn an unstructured ask into a canon doc,
 * turn the canon doc into a plan, dispatch the plan to coding agents, then close the loop with a
 * review and a commit. He says an agent agreed to that shape and then sometimes followed it and
 * sometimes didn't, and today the only way to find out is to reread the transcript by hand. This
 * file answers the question from the same events the rest of Garden already trusts, and nothing
 * else: no stage here is ever set from silence or from reading an agent's prose to guess intent.
 *
 * Every stage carries a provenance. `structured` means a hook payload or a file path said so in a
 * way that cannot be misread: a Write landed on a path, a SubagentStart fired, a Bash command's
 * first word was `git commit`. `inferred` means a pattern matched something that could be wrong,
 * such as a task description that merely mentions "review". A stage that never has any evidence
 * either way stays `not-reached` if the run is closed, or `unknown` if the run is still open and
 * silence might just mean "hasn't happened yet" rather than "never will".
 */
import type { AgentEvent, WorkRecord } from '@garden/shared'
import type { Store } from './store.js'

export type StageId = 'intake' | 'canon' | 'plan' | 'dispatch' | 'code' | 'review' | 'close'
export type StageState = 'reached' | 'not-reached' | 'unknown'
export type StageProvenance = 'structured' | 'inferred'

export interface StageEvidence {
  ts: number
  /** The event type or tool name the evidence came from, e.g. 'PostToolUse:Edit'. */
  kind: string
  detail: string
}

export interface PipelineStage {
  id: StageId
  label: string
  state: StageState
  provenance: StageProvenance
  evidence: StageEvidence[]
  /** Shown to the owner when the stage is not reached or unknown. Literal and specific. */
  why: string
}

export interface PipelineRun {
  workId: string
  sessionId: string
  promptId: string | null
  ask: string
  startedAt: number
  endedAt: number | null
  stages: PipelineStage[]
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Field names arrive snake_case on stdin, same convention as ingest.ts. */
function pick(o: Record<string, unknown>, ...names: string[]): string | null {
  for (const n of names) {
    const v = o[n]
    if (typeof v === 'string' && v) return v
  }
  return null
}

function toolInputOf(e: Record<string, unknown>): Record<string, unknown> | undefined {
  return (e.tool_input ?? e.toolInput) as Record<string, unknown> | undefined
}

function filePathOf(e: Record<string, unknown>): string | null {
  const input = toolInputOf(e)
  return typeof input?.file_path === 'string' ? input.file_path : null
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * A path Garden treats as a canon document: `docs/canonical/**` or anything ending
 * `-truth.md`, matched loosely on the normalised path so it works regardless of drive letter
 * or working directory.
 */
function isCanonPath(p: string): boolean {
  const n = normPath(p)
  return n.includes('/docs/canonical/') || n.startsWith('docs/canonical/') || n.endsWith('-truth.md')
}

/** A path Garden treats as a plan document: a work order or a file under `.claude/plans/`. */
function isPlanPath(p: string): boolean {
  const n = normPath(p)
  return n.includes('/.claude/work-orders/') || n.includes('/.claude/plans/')
}

const REVIEW_WORDS = /(blind.?review|double.?blind|code.?review|\breview(er)?\b)/i

function mentionsReview(...vals: Array<string | null | undefined>): boolean {
  return vals.some((v) => !!v && REVIEW_WORDS.test(v))
}

/** Events belonging to one run: by prompt_id when the run has one, else by its time window. */
function eventsForRun(store: Store, run: WorkRecord, all: AgentEvent[]): AgentEvent[] {
  if (run.promptId) {
    return all.filter((e) => (e.payload as Record<string, unknown>)?.prompt_id === run.promptId)
  }
  const end = run.endedAt ?? Number.POSITIVE_INFINITY
  return all.filter((e) => e.ts >= run.startedAt && e.ts <= end)
}

function payloadOf(e: AgentEvent): Record<string, unknown> {
  return (e.payload ?? {}) as Record<string, unknown>
}

/** intake: the UserPromptSubmit that opened this run. Every WorkRecord has one by construction. */
function stageIntake(run: WorkRecord): PipelineStage {
  return {
    id: 'intake',
    label: 'Intake',
    state: 'reached',
    provenance: 'structured',
    evidence: [{ ts: run.startedAt, kind: 'UserPromptSubmit', detail: run.ask.slice(0, 120) }],
    why: '',
  }
}

function stageCanon(events: AgentEvent[], closed: boolean): PipelineStage {
  const hits: StageEvidence[] = []
  for (const e of events) {
    if (e.type !== 'PostToolUse') continue
    const p = payloadOf(e)
    const tool = pick(p, 'tool_name', 'toolName')
    if (!tool || !WRITE_TOOLS.has(tool)) continue
    const file = filePathOf(p)
    if (!file || !isCanonPath(file)) continue
    hits.push({ ts: e.ts, kind: `PostToolUse:${tool}`, detail: file })
  }
  if (hits.length) {
    return {
      id: 'canon',
      label: 'Canon doc',
      state: 'reached',
      provenance: 'structured',
      // Deliberately just the paths and the count: a file changing is proven, whether it actually
      // satisfies the ask is not something an event stream can say.
      evidence: hits,
      why: '',
    }
  }
  return {
    id: 'canon',
    label: 'Canon doc',
    state: closed ? 'not-reached' : 'unknown',
    provenance: 'structured',
    evidence: [],
    why: closed
      ? 'no write under docs/canonical/ or to a *-truth.md file was seen in this run'
      : 'run is still open; no canon write seen yet',
  }
}

function stagePlan(events: AgentEvent[], closed: boolean): PipelineStage {
  const fileHits: StageEvidence[] = []
  const exitPlanHits: StageEvidence[] = []
  for (const e of events) {
    if (e.type !== 'PostToolUse' && e.type !== 'PreToolUse') continue
    const p = payloadOf(e)
    const tool = pick(p, 'tool_name', 'toolName')
    if (tool === 'ExitPlanMode' && e.type === 'PreToolUse') {
      exitPlanHits.push({ ts: e.ts, kind: 'PreToolUse:ExitPlanMode', detail: 'ExitPlanMode tool call' })
      continue
    }
    if (e.type !== 'PostToolUse' || !tool || !WRITE_TOOLS.has(tool)) continue
    const file = filePathOf(p)
    if (!file || !isPlanPath(file)) continue
    fileHits.push({ ts: e.ts, kind: `PostToolUse:${tool}`, detail: file })
  }
  if (fileHits.length) {
    return {
      id: 'plan',
      label: 'Plan',
      state: 'reached',
      provenance: 'structured',
      evidence: fileHits,
      why: '',
    }
  }
  if (exitPlanHits.length) {
    return {
      id: 'plan',
      label: 'Plan',
      state: 'reached',
      // ExitPlanMode says the agent believes it presented a plan, not that a plan file exists.
      // That distinction is the whole reason the two provenances exist.
      provenance: 'inferred',
      evidence: exitPlanHits,
      why: '',
    }
  }
  return {
    id: 'plan',
    label: 'Plan',
    state: closed ? 'not-reached' : 'unknown',
    provenance: 'structured',
    evidence: [],
    why: closed
      ? 'no write into .claude/work-orders/ or .claude/plans/, and no ExitPlanMode call, seen in this run'
      : 'run is still open; no plan write or ExitPlanMode call seen yet',
  }
}

function stageDispatch(events: AgentEvent[], closed: boolean): PipelineStage {
  const hits: StageEvidence[] = []
  for (const e of events) {
    if (e.type !== 'SubagentStart' && e.type !== 'SubagentStop') continue
    const p = payloadOf(e)
    const agentType = pick(p, 'agent_type', 'agentType', 'agent_name', 'agentName')
    const agentId = pick(p, 'agent_id', 'agentId')
    hits.push({
      ts: e.ts,
      kind: e.type,
      detail: [agentType, agentId].filter(Boolean).join(' / ') || 'subagent',
    })
  }
  if (hits.length) {
    return {
      id: 'dispatch',
      label: 'Dispatch',
      state: 'reached',
      provenance: 'structured',
      evidence: hits,
      why: '',
    }
  }
  return {
    id: 'dispatch',
    label: 'Dispatch',
    state: closed ? 'not-reached' : 'unknown',
    provenance: 'structured',
    evidence: [],
    why: closed
      ? 'no SubagentStart/SubagentStop event seen in this run'
      : 'run is still open; no subagent dispatched yet',
  }
}

function stageCode(events: AgentEvent[], closed: boolean): PipelineStage {
  const hits: StageEvidence[] = []
  for (const e of events) {
    if (e.type !== 'PostToolUse') continue
    const p = payloadOf(e)
    const tool = pick(p, 'tool_name', 'toolName')
    if (!tool || !WRITE_TOOLS.has(tool)) continue
    const file = filePathOf(p)
    if (!file || isCanonPath(file) || isPlanPath(file)) continue
    hits.push({ ts: e.ts, kind: `PostToolUse:${tool}`, detail: file })
  }
  if (hits.length) {
    return {
      id: 'code',
      label: 'Code',
      state: 'reached',
      provenance: 'structured',
      evidence: hits,
      why: '',
    }
  }
  return {
    id: 'code',
    label: 'Code',
    state: closed ? 'not-reached' : 'unknown',
    provenance: 'structured',
    evidence: [],
    why: closed
      ? 'no write outside the canon and plan paths was seen in this run'
      : 'run is still open; no code write seen yet',
  }
}

function stageReview(events: AgentEvent[], closed: boolean): PipelineStage {
  const hits: StageEvidence[] = []
  for (const e of events) {
    if (e.type !== 'PreToolUse' && e.type !== 'PostToolUse' && e.type !== 'SubagentStart') continue
    const p = payloadOf(e)
    const tool = pick(p, 'tool_name', 'toolName')
    const input = toolInputOf(p)
    const command = typeof input?.command === 'string' ? input.command : null
    const description = typeof input?.description === 'string' ? input.description : null
    const subagentType = typeof input?.subagent_type === 'string' ? input.subagent_type : null
    const agentType = pick(p, 'agent_type', 'agentType')
    if (!mentionsReview(command, description, subagentType, agentType)) continue
    const detail = command ?? description ?? subagentType ?? agentType ?? tool ?? 'review'
    hits.push({ ts: e.ts, kind: `${e.type}${tool ? ':' + tool : ''}`, detail })
  }
  if (hits.length) {
    return {
      id: 'review',
      label: 'Review',
      state: 'reached',
      // A name or a command containing "review" is a pattern match on prose, not proof the
      // review actually ran to completion or found anything. Say only that a review command ran.
      provenance: 'inferred',
      evidence: hits,
      why: '',
    }
  }
  return {
    id: 'review',
    label: 'Review',
    state: closed ? 'not-reached' : 'unknown',
    provenance: 'structured',
    evidence: [],
    why: closed
      ? 'no tool call naming a review or reviewer was seen in this run'
      : 'run is still open; no review command seen yet',
  }
}

function stageClose(events: AgentEvent[], closed: boolean): PipelineStage {
  const hits: StageEvidence[] = []
  for (const e of events) {
    if (e.type !== 'PreToolUse' && e.type !== 'PostToolUse') continue
    const p = payloadOf(e)
    const tool = pick(p, 'tool_name', 'toolName')
    if (tool !== 'Bash') continue
    const input = toolInputOf(p)
    const command = typeof input?.command === 'string' ? input.command.trim() : ''
    if (!command.startsWith('git commit')) continue
    hits.push({ ts: e.ts, kind: `${e.type}:Bash`, detail: command.slice(0, 200) })
  }
  if (hits.length) {
    return {
      id: 'close',
      label: 'Close',
      state: 'reached',
      // The command ran (or was about to). Whether git accepted it is not visible from a hook
      // payload, so this claims exactly "the command ran", never "the commit succeeded".
      provenance: 'structured',
      evidence: hits,
      why: '',
    }
  }
  return {
    id: 'close',
    label: 'Close',
    state: closed ? 'not-reached' : 'unknown',
    provenance: 'structured',
    evidence: [],
    why: closed
      ? 'no Bash call starting with "git commit" was seen in this run'
      : 'run is still open; no git commit seen yet',
  }
}

export function derivePipeline(store: Store, sessionId: string): PipelineRun[] {
  const work = [...store.listWork(sessionId)].sort((a, b) => a.startedAt - b.startedAt)
  const allEvents = store.listEvents(sessionId)

  return work.map((run) => {
    const closed = run.endedAt != null
    const events = eventsForRun(store, run, allEvents)
    const stages: PipelineStage[] = [
      stageIntake(run),
      stageCanon(events, closed),
      stagePlan(events, closed),
      stageDispatch(events, closed),
      stageCode(events, closed),
      stageReview(events, closed),
      stageClose(events, closed),
    ]
    return {
      workId: run.id,
      sessionId: run.sessionId,
      promptId: run.promptId,
      ask: run.ask,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      stages,
    }
  })
}

/**
 * How many runs, across every session in a project, reached each stage.
 *
 * This is the number the owner actually asked for: not "did the last run follow the workflow"
 * but "out of everything this project did, how much of it actually did". A session with no
 * project match, or a project with no sessions, returns zero counts rather than throwing, because
 * an empty project is a fact worth showing, not an error.
 */
export interface PipelineSummary {
  projectId: string
  totalRuns: number
  reached: Record<StageId, number>
}

export function pipelineSummary(store: Store, projectId: string): PipelineSummary {
  const stageIds: StageId[] = ['intake', 'canon', 'plan', 'dispatch', 'code', 'review', 'close']
  const reached: Record<StageId, number> = {
    intake: 0,
    canon: 0,
    plan: 0,
    dispatch: 0,
    code: 0,
    review: 0,
    close: 0,
  }
  const sessions = store.listSessions().filter((s) => s.projectId === projectId)
  let totalRuns = 0
  for (const session of sessions) {
    const runs = derivePipeline(store, session.id)
    totalRuns += runs.length
    for (const run of runs) {
      for (const stage of run.stages) {
        if (stage.state === 'reached') reached[stage.id]++
      }
    }
  }
  return { projectId, totalRuns, reached }
}
