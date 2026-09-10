/**
 * A local copy of the pipeline shapes the server derives, and it is a duplicate on purpose.
 *
 * `server/src/pipeline.ts` exports `PipelineRun`, `PipelineStage` and `StageEvidence`, and the
 * protocol message that carries them is typed `runs: unknown[]` in `packages/shared`. Widening
 * that one field is a one-line edit and it is the wrong edit to make from here: this board runs
 * under `tsx watch`, `packages/shared` resolves from source with no dist boundary, and saving in
 * either place restarts the backend and kills every live card on the board. So the shapes are
 * mirrored here instead.
 *
 * This file should be deleted when a window opens to edit the shared package. At that point
 * `ServerMessage` can carry `runs: PipelineRun[]` and every reader gets the real type. Until then
 * the risk is the ordinary one for a duplicate: the server can change its shape and nothing here
 * will complain, which is why `asPipelineRuns` below checks rather than casts.
 */

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
  /** Written by the server for the owner, and shown verbatim rather than paraphrased. */
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

const STATES = new Set(['reached', 'not-reached', 'unknown'])
const PROVENANCES = new Set(['structured', 'inferred'])

/**
 * Turn the wire's `unknown[]` into runs, dropping anything that does not have the two fields the
 * whole view rests on.
 *
 * A cast would be shorter and would let a stage with a missing state render as an empty cell,
 * which is the exact failure this view exists to avoid: an unknown thing drawn as nothing. A run
 * that fails this check is left out and counted, so the panel can say how many it could not read
 * rather than quietly showing fewer.
 */
export function asPipelineRuns(raw: unknown[]): { runs: PipelineRun[]; unreadable: number } {
  const runs: PipelineRun[] = []
  let unreadable = 0
  for (const item of raw) {
    const r = item as Partial<PipelineRun>
    const stages = Array.isArray(r?.stages) ? r.stages : null
    const ok =
      typeof r?.workId === 'string' &&
      typeof r?.startedAt === 'number' &&
      stages !== null &&
      stages.every(
        (s) =>
          s &&
          typeof s.label === 'string' &&
          STATES.has(s.state as string) &&
          PROVENANCES.has(s.provenance as string),
      )
    if (ok) runs.push(item as PipelineRun)
    else unreadable++
  }
  return { runs, unreadable }
}
