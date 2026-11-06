import { memo, useEffect, useState, type CSSProperties } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { actions, getPipeline, onPipeline } from '../state'
import type { PipelineRun, PipelineStage } from '../pipeline-types'

/*
 * What a card's runs actually reached, drawn without claiming anything the events do not say.
 *
 * Three rules shape every pixel here, and they are the reason the panel is wordier than a row of
 * coloured squares would be.
 *
 * A stage has three states and they must look like three things. Reached is a filled cell. Never
 * happened is a flat, dim cell with the server's own sentence saying what was not seen. Not known
 * yet is hatched and dashed, borrowing the vocabulary the context gauge already uses for "no real
 * number", because a stage of an open run has not failed, it simply has not happened yet and
 * might still.
 *
 * A stage that was guessed at must not look like one that was observed. Two of the seven can be
 * guessed: a plan seen only as an ExitPlanMode call, and every review. Those carry an amber edge
 * and print the word inferred with the reason it is a guess. Everything else prints structured.
 * The word is there because a stranger looking at a screenshot cannot hover anything.
 *
 * Nothing may read as a pass. There is no tick, no green, no score and no percentage anywhere in
 * this file. A reached review means a command with "review" in it ran. A reached close means a
 * Bash call started with `git commit`, not that git accepted it. The panel says "seen" and then
 * shows the evidence, and the header says in words that seen is not passed.
 */

export type PipelineNodeData = {
  sessionId: string
  title: string
  width: number
  height: number
}

/** How many runs the panel draws before it stops, and says out loud that it stopped. */
const MAX_RUNS = 12
/** Evidence lines per stage before the cell says how many more there are. */
const MAX_EVIDENCE = 2

const STATE_WORD: Record<PipelineStage['state'], string> = {
  reached: 'seen',
  'not-reached': 'never happened',
  unknown: 'not known yet',
}

/*
 * Seconds are not decoration here.
 *
 * Four seeded runs all read 12/08 08:41 and a blind reviewer could not tell whether that was a stub
 * or three prompts inside one minute. The seconds are already in the timestamp, so showing them
 * settles it from the data rather than leaving a stranger to guess.
 */
function when(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Whether an evidence entry is a call that started or one that returned, read from the event type
 * the payload already carries.
 *
 * A blind reviewer noticed that a PostToolUse:Edit on a real file and a PreToolUse:Task that merely
 * requested a review are both drawn as "seen", and that six blue cells in a row scan as a clean run.
 * The distinction it wanted is real and it was already on screen as a prefix; this says it in words
 * instead. It is deliberately not a third colour: the two-colour provenance signal is the one thing
 * a stranger proved they can read at a glance, and a third meaning on that channel would dilute it.
 *
 * Null for the events that are not tool calls at all, such as UserPromptSubmit and SubagentStart.
 * They have no before and after to distinguish, so inventing one would be a claim about nothing.
 */
function callPhase(kind: string): string | null {
  if (kind.startsWith('PreToolUse')) return 'the call started'
  if (kind.startsWith('PostToolUse')) return 'the call returned'
  return null
}

/** A path or a command, shortened from the left so the end that identifies it survives. */
function tail(s: string, max = 46): string {
  if (s.length <= max) return s
  return '…' + s.slice(s.length - max + 1)
}

function StageCell({ stage }: { stage: PipelineStage }) {
  const reached = stage.state === 'reached'
  const inferred = stage.provenance === 'inferred'
  return (
    <div
      className={`pstage pstage--${stage.state} ${reached && inferred ? 'pstage--inferred' : ''}`}
      title={stage.why || `${stage.evidence.length} event${stage.evidence.length === 1 ? '' : 's'}`}
    >
      <div className="pstage__head">
        <span className="pstage__label">{stage.label}</span>
      </div>
      <div className="pstage__state">{STATE_WORD[stage.state]}</div>
      {reached && (
        <div className={`pstage__prov ${inferred ? 'is-inferred' : ''}`}>
          {inferred ? 'inferred: a pattern matched, this could be wrong' : 'structured: a hook payload said so'}
        </div>
      )}
      {reached ? (
        <ul className="pstage__ev">
          {stage.evidence.slice(0, MAX_EVIDENCE).map((e, i) => (
            <li key={i}>
              <span className="pstage__kind">{e.kind}</span>
              {callPhase(e.kind) && <span className="pstage__phase">{callPhase(e.kind)}</span>}
              <span className="pstage__detail">{tail(e.detail)}</span>
            </li>
          ))}
          {stage.evidence.length > MAX_EVIDENCE && (
            <li className="pstage__more">and {stage.evidence.length - MAX_EVIDENCE} more of these</li>
          )}
        </ul>
      ) : (
        // The server's own sentence, verbatim. It is guaranteed to describe the rule that actually
        // ran; anything written here instead would only be guaranteed to describe what this file
        // believed the rule was on the day it was written.
        <div className="pstage__why">{stage.why}</div>
      )}
    </div>
  )
}

function RunRow({ run }: { run: PipelineRun }) {
  const open = run.endedAt === null
  return (
    <div className="prun">
      <div className="prun__head">
        <span className={`chip ${open ? 'chip--open' : 'chip--muted'}`}>{open ? 'still running' : 'finished'}</span>
        <span className="prun__when">{when(run.startedAt)}</span>
        <span className="prun__ask" title={run.ask}>
          {run.ask}
        </span>
      </div>
      {open && (
        <div className="prun__note">
          This run has not ended, so a stage with nothing behind it is drawn as not known yet rather
          than as never happened.
        </div>
      )}
      <div className="prun__stages">
        {run.stages.map((s) => (
          <StageCell key={s.id} stage={s} />
        ))}
      </div>
    </div>
  )
}

/** The three appearances and the two provenances, said once at the top rather than per cell. */
function Legend() {
  return (
    <div className="plegend">
      <span className="plegend__item">
        <span className="plegend__swatch plegend__swatch--reached" />
        seen: the command ran or the file was written
      </span>
      <span className="plegend__item">
        <span className="plegend__swatch plegend__swatch--none" />
        never happened: the run ended without it
      </span>
      <span className="plegend__item">
        <span className="plegend__swatch plegend__swatch--unknown" />
        not known yet: the run is still open
      </span>
      <span className="plegend__item">
        <span className="plegend__swatch plegend__swatch--inferred" />
        amber edge: inferred, a pattern matched and could be wrong
      </span>
    </div>
  )
}

export const PipelineNode = memo(function PipelineNode({ data }: NodeProps) {
  const { sessionId, title, width, height } = data as PipelineNodeData
  const [, bump] = useState(0)

  useEffect(
    () =>
      onPipeline((id) => {
        if (id === sessionId) bump((n) => n + 1)
      }),
    [sessionId],
  )

  const answer = getPipeline(sessionId)
  const runs = answer ? [...answer.runs].sort((a, b) => b.startedAt - a.startedAt) : []
  const shown = runs.slice(0, MAX_RUNS)

  return (
    <div className="node node--pipeline" style={{ width, height } as CSSProperties}>
      {/* The panel hangs off the card it is about, so its wire arrives on the left, the same side
          every other card receives on. */}
      <Handle id="in" type="target" position={Position.Left} className="node-pin" />

      <header className="node-head pipe-head">
        {/* Tenseless on purpose. "How X ran" was past tense over a row that was still running,
            which a blind reviewer picked up on: the panel is about runs in progress as much as
            finished ones, and "reached" is the word the server itself uses. */}
        <span className="node-title" title={title}>
          {title}: what its runs reached
        </span>
        <button
          className="btn btn--ghost nodrag"
          title="Ask the server again. A run that is still open changes stage without any event saying so."
          onClick={() => actions.readPipeline(sessionId)}
        >
          Refresh
        </button>
        <button
          className="twisty nodrag"
          title="Fold this away"
          onClick={() => actions.closePipeline(sessionId)}
        >
          –
        </button>
      </header>

      <div className="pipe-claim">
        Seen means the command ran or the file was written, and nothing more. A seen review does not
        mean a review passed. A seen close means a Bash call began with git commit, not that git
        accepted it.
      </div>

      {/*
        The project summary belongs at the head of this surface, and it is not available.

        `pipelineSummary` exists on the server and is called by nothing: no protocol message
        carries it, so reaching it needs a backend edit that is gated behind a restart window.
        Drawn as a known gap in the same hatched vocabulary a stage uses, because the alternative
        is drawing zeros, and a zero here would be a claim that no run in this project reached any
        stage, which is false.

        Shortened from three lines to one after a blind reviewer said the panel's most prominent
        element was the thing that does not work. Every clause it approved of is still here; what
        went was the restatement of what the number would have been.
      */}
      <div className="pipe-summary">
        <span className="pipe-summary__title">Across this project:</span>{' '}
        <span className="pipe-summary__body">
          not available, because nothing carries the project totals to this page yet. Left blank
          rather than shown as zero: zero would be a claim, and the wrong one.
        </span>
      </div>

      <Legend />

      <div className="pipe-runs nowheel nodrag">
        {answer === undefined ? (
          <div className="pipe-empty">Asking the server what this card's runs reached.</div>
        ) : runs.length === 0 ? (
          <div className="pipe-empty">
            Garden has no recorded runs for this card. That is what the store holds, not a statement
            that the card has done nothing: a run is recorded from a UserPromptSubmit hook, so a
            card whose hooks are not installed has no runs here.
          </div>
        ) : (
          shown.map((r) => <RunRow key={r.workId} run={r} />)
        )}
        {runs.length > MAX_RUNS && (
          <div className="pipe-empty">
            {runs.length - MAX_RUNS} older run{runs.length - MAX_RUNS === 1 ? ' is' : 's are'} not
            drawn. Newest first.
          </div>
        )}
        {answer && answer.unreadable > 0 && (
          <div className="pipe-empty">
            {answer.unreadable} run{answer.unreadable === 1 ? '' : 's'} arrived in a shape this page
            could not read, and {answer.unreadable === 1 ? 'is' : 'are'} left out rather than drawn
            half-empty.
          </div>
        )}
      </div>
    </div>
  )
})
