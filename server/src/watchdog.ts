/**
 * The watchdog: the part of the overseer that needs no AI. docs/canonical/27-the-overseer.md.
 *
 * Every incident of 22 and 23 September was noticed by the owner looking and fixed by somebody
 * reading the database, and most of the fixes were mechanical. This measures the same things every
 * few seconds, repairs what is safe to repair, and writes the rest down as a finding, one live row
 * per kind and subject.
 *
 * Nothing here blocks the event loop for longer than a stat or a small query. The one expensive
 * look, the process table, is an asynchronous child process once a minute, because the watchdog
 * exists partly to catch the server freezing and must not be a cause of it.
 *
 * What it never does: delete anything other than a stale git lock the owner said may go, kill a
 * process, start or stop a card, or restart anything.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { cpus, freemem } from 'node:os'
import { dirname, join } from 'node:path'
import type { Finding, ServerMessage, TerminalSession } from '@garden/shared'
import type { Store } from './store.js'

export interface WatchdogDeps {
  store: Store
  broadcast: (msg: ServerMessage) => void
  dbPath: string
  isLive: (id: string) => boolean
  lastByteAt: (id: string) => number
  unread: (id: string) => number
  heldSince: (id: string) => number | undefined
  terminalTail: (id: string, lines: number) => string
  /** A Claude card whose CLI has exited and left its shell at a prompt. */
  atShellPrompt: (id: string) => boolean
  /** A finding of severity `act` opened or recurred. The Keeper is woken from here once it exists. */
  onAct?: (f: Finding) => void
}

/** What a sensor reports on one tick. Becomes a finding, or moves one. */
export interface Condition {
  kind: string
  subject: string
  projectId?: string | null
  severity: Finding['severity']
  title: string
  detail?: string | null
  evidence?: unknown
  /** Something that happened (a stall, a death, a repair), which counts every time, not a state that persists. */
  occurrence?: boolean
}

const num = (name: string, fallback: number) => Number(process.env[name]) || fallback
const TICK_MS = num('GARDEN_WATCHDOG_TICK_MS', 10_000)
const SLOW_MS = num('GARDEN_WATCHDOG_SLOW_MS', 60_000)
/** A finding whose sensor has read clean this long resolves itself. */
const CLEAN_MS = num('GARDEN_WATCHDOG_CLEAN_MS', 5 * 60_000)
/** A dismissed kind and subject stays quiet this long, so dismissing means something. */
const MUTE_MS = 60 * 60_000
const STALL_PROBE_MS = 250
/** Freezes this soon after the server starts are the cards coming back, reported apart. */
const STARTUP_MS = num('GARDEN_WATCHDOG_STARTUP_MS', 3 * 60_000)
const STALL_MS = 500
const MIN = 60_000

/** Commands that take the whole machine for a while. Two at once on one project is the pile-up. */
const HEAVY = /(dotnet\s+(build|test|msbuild|restore)|msbuild(\.exe)?\s|compile-check|-batchmode|Unity\.exe)/i

/**
 * Whether a shell command actually runs a build, as opposed to mentioning one.
 *
 * The first version tested the whole command text, so a card writing task files whose prose said
 * "compile-check" was counted as two builds at once on 0.5 during the owner's first live run. Heredoc
 * bodies and quoted strings are removed first, and what is left is split into the commands it runs;
 * one of them has to invoke the build in its first few words.
 */
export function runsBuild(cmd: string): boolean {
  const code = cmd
    // Heredoc bodies: <<'EOF' ... EOF, <<EOF ... EOF, <<-EOF ... EOF.
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, '')
    // Quoted strings are data, except a quoted script path handed to a runner, which is kept.
    .replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_m, a: string | undefined, b: string | undefined) => {
      const inner = a ?? b ?? ''
      return /\.(ps1|cmd|bat|sh|exe)$/i.test(inner) && !/\s/.test(inner) ? inner : "''"
    })
  return code
    .split(/\n|;|&&|\|\||\|/)
    .map((part) => part.trim().replace(/^(&\s*|\.\s+|call\s+|(powershell|pwsh)(\.exe)?(\s+-\w+)*\s+)/i, ''))
    .some((part) => HEAVY.test(part.split(/\s+/).slice(0, 4).join(' ')))
}

interface Proc {
  i: number
  p: number
  n: string
  c: number | null
  x: string | null
  g: boolean
  /** The command line, for node.exe and claude.exe only, cut to 300 characters. */
  a?: string | null
}

/*
 * One process table, CPU seconds included, plus the processor's speed, as JSON: { k, r }.
 *
 * CPU seconds come from the raw performance counters, not Get-Process. Get-Process gives no CPU for
 * a protected process without admin, so for months the scan never saw Defender (MsMpEng), which on
 * 23 September was the largest single consumer at 1.5 to 2.4 cores. `k` is % Processor Performance:
 * the speed the processor is actually running at against its rated speed. It was 16 that evening,
 * and every "CPU 98%" finding meant 98% of a sixth of the machine. Win32_Process has the parent.
 * The board's renderer is flagged here rather than by sending every Chrome command line back, which
 * would be most of the output.
 */
export const PROCESS_SCAN = [
  '$c=@{}; Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object { if ($_.IDProcess -gt 0) { $c[[int]$_.IDProcess]=$_.PercentProcessorTime/1e7 } };',
  "$k=(Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter 'Name=''_Total''').PercentProcessorPerformance;",
  '$r=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ i=[int]$_.ProcessId; p=[int]$_.ParentProcessId; n=$_.Name; c=$c[[int]$_.ProcessId]; x=$_.ExecutablePath;',
  "g=($_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*Garden\\chrome-profile*' -and $_.CommandLine -like '*--type=renderer*');",
  "a=$(if (($_.Name -eq 'node.exe' -or $_.Name -eq 'claude.exe') -and $_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(300, $_.CommandLine.Length)) } else { $null }) } });",
  '[pscustomobject]@{ k=$k; r=$r } | ConvertTo-Json -Compress -Depth 3',
].join(' ')

/** Below this share of its rated speed, three scans running, the processor itself is reported. */
const SLOW_CLOCK_PCT = 50

export class Watchdog {
  private readonly d: WatchdogDeps
  private timers: NodeJS.Timeout[] = []

  /** What the server handled lately, so a stall can name what it was doing. */
  private recent: { at: number; label: string }[] = []
  private instant: Condition[] = []
  /** Kinds and subjects that were active on the last tick, so a recurrence is told from a continuation. */
  private active = new Set<string>()
  private muted = new Map<string, number>()

  private hookTimes = new Map<string, number[]>()
  private lastHookAt = new Map<string, number>()
  private heavy = new Map<string, { cardId: string; projectId: string; title: string; cmd: string; at: number }>()
  private prevStatus = new Map<string, string>()
  private unreadIdleSince = new Map<string, number>()

  private cpuPrev = cpus()
  private cpuHighSince: number | null = null
  private lastCpuPct = 0

  private procs: Proc[] | null = null
  private procCpuPrev = new Map<number, number>()
  private procPct = new Map<number, number>()
  private scanAt = 0
  private rendererHighScans = 0
  /** % Processor Performance from the last scan, or null before the first one or off Windows. */
  private clockPct: number | null = null
  private slowClockScans = 0
  /** What the last process scan found that persists (ghosts, the renderer, a lock left alone), held until the next scan. */
  private slowFound: Condition[] = []
  private dbSizes: { at: number; bytes: number }[] = []

  constructor(deps: WatchdogDeps) {
    this.d = deps
  }

  start(): void {
    /*
     * Lag on the monotonic clock, with the wall clock beside it. On 24 September at about 11:20 this
     * read one freeze of 51.9 s while a card's hooks kept arriving through the window, and nothing
     * could say whether the loop had been blocked or the wall clock had moved. A freeze now counts
     * only if the monotonic clock saw it, and one where the two clocks disagree by more than a
     * second is logged as a clock jump instead.
     */
    let expected = performance.now() + STALL_PROBE_MS
    let expectedWall = Date.now() + STALL_PROBE_MS
    this.timers.push(
      setInterval(() => {
        const mono = performance.now()
        const now = Date.now()
        const lag = mono - expected
        const wallLag = now - expectedWall
        expected = mono + STALL_PROBE_MS
        expectedWall = now + STALL_PROBE_MS
        if (Math.abs(wallLag - lag) > 1000) {
          console.error(`[garden] the wall clock moved ${Math.round(wallLag - lag)} ms against the monotonic clock; not a freeze`)
        }
        if (lag > STALL_MS) this.stalled(now, Math.round(lag))
      }, STALL_PROBE_MS),
      setInterval(() => this.tick(), TICK_MS),
      setInterval(() => this.slowTick(), SLOW_MS),
    )
    for (const t of this.timers) t.unref?.()
    this.slowTick()
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  /** Called at the top of every HTTP request and socket message. Cheap: a push and a trim. */
  note(label: string): void {
    this.recent.push({ at: Date.now(), label })
    if (this.recent.length > 60) this.recent.splice(0, this.recent.length - 60)
  }

  /** Something that happened elsewhere in the server and belongs on the Health list. */
  report(c: Condition): void {
    this.instant.push({ occurrence: true, ...c })
  }

  /** Every hook event, from ingest. */
  onHook(cardId: string, projectId: string, title: string, type: string, event: Record<string, unknown>): void {
    const now = Date.now()
    this.lastHookAt.set(cardId, now)
    const times = this.hookTimes.get(cardId) ?? []
    times.push(now)
    while (times.length && times[0]! < now - MIN) times.shift()
    this.hookTimes.set(cardId, times)

    const id = String(event.tool_use_id ?? event.toolUseId ?? '')
    if (type === 'PreToolUse' && id) {
      const input = (event.tool_input ?? event.toolInput) as Record<string, unknown> | undefined
      const cmd = String(input?.command ?? '')
      if (runsBuild(cmd)) this.heavy.set(id, { cardId, projectId, title, cmd: cmd.slice(0, 160), at: now })
    } else if ((type === 'PostToolUse' || type === 'PostToolUseFailure') && id) {
      this.heavy.delete(id)
    } else if (type === 'Stop' || type === 'SessionEnd' || type === 'SessionStart') {
      // A turn that ended took its tool calls with it, finished or not.
      for (const [k, h] of this.heavy) if (h.cardId === cardId) this.heavy.delete(k)
    }
  }

  dismiss(id: string): boolean {
    const f = this.d.store.getFinding(id)
    if (!f || f.state === 'resolved' || f.state === 'dismissed') return false
    this.d.store.putFinding({ ...f, state: 'dismissed', resolvedAt: Date.now(), note: f.note ?? 'dismissed by the owner' })
    this.muted.set(`${f.kind}|${f.subject}`, Date.now() + MUTE_MS)
    this.active.delete(`${f.kind}|${f.subject}`)
    this.announce()
    return true
  }

  /** Record what was done about a finding, from the Keeper or from the server itself. */
  handled(id: string, note: string, state: 'handled' | 'escalated' = 'handled'): boolean {
    const f = this.d.store.getFinding(id)
    if (!f || f.state === 'resolved' || f.state === 'dismissed') return false
    this.d.store.putFinding({ ...f, state, note })
    this.announce()
    return true
  }

  /** What the machine looks like now, from the last tick and the last process scan. For the Keeper. */
  snapshot(): { cpuPct: number; clockPct: number | null; freeMemGB: number; cores: number; scannedSecondsAgo: number | null; top: { name: string; pct: number; cards: string[] }[] } {
    return {
      cpuPct: Math.round(this.lastCpuPct),
      clockPct: this.clockPct,
      freeMemGB: Math.round((freemem() / 1024 ** 3) * 10) / 10,
      cores: cpus().length,
      scannedSecondsAgo: this.scanAt ? Math.round((Date.now() - this.scanAt) / 1000) : null,
      top: this.procs ? this.topConsumers() : [],
    }
  }

  // ---------------------------------------------------------------------------

  /*
   * Freezes are reported as a run, not one at a time. The first version titled the row with the latest
   * freeze, so seven freezes after a restart, one of them over two seconds, read "froze for 0.5 s";
   * and it named the page's heartbeat as the cause because that was the only thing in the log. Now the
   * title carries the count and the worst, suspects are gathered across the run with card launches
   * among them (see `note`), and a run inside the first three minutes after the server started, when
   * every running card is being brought back, is its own lower-severity kind that wakes nobody.
   */
  private readonly startedAt = Date.now()
  private stallRun: {
    first: number
    last: number
    count: number
    worst: number
    worstAt?: { from: string; to: string; rssMB: number; heapMB: number; freeMemGB: number }
    suspects: Map<string, number>
  } | null = null

  private stalled(now: number, lag: number): void {
    // What was handled in the window the loop was blocked: the suspects.
    const suspects = this.recent.filter((r) => r.at >= now - lag - STALL_PROBE_MS).map((r) => r.label)
    // A run ends after two quiet minutes.
    if (!this.stallRun || now - this.stallRun.last > 2 * MIN) {
      this.stallRun = { first: now, last: now, count: 0, worst: 0, suspects: new Map() }
    }
    const run = this.stallRun
    run.last = now
    run.count++
    // The worst one's start and end on the wall clock, and memory then, so a long one can be placed.
    if (lag > run.worst) {
      const m = process.memoryUsage()
      run.worstAt = { from: new Date(now - lag).toTimeString().slice(0, 8), to: new Date(now).toTimeString().slice(0, 8), rssMB: Math.round(m.rss / 1e6), heapMB: Math.round(m.heapUsed / 1e6), freeMemGB: Math.round((freemem() / 1024 ** 3) * 10) / 10 }
    }
    run.worst = Math.max(run.worst, lag)
    for (const s of new Set(suspects)) run.suspects.set(s, (run.suspects.get(s) ?? 0) + 1)

    /*
     * Startup only while the run is still inside the window. It used to be decided by where the run
     * began, so on 23 September one that began at the restart and never went quiet was still "cards
     * coming back" at 333 freezes over 29 minutes, worst 8.3 s: a warning that woke nobody.
     */
    const startup = run.last - this.startedAt < STARTUP_MS
    const span = Math.max(1, Math.round((run.last - run.first) / 1000))
    const worst = `${(run.worst / 1000).toFixed(1)} s`
    // Launches first, since they are the usual cause; then whatever else was handled most often.
    const named = [...run.suspects.entries()]
      .sort((a, b) => Number(b[0].startsWith('launch')) - Number(a[0].startsWith('launch')) || b[1] - a[1])
      .slice(0, 6)
      .map(([s, n]) => (n > 1 ? `${s} (${n}x)` : s))
    this.report({
      kind: startup ? 'server-stall-startup' : 'server-stall',
      subject: 'server',
      severity: startup ? 'warn' : run.worst >= 2000 ? 'act' : 'warn',
      title:
        (startup ? 'While cards were coming back after the restart, ' : '') +
        (run.count === 1
          ? `the board froze for ${worst}`
          : `the board froze ${run.count} times in ${span} s, worst ${worst}`).replace(/^t/, startup ? 't' : 'T'),
      detail: named.length ? `Happening at the time: ${named.join(', ')}` : 'Nothing was being handled; the freeze was inside a timer.',
      evidence: { lagMs: lag, worstMs: run.worst, worstAt: run.worstAt, count: run.count, suspects: Object.fromEntries(run.suspects) },
      occurrence: false,
    })
  }

  private tick(): void {
    const now = Date.now()
    const found: Condition[] = this.instant.splice(0)
    try {
      found.push(...this.slowFound, ...this.lockFound, ...this.database(now), ...this.machine(now), ...this.cards(now), ...this.builds())
    } catch (err) {
      console.error('[garden] watchdog tick failed:', (err as Error).message)
    }
    this.settle(found, now)
  }

  private settle(found: Condition[], now: number): void {
    let changed = false
    const seen = new Set<string>()
    for (const c of found) {
      const key = `${c.kind}|${c.subject}`
      if ((this.muted.get(key) ?? 0) > now) continue
      seen.add(key)
      const live = this.d.store.liveFinding(c.kind, c.subject)
      const recurred = c.occurrence === true || !this.active.has(key)
      if (live) {
        if (!recurred && live.title === c.title && live.severity === c.severity) {
          // A continuation: keep lastSeen current without rewriting the row every ten seconds.
          if (now - live.lastSeen > MIN) this.d.store.putFinding({ ...live, lastSeen: now })
          continue
        }
        const severity = rank(c.severity) > rank(live.severity) ? c.severity : live.severity
        const next: Finding = {
          ...live,
          severity,
          title: c.title,
          detail: c.detail ?? live.detail,
          evidence: c.evidence ?? live.evidence,
          lastSeen: now,
          count: live.count + (recurred ? 1 : 0),
          // A problem that came back after being handled is open again.
          state: live.state === 'handled' && recurred ? 'open' : live.state,
        }
        this.d.store.putFinding(next)
        if (recurred && next.severity === 'act') this.d.onAct?.(next)
      } else {
        const f: Finding = {
          id: randomUUID(),
          kind: c.kind,
          subject: c.subject,
          projectId: c.projectId ?? null,
          severity: c.severity,
          title: c.title,
          detail: c.detail ?? null,
          evidence: c.evidence ?? null,
          state: 'open',
          firstSeen: now,
          lastSeen: now,
          count: 1,
          note: null,
          resolvedAt: null,
        }
        this.d.store.putFinding(f)
        if (f.severity === 'act') this.d.onAct?.(f)
      }
      changed = true
    }
    this.active = new Set([...seen].filter((k) => !found.some((c) => `${c.kind}|${c.subject}` === k && c.occurrence)))

    for (const f of this.d.store.liveFindings()) {
      if (seen.has(`${f.kind}|${f.subject}`)) continue
      if (now - f.lastSeen < CLEAN_MS) continue
      this.d.store.putFinding({ ...f, state: 'resolved', resolvedAt: now })
      changed = true
    }
    if (changed) this.announce()
  }

  private announce(): void {
    this.d.broadcast({ t: 'findings', findings: this.d.store.liveFindings() })
  }

  // --- sensors -------------------------------------------------------------

  private database(now: number): Condition[] {
    const out: Condition[] = []
    const wal = `${this.d.dbPath}-wal`
    const walBytes = existsSync(wal) ? statSync(wal).size : 0
    if (walBytes > 200 * 1024 * 1024) {
      this.d.store.checkpoint()
      const after = existsSync(wal) ? statSync(wal).size : 0
      out.push({
        kind: 'db-wal',
        subject: 'server',
        severity: 'info',
        title: `Folded a ${mb(walBytes)} write-ahead log back into the database`,
        detail: `wal_checkpoint(TRUNCATE): ${mb(walBytes)} to ${mb(after)}. Safe on a live board; nothing is lost.`,
        evidence: { before: walBytes, after },
        occurrence: true,
      })
    }
    const size = existsSync(this.d.dbPath) ? statSync(this.d.dbPath).size : 0
    this.dbSizes.push({ at: now, bytes: size })
    while (this.dbSizes.length && this.dbSizes[0]!.at < now - 60 * MIN) this.dbSizes.shift()
    const hourAgo = this.dbSizes[0]
    if (hourAgo && now - hourAgo.at > 50 * MIN && size - hourAgo.bytes > 100 * 1024 * 1024) {
      out.push({
        kind: 'db-growth',
        subject: 'server',
        severity: 'warn',
        title: `The database grew ${mb(size - hourAgo.bytes)} in the last hour`,
        detail: 'Something is writing far more than a board normally does. A flood finding usually names the card.',
        evidence: { from: hourAgo.bytes, to: size },
      })
    }
    return out
  }

  private machine(now: number): Condition[] {
    const out: Condition[] = []
    const cur = cpus()
    let busy = 0
    let total = 0
    cur.forEach((c, i) => {
      const p = this.cpuPrev[i]
      if (!p) return
      const t = (c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle) -
        (p.times.user + p.times.nice + p.times.sys + p.times.irq + p.times.idle)
      busy += t - (c.times.idle - p.times.idle)
      total += t
    })
    this.cpuPrev = cur
    this.lastCpuPct = total > 0 ? Math.round((busy / total) * 100) : 0
    if (this.lastCpuPct >= 90) this.cpuHighSince ??= now
    else this.cpuHighSince = null
    if (this.cpuHighSince !== null && now - this.cpuHighSince >= MIN) {
      const top = this.topConsumers()
      out.push({
        kind: 'machine-cpu',
        subject: 'machine',
        severity: 'warn',
        title:
          `CPU at ${this.lastCpuPct}% for ${Math.round((now - this.cpuHighSince) / 1000)} s` +
          (this.clockPct !== null ? `, processor at ${this.clockPct}% of its rated speed` : ''),
        detail: top.length ? `Using it: ${top.map((t) => `${t.name} ${t.pct}%${t.cards.length ? ` (${t.cards.join(', ')})` : ''}`).join('; ')}` : null,
        evidence: { cpuPct: this.lastCpuPct, clockPct: this.clockPct, top },
      })
    }
    const free = freemem()
    if (free < 2 * 1024 ** 3) {
      out.push({
        kind: 'machine-memory',
        subject: 'machine',
        severity: 'warn',
        title: `Only ${(free / 1024 ** 3).toFixed(1)} GB of memory free`,
        evidence: { freeBytes: free },
      })
    }
    return out
  }

  private cards(now: number): Condition[] {
    const out: Condition[] = []
    for (const s of this.d.store.listSessions()) {
      if (s.kind !== 'session' || s.closedAt !== null) continue
      const since = s.statusSince ?? now
      const prev = this.prevStatus.get(s.id)
      this.prevStatus.set(s.id, s.status)
      const base = { subject: s.id, projectId: s.projectId }

      // An unexpected non-zero exit is recorded as `failed`, not `stopped` (the exit handler in
      // index.ts); `stopped` is what Garden or the owner asked for, or a clean exit.
      if (prev !== undefined && prev !== 'failed' && s.status === 'failed') {
        // Garden's own launch watch ends a CLI that never reported in; that is not a crash, and says so.
        const gaveUp = this.d.store.lastEventOfTypeSince(s.id, 'LaunchGaveUp', since - MIN)
        const waited = (gaveUp?.payload as { waitedSeconds?: number } | undefined)?.waitedSeconds
        out.push({
          ...base,
          kind: 'card-died',
          severity: 'act',
          title: s.exitCode !== null ? `${s.title} stopped with exit code ${s.exitCode}` : `${s.title} failed to start`,
          detail: gaveUp
            ? `Garden ended it: the CLI posted no SessionStart within ${waited ?? '?'} s of launch${(gaveUp.payload as any)?.cliRunning ? ', though a CLI was running under its shell' : ''}. The last lines of its terminal are in the evidence.`
            : 'It was not closed by anybody. The last lines of its terminal are in the evidence.',
          evidence: { exitCode: s.exitCode, tail: this.d.terminalTail(s.id, 40), ...(gaveUp ? { endedBy: 'launch-watch', waitedSeconds: waited } : {}) },
          occurrence: true,
        })
      }
      // The same death with the shell still standing, which is how a mid-run crash actually looks.
      // Same kind, so the Keeper's resume treats both alike; `shell` says there is a process to end first.
      if (this.d.isLive(s.id) && this.d.atShellPrompt(s.id)) {
        out.push({
          ...base,
          kind: 'card-died',
          severity: 'act',
          title: `${s.title}'s CLI exited and left it at a bare shell prompt`,
          detail: 'The process is still up, so the card looks alive; nothing is running in it.',
          evidence: { shell: true, tail: this.d.terminalTail(s.id, 40) },
        })
      }
      if (s.status === 'starting' && now - since > 3 * MIN) {
        out.push({ ...base, kind: 'card-starting', severity: 'warn', title: `${s.title} has been starting for ${mins(now - since)}` })
      }
      if (s.status === 'working' && this.d.isLive(s.id)) {
        const hookQuiet = now - (this.lastHookAt.get(s.id) ?? since)
        const byteQuiet = now - this.d.lastByteAt(s.id)
        if (hookQuiet > 20 * MIN && byteQuiet > 5 * MIN) {
          out.push({
            ...base,
            kind: 'card-quiet',
            severity: 'act',
            title: `${s.title} says it is working but has done nothing for ${mins(hookQuiet)}`,
            evidence: { hookQuietMs: hookQuiet, byteQuietMs: byteQuiet, tail: this.d.terminalTail(s.id, 20) },
          })
        }
      }
      if (s.status === 'needs-input' && now - since > 10 * MIN) {
        out.push({
          ...base,
          kind: 'card-waiting',
          severity: 'warn',
          title: `${s.title} has been waiting on you for ${mins(now - since)}`,
          detail: s.waitingFor ?? null,
        })
      }
      const unread = this.d.unread(s.id)
      if (unread > 0 && s.status === 'idle' && this.d.isLive(s.id)) {
        const from = this.unreadIdleSince.get(s.id) ?? now
        this.unreadIdleSince.set(s.id, from)
        if (now - from > 5 * MIN) {
          out.push({
            ...base,
            kind: 'mail-unread-idle',
            severity: 'act',
            title: `${s.title} is idle with ${unread} unread message${unread === 1 ? '' : 's'} for ${mins(now - from)}`,
          })
        }
      } else {
        this.unreadIdleSince.delete(s.id)
      }
      const held = this.d.heldSince(s.id)
      if (held !== undefined && now - held > 2 * MIN) {
        out.push({ ...base, kind: 'line-held', severity: 'warn', title: `A line you typed at ${s.title} has been waiting ${mins(now - held)} for it to be ready` })
      }
      const perMin = this.hookTimes.get(s.id)?.filter((t) => t > now - MIN).length ?? 0
      if (perMin > 120) {
        out.push({
          ...base,
          kind: 'card-flood',
          severity: 'warn',
          title: `${s.title} is writing ${perMin} events a minute`,
          detail: 'A card in a loop, or a relay repeating itself. The relay flood of September wrote 350 MB this way.',
          evidence: { perMinute: perMin },
        })
      }
    }
    return out
  }

  private builds(): Condition[] {
    const now = Date.now()
    const byProject = new Map<string, { title: string; cmd: string; at: number }[]>()
    for (const [k, h] of this.heavy) {
      // A tool call that never reported back after half an hour is not still running.
      if (now - h.at > 30 * MIN) {
        this.heavy.delete(k)
        continue
      }
      const list = byProject.get(h.projectId) ?? []
      list.push({ title: h.title, cmd: h.cmd, at: h.at })
      byProject.set(h.projectId, list)
    }
    const out: Condition[] = []
    for (const [projectId, list] of byProject) {
      // Two different cards. One card runs its tool calls one after another, and a call whose result
      // never came back (a denied command sends no PostToolUse) must not pair with its successor.
      if (new Set(list.map((l) => l.title)).size < 2) continue
      const project = this.d.store.getProject(projectId)
      out.push({
        kind: 'builds-overlap',
        subject: projectId,
        projectId,
        severity: 'warn',
        title: `${list.length} builds running at once on ${project?.name ?? 'a project'}`,
        detail: `${[...new Set(list.map((l) => l.title))].join(', ')}. Each takes most of the CPU, and on 0.5 they also overwrite each other's output.`,
        evidence: { running: list },
      })
    }
    return out
  }

  // --- the slow look -------------------------------------------------------

  private scanning = false
  /** Locks, checked on their own clock so a slow process scan cannot hide one. */
  private lockFound: Condition[] = []

  private slowTick(): void {
    /*
     * The lock check does not wait for the scan. It only needs the scan to know whether git is
     * running, and without that answer it reports rather than deletes.
     */
    const locks = this.gitLocks(this.scanFresh() ? this.procs : null)
    this.lockFound = locks.filter((c) => !c.occurrence)
    this.instant.push(...locks.filter((c) => c.occurrence))
    if (process.platform !== 'win32') return
    // One scan at a time: on a loaded machine one can take longer than the gap between them.
    if (this.scanning) return
    this.scanning = true
    const started = Date.now()
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PROCESS_SCAN],
      { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        this.scanning = false
        if (err) return
        let rows: Proc[]
        try {
          const parsed = JSON.parse(stdout) as { k?: unknown; r?: Proc | Proc[] }
          if (!parsed.r) return
          rows = Array.isArray(parsed.r) ? parsed.r : [parsed.r]
          this.clockPct = typeof parsed.k === 'number' ? Math.round(parsed.k) : null
        } catch {
          return
        }
        const elapsed = (started - this.scanAt) / 1000
        const cores = cpus().length
        this.procPct.clear()
        for (const r of rows) {
          const prev = this.procCpuPrev.get(r.i)
          if (r.c != null && prev != null && this.scanAt > 0 && elapsed > 0) {
            this.procPct.set(r.i, Math.max(0, ((r.c - prev) / elapsed / cores) * 100))
          }
        }
        this.procCpuPrev = new Map(rows.filter((r) => r.c != null).map((r) => [r.i, r.c as number]))
        this.scanAt = started
        this.procs = rows
        this.slowFound = [...this.ghosts(rows), ...this.renderer(rows, cores), ...this.clock()]
      },
    ).unref?.()
  }

  /** Which card, if any, launched this process: walk the parents up to a card's own process. */
  private cardFor(pid: number, byPid: Map<number, Proc>, cardByPid: Map<number, TerminalSession>): TerminalSession | undefined {
    let cur: number | undefined = pid
    for (let depth = 0; cur && depth < 12; depth++) {
      const card = cardByPid.get(cur)
      if (card) return card
      cur = byPid.get(cur)?.p
    }
    return undefined
  }

  private cardsByPid(): Map<number, TerminalSession> {
    return new Map(
      this.d.store
        .listSessions()
        .filter((s) => s.pid != null && s.closedAt === null && this.d.isLive(s.id))
        .map((s) => [s.pid as number, s]),
    )
  }

  private topConsumers(): { name: string; pct: number; cards: string[] }[] {
    if (!this.procs) return []
    const byPid = new Map(this.procs.map((p) => [p.i, p]))
    const cardByPid = this.cardsByPid()
    const groups = new Map<string, { pct: number; cards: Set<string> }>()
    for (const p of this.procs) {
      const pct = this.procPct.get(p.i) ?? 0
      if (pct < 0.5) continue
      const g = groups.get(p.n) ?? { pct: 0, cards: new Set<string>() }
      g.pct += pct
      const card = this.cardFor(p.i, byPid, cardByPid)
      if (card) g.cards.add(card.title)
      groups.set(p.n, g)
    }
    return [...groups]
      .map(([name, g]) => ({ name: name.replace(/\.exe$/i, ''), pct: Math.round(g.pct), cards: [...g.cards] }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 6)
  }

  private ghosts(rows: Proc[]): Condition[] {
    const byPid = new Map(rows.map((p) => [p.i, p]))
    const cardByPid = this.cardsByPid()
    const clis = rows.filter((r) => r.n === 'claude.exe' && (r.x ?? '').toLowerCase().includes('\\.local\\bin\\'))
    const ghosts = clis.filter((r) => !this.cardFor(r.i, byPid, cardByPid)).map((r) => r.i)
    if (!ghosts.length) return []
    return [
      {
        kind: 'ghost-cli',
        subject: 'machine',
        severity: 'warn',
        title: `${ghosts.length} Claude CLI${ghosts.length === 1 ? '' : 's'} running that no card on the board owns`,
        detail: 'A card whose terminal died while its agent kept going, or a CLI started outside Garden. Not stopped automatically.',
        /*
         * Where each came from: its parent and grandparent by pid and name. The Keeper saw four
         * one-sighting ghosts on 23 and 24 September and could not tell a CLI started outside a card
         * from one caught before its card registered it; the ancestry answers that from one sighting.
         * The first sighting with ancestry (08:14 on 24 September) said only "node.exe 45548" with its
         * parent gone, which could have been the server, a shim or a card's script, so the command
         * lines of the ghost and its node parent come with it.
         */
        evidence: {
          pids: ghosts,
          ancestry: ghosts.map((pid) => {
            const up = (id: number | undefined) => (id ? byPid.get(id) : undefined)
            const self = byPid.get(pid)
            const parent = up(self?.p)
            const grand = up(parent?.p)
            return {
              pid,
              command: self?.a ?? null,
              parent: parent ? `${parent.n} ${parent.i}` : `gone (${self?.p ?? '?'})`,
              parentCommand: parent?.a ?? null,
              grandparent: grand ? `${grand.n} ${grand.i}` : parent ? `gone (${parent.p})` : null,
            }
          }),
        },
      },
    ]
  }

  /** A processor held far below its rated speed makes every other figure on the list slower. */
  private clock(): Condition[] {
    const k = this.clockPct
    this.slowClockScans = k !== null && k < SLOW_CLOCK_PCT ? this.slowClockScans + 1 : 0
    if (this.slowClockScans < 3 || k === null) return []
    return [
      {
        kind: 'machine-clock',
        subject: 'machine',
        severity: 'warn',
        title: `The processor is running at ${k}% of its rated speed`,
        detail:
          'For three minutes or more. Nothing on the board can fix this: it is usually heat or a vendor tool ' +
          "capping the chip, below Windows' power plan. Every freeze and CPU figure meanwhile is on a slower machine.",
        evidence: { clockPct: k, scans: this.slowClockScans },
      },
    ]
  }

  private renderer(rows: Proc[], cores: number): Condition[] {
    const pcts = rows.filter((r) => r.g).map((r) => this.procPct.get(r.i) ?? 0)
    const worst = pcts.length ? Math.max(...pcts) : 0
    const oneCore = 100 / cores
    this.rendererHighScans = worst > oneCore ? this.rendererHighScans + 1 : 0
    if (this.rendererHighScans < 5) return []
    return [
      {
        kind: 'board-window-cpu',
        subject: 'machine',
        severity: 'warn',
        title: `The board window is using ${(worst / oneCore).toFixed(1)} cores`,
        detail: 'The page that draws the board, not the cards. The Keeper profiles it to find which part.',
        evidence: { pctOfMachine: Math.round(worst), cores: +(worst / oneCore).toFixed(2) },
      },
    ]
  }

  /**
   * A stale `index.lock` blocks every commit in the repository. The owner, 2026-09-23: delete it when
   * it is empty, over ten minutes old, and no git is running. Anything else is only reported.
   */
  /** A process table no older than two scan intervals, or none: an old one cannot say git is not running. */
  private scanFresh(): boolean {
    return this.procs !== null && Date.now() - this.scanAt < 2 * SLOW_MS + 30_000
  }

  private gitLocks(rows: Proc[] | null): Condition[] {
    // Unknown counts as running: the lock is reported, never deleted, until a scan says otherwise.
    const gitRunning = rows === null || rows.some((r) => r.n.toLowerCase() === 'git.exe')
    const out: Condition[] = []
    for (const p of this.d.store.listProjects()) {
      const gitDir = findGitDir(p.path)
      if (!gitDir) continue
      const lock = join(gitDir, 'index.lock')
      if (!existsSync(lock)) continue
      const st = statSync(lock)
      const age = Date.now() - st.mtimeMs
      if (age < 10 * MIN) continue
      if (st.size === 0 && !gitRunning) {
        try {
          unlinkSync(lock)
        } catch (err) {
          out.push({ kind: 'git-lock', subject: p.id, projectId: p.id, severity: 'warn', title: `A stale git lock on ${p.name} could not be removed`, detail: (err as Error).message })
          continue
        }
        out.push({
          kind: 'git-lock-removed',
          subject: p.id,
          projectId: p.id,
          severity: 'info',
          title: `Removed a stale git lock on ${p.name}`,
          detail: `${lock}, empty and ${mins(age)} old, with no git running. It was blocking every commit.`,
          evidence: { path: lock, ageMs: age },
          occurrence: true,
        })
      } else {
        out.push({
          kind: 'git-lock',
          subject: p.id,
          projectId: p.id,
          severity: 'warn',
          title: `A git lock on ${p.name} is ${mins(age)} old`,
          detail: st.size > 0 ? 'Not empty, so it was left alone.' : 'Git is running, or could not yet be ruled out, so it may be live; left alone.',
          evidence: { path: lock, bytes: st.size, gitRunning },
        })
      }
    }
    return out
  }
}

function findGitDir(start: string): string | null {
  let dir = start
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, '.git')
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
    } catch {
      return null
    }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

const rank = (s: Finding['severity']) => (s === 'act' ? 2 : s === 'warn' ? 1 : 0)
const mb = (b: number) => `${Math.round(b / 1024 / 1024)} MB`
const mins = (ms: number) => (ms < 2 * MIN ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / MIN)} min`)
