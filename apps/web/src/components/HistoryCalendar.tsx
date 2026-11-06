import { memo, useEffect, useMemo, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { WorkRecord } from '@garden/shared'
import { actions, getHistoryDay, getWork, onHistoryGroups, onWork, useApp, type HistoryGroup } from '../state'

export const CAL_W = 760
export const CAL_H = 340

export type HistoryCalendarData = {
  sessionId: string
  title: string
  groups: HistoryGroup[]
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const keyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const tasksOf = (r: WorkRecord) => r.tasksCompleted ?? []
/** The rule the server writes history by (`hasSubstance`), so the list matches the day's count. */
const counted = (r: WorkRecord) => r.origin === 'agent' || r.filesTouched.length > 0 || tasksOf(r).length > 0
const took = (r: WorkRecord) => {
  if (r.endedAt == null) return 'still running'
  const s = Math.round((r.endedAt - r.startedAt) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * A card's history, as a calendar above the card. Canon 04, "History is a calendar".
 *
 * A month on the left, a day's turns on the right, and one turn in place of the list when one is
 * pressed. Nothing goes on the board as cards. The turns are the card's work records, which the page
 * already asks for, so this needs nothing from the server that it did not already answer.
 */
export const HistoryCalendar = memo(function HistoryCalendar({ data }: NodeProps) {
  const { sessionId, title, groups } = data as HistoryCalendarData
  const [, tick] = useState(0)
  useEffect(() => onHistoryGroups((id) => id === sessionId && tick((n) => n + 1)), [sessionId])
  useEffect(() => onWork((id) => id === sessionId && tick((n) => n + 1)), [sessionId])
  useEffect(() => actions.listWork(sessionId), [sessionId, groups])
  const sessions = useApp((s) => s.sessions)
  const day = getHistoryDay(sessionId)
  const records = getWork(sessionId)

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of groups) if (DAY_KEY.test(g.group)) m.set(g.group, g.count)
    return m
  }, [groups])
  const latest = useMemo(() => {
    const days = groups.filter((g) => DAY_KEY.test(g.group))
    return days.length ? Math.max(...days.map((g) => g.latest)) : Date.now()
  }, [groups])
  const reports = groups.find((g) => g.group === 'reports')
  const conversation = groups.find((g) => g.group === 'conversation')

  // Opens on the month of the latest turn.
  const [month, setMonth] = useState(() => {
    const d = new Date(latest)
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [openTurn, setOpenTurn] = useState<string | null>(null)
  useEffect(() => setOpenTurn(null), [day?.group])

  const cells = useMemo(() => {
    const lead = (month.getDay() + 6) % 7
    const out: Array<Date | null> = Array.from({ length: lead }, () => null)
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
    for (let i = 1; i <= days; i++) out.push(new Date(month.getFullYear(), month.getMonth(), i))
    while (out.length % 7) out.push(null)
    return out
  }, [month])
  const todayKey = keyOf(new Date())
  const monthTotal = cells.reduce((n, d) => n + (d ? counts.get(keyOf(d)) ?? 0 : 0), 0)

  const turns =
    day && records
      ? records
          .filter((r) => counted(r) && keyOf(new Date(r.startedAt)) === day.group)
          .sort((a, b) => b.startedAt - a.startedAt)
      : null
  const turn = turns?.find((t) => t.id === openTurn) ?? null
  const asker = (r: WorkRecord) =>
    r.origin === 'owner' ? 'you' : (r.parentId && sessions.find((s) => s.id === r.parentId)?.title) || 'another card'
  const dayLabel = day
    ? new Date(`${day.group}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    : null

  return (
    <div className="histcal nodrag nowheel" style={{ width: CAL_W, height: CAL_H }} data-control="history-calendar">
      <header className="histcal__head">
        <span className="histcal__title">History</span>
        <span className="histcal__who">{title}</span>
        <span className="histcal__spacer" />
        {conversation ? (
          <button
            className="histcal__chip"
            title="Open this agent's conversation, read from its transcript"
            onClick={() => actions.openTranscript(sessionId)}
          >
            Conversation
          </button>
        ) : null}
        {reports ? (
          <button
            className="histcal__chip"
            title="Open what came home from finished tasks"
            onClick={() => actions.openHistoryDay(sessionId, 'reports')}
          >
            Reports <b>{reports.count}</b>
          </button>
        ) : null}
        <button className="histcal__close" title="Close this history" onClick={() => actions.closeHistoryWeb(sessionId)}>
          ×
        </button>
      </header>

      <div className="histcal__body">
        <section className="histcal__month">
          <div className="histcal__nav">
            <button title="The month before" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
              ‹
            </button>
            <span>
              {month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
              <em>{monthTotal ? ` · ${monthTotal} turns` : ' · nothing'}</em>
            </span>
            <button title="The month after" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
              ›
            </button>
          </div>
          <div className="histcal__grid">
            {WEEKDAYS.map((w) => (
              <span key={w} className="histcal__wd">
                {w}
              </span>
            ))}
            {cells.map((d, i) => {
              if (!d) return <span key={i} />
              const k = keyOf(d)
              const n = counts.get(k) ?? 0
              return (
                <button
                  key={k}
                  className={`histcal__day${n ? ' has-work' : ''}${k === todayKey ? ' is-today' : ''}${day?.group === k ? ' is-open' : ''}`}
                  disabled={!n}
                  title={n ? `${n} turn${n === 1 ? '' : 's'} on this day` : 'Nothing on this day'}
                  onClick={() => actions.showHistoryDay(sessionId, day?.group === k ? null : k)}
                >
                  <span>{d.getDate()}</span>
                  {n ? <b>{n}</b> : null}
                </button>
              )
            })}
          </div>
        </section>

        <section className="histcal__side">
          {!day ? (
            <p className="histcal__hint">
              {conversation
                ? 'This agent ran inside its parent, so its record is its conversation.'
                : 'Press a day to read what this card did on it.'}
            </p>
          ) : turn ? (
            <>
              <div className="histcal__bar">
                <button title="Back to the day's list" onClick={() => setOpenTurn(null)}>
                  ‹ {dayLabel}
                </button>
                <span>
                  {time(turn.startedAt)} · {took(turn)}
                </span>
              </div>
              <div className="histcal__entry">
                <h4>Asked by {asker(turn)}</h4>
                <p className="histcal__asked">{turn.ask}</p>
                <h4>
                  Files changed <em>{turn.filesTouched.length}</em>
                </h4>
                {turn.filesTouched.length ? (
                  <ul>
                    {turn.filesTouched.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="histcal__none">None.</p>
                )}
                {tasksOf(turn).length ? (
                  <>
                    <h4>Tasks finished</h4>
                    <ul>
                      {tasksOf(turn).map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <p className="histcal__none">{turn.toolCalls} tool calls.</p>
              </div>
            </>
          ) : (
            <>
              <div className="histcal__bar">
                <span>{dayLabel}</span>
                <span>{turns ? `${turns.length} turn${turns.length === 1 ? '' : 's'}` : ''}</span>
              </div>
              {turns === null ? (
                <p className="histcal__hint">Reading…</p>
              ) : turns.length === 0 ? (
                <p className="histcal__hint">Nothing was recorded for this day.</p>
              ) : (
                <ul className="histcal__turns">
                  {turns.map((t) => (
                    <li key={t.id}>
                      <button title="Read this turn" onClick={() => setOpenTurn(t.id)}>
                        <span className="histcal__time">{time(t.startedAt)}</span>
                        <span className="histcal__ask">{t.ask.replace(/\s+/g, ' ').trim() || '(no prompt text)'}</span>
                        <span className="histcal__meta">
                          {asker(t) === 'you' ? 'you asked' : `${asker(t)} asked`}
                          {` · ${t.filesTouched.length} file${t.filesTouched.length === 1 ? '' : 's'}`}
                          {tasksOf(t).length ? ` · ${tasksOf(t).length} finished task${tasksOf(t).length === 1 ? '' : 's'}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
})
