import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Finding } from '@garden/shared'
import { dismissFinding, getFindings, getOverseer, onFindings, pauseKeeper } from '../findings'
import { useApp } from '../state'

/**
 * The Keeper's card, opened on what the overseer is doing rather than on its terminal.
 * docs/canonical/27-the-overseer.md, "The overseer card".
 *
 * The owner asked for it to be "easier to understand", so every section answers one plain question
 * in words, in the order someone glancing at it would ask them: is it on, is anything wrong, is the
 * machine coping, when does it look next, and what has it done. Every figure is the server's; the
 * page only formats times.
 */
export function OverseerView() {
  const view = useSyncExternalStore(onFindings, getOverseer)
  const findings = useSyncExternalStore(onFindings, getFindings)
  const sessions = useApp((s) => s.sessions)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [])

  if (!view) return <div className="ov ov--empty nowheel">Waiting for the first report from the server.</div>

  const { keeper, machine, rhythm } = view
  const open = [...findings].sort((a, b) => rank(b) - rank(a) || b.lastSeen - a.lastSeen)
  const needs = open.filter((f) => f.severity !== 'info' && f.state === 'open')
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title
  const state = keeper.paused ? 'paused' : keeper.running ? 'watching' : 'asleep'

  return (
    <div className="ov nowheel nodrag">
      {/* 1. Now */}
      <section className={`ov-now ov-now--${state}`}>
        <span className="ov-now__dot" aria-hidden />
        <div className="ov-now__text">
          <strong>
            {state === 'paused' ? 'Paused by you' : state === 'watching' ? 'Watching the board' : 'Asleep, wakes on the next problem'}
          </strong>
          <span>
            {state === 'paused'
              ? 'Nothing wakes it until you resume. The watchdog still records problems below.'
              : needs.length
                ? `${needs.length} thing${needs.length === 1 ? '' : 's'} need${needs.length === 1 ? 's' : ''} looking at.`
                : 'Nothing is wrong right now.'}
            {view.queued ? ` ${view.queued} waiting to be sent to it.` : ''}
          </span>
        </div>
        <button className="ov-btn" onClick={() => pauseKeeper(!keeper.paused)}>
          {keeper.paused ? 'Resume' : 'Pause'}
        </button>
      </section>

      {/* 2. Problems */}
      <section className="ov-sec">
        <h4>Problems</h4>
        {open.length === 0 ? (
          <p className="ov-quiet">None. The watchdog checks every few seconds.</p>
        ) : (
          <ul className="ov-list">
            {open.map((f) => (
              <li key={f.id} className={`ov-item ov-item--${f.severity}`}>
                <span className="ov-item__dot" aria-hidden />
                <div className="ov-item__text">
                  <span className="ov-item__title">{f.title}</span>
                  <span className="ov-item__meta">
                    {[
                      SEVERITY_WORD[f.severity],
                      f.subject && titleOf(f.subject) && !f.title.includes(titleOf(f.subject)!) ? titleOf(f.subject) : null,
                      f.count > 1 ? `${f.count} times` : null,
                      ago(f.lastSeen),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {f.note && <span className="ov-item__note">{STATE_WORD[f.state] ?? ''}{f.note}</span>}
                </div>
                <button className="ov-x" title="Dismiss for an hour" aria-label="Dismiss" onClick={() => dismissFinding(f.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. Machine */}
      <section className="ov-sec">
        <h4>This PC</h4>
        <div className="ov-meters">
          <Meter label="CPU" value={machine.cpuPct} text={`${machine.cpuPct}% of ${machine.cores} cores`} warnAt={90} />
          <Meter
            label="Free memory"
            value={Math.max(0, 100 - Math.min(100, machine.freeMemGB * 12.5))}
            text={`${machine.freeMemGB} GB free`}
            warnAt={75}
          />
        </div>
        {machine.top.length > 0 && (
          <ul className="ov-top">
            {machine.top.slice(0, 4).map((t) => (
              <li key={t.name}>
                <span>{t.name}</span>
                <span className="ov-top__cards">{t.cards.join(', ')}</span>
                <span className="ov-top__pct">{t.pct}%</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4. Rhythm */}
      <section className="ov-sec">
        <h4>When it looks</h4>
        <dl className="ov-rhythm">
          <dt>Glance at the page</dt>
          <dd>every {rhythm.glanceMinutes} min · {rhythm.lastGlanceAt ? `last ${ago(rhythm.lastGlanceAt)}` : 'not yet'} · next {until(rhythm.nextGlanceAt)}</dd>
          <dt>Full patrol</dt>
          <dd>every {rhythm.patrolMinutes} min · {rhythm.lastPatrolAt ? `last ${ago(rhythm.lastPatrolAt)}` : 'not yet'} · next {until(rhythm.nextPatrolAt)}</dd>
          <dt>Woken for a problem</dt>
          <dd>{rhythm.lastWokenAt ? ago(rhythm.lastWokenAt) : 'not yet'}</dd>
        </dl>
        <p className="ov-quiet">Glances and patrols run only while another card is running.</p>
      </section>

      {/* 5. Lately */}
      <section className="ov-sec">
        <h4>What was done</h4>
        {view.lately.length === 0 ? (
          <p className="ov-quiet">Nothing yet.</p>
        ) : (
          <ul className="ov-list">
            {view.lately.map((f) => (
              <li key={f.id} className="ov-done">
                <span className="ov-done__when">{ago(f.lastSeen)}</span>
                <span className="ov-done__what">
                  <span className="ov-item__title">{f.title}</span>
                  <span className="ov-item__note">{f.note}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Meter({ label, value, text, warnAt }: { label: string; value: number; text: string; warnAt: number }) {
  return (
    <div className={`ov-meter${value >= warnAt ? ' is-warn' : ''}`}>
      <span className="ov-meter__label">{label}</span>
      <span className="ov-meter__bar">
        <span style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </span>
      <span className="ov-meter__text">{text}</span>
    </div>
  )
}

const rank = (f: Finding) => (f.severity === 'act' ? 2 : f.severity === 'warn' ? 1 : 0)
const SEVERITY_WORD: Record<Finding['severity'], string> = { act: 'needs action', warn: 'worth a look', info: 'fixed itself' }
const STATE_WORD: Partial<Record<Finding['state'], string>> = { handled: 'Done: ', escalated: 'Needs you: ' }

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

function until(at: number): string {
  const m = Math.max(0, Math.round((at - Date.now()) / 60_000))
  return m < 1 ? 'within a minute' : `in ${m} min`
}
