/**
 * What a wire actually does.
 *
 * A line between two cards that no agent can see is decoration, and the owner said as much: he
 * wants wires that carry something. This is the smallest honest version of that. Each session
 * gets a directory it owns, its path handed over as an environment variable at launch, holding
 * two files: who it is connected to, and anything sent along those connections.
 *
 * Garden does not inject this into a prompt, interrupt a running turn, or speak on anyone's
 * behalf. It writes files and tells the session where they are. An agent reads its mailbox
 * because its instructions say to, which keeps the CLI in charge of its own context and means a
 * wire can never silently change what an agent was asked to do.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TerminalSession } from '@garden/shared'
import { DATA_DIR } from './store.js'
import { ROLE_POWERS } from './hooks-install.js'
import { MAIL_KINDS } from './tasks.js'

export function mailDirFor(sessionId: string): string {
  const dir = join(DATA_DIR, 'mail', sessionId)
  mkdirSync(dir, { recursive: true })
  /*
   * Where a card writes what it is about to send, before it sends it.
   *
   * It exists because the message may not travel inside the command that sends it. Claude Code
   * splits a command on its separators and checks each part on its own, so `cat <<'EOF' | node
   * <shim>` is two commands: the shim half is allowed by name in the card's settings, and the `cat`
   * half is the whole message, matches no rule, and meets a classifier that refuses anything it
   * cannot scan. The card then stops and waits for the owner to answer a prompt. Measured over three
   * days of real board traffic: 274 sends, 133 of them at or over the size that was refused.
   *
   * Here rather than in a system temp directory for two reasons. The shapes cards were reaching for
   * on their own all used `/tmp/reply.txt`, which every card on the board collides on, and a POSIX
   * path handed to a file writing tool on Windows does not land where the card believes it did.
   * Here rather than in the card's memory directory because that holds durable roots the startup
   * hook reads back, and a scratch body does not belong beside them. This puts the bytes that were
   * sent next to SENT.md, which is where the owner looks when a message reads wrong.
   */
  mkdirSync(join(dir, 'outbox'), { recursive: true })
  return dir
}

/** The card's own scratch folder for outgoing bodies, as the shims and PEERS.md both name it. */
export function outboxDirFor(sessionId: string): string {
  return join(mailDirFor(sessionId), 'outbox')
}

/**
 * A Windows path written the way the taught commands need it.
 *
 * Two reasons, and neither is cosmetic. A backslash immediately before the closing quote of an
 * argument escapes that quote in both shells a card might be running under, so the argument runs on
 * into the next one. And the allow rule Garden writes into each card's settings names the shim with
 * forward slashes, so a command written with backslashes has to fall through to the looser second
 * rule to be permitted at all. Shown one way, matched the same way.
 */
function forward(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * How much of one message a mailbox file holds.
 *
 * A cap has to exist, because INBOX.md and SENT.md are appended to for the life of a card and one
 * agent pasting a file into a message should not be able to grow them without bound.
 *
 * RAISED FROM 8000 TO 24000 on 2026-09-03, after the cap cost two round trips inside one hour on
 * work the owner was waiting on. A specialist's discovery report is the shape that hits it: an
 * ordered call chain with a file:line per hop, which is exactly the evidence that must not be
 * summarised, ran to roughly 10.8k characters and was cut mid-sentence in the middle of naming a
 * third writer. The recipient then cannot act and has to ask for the tail, so the cap did not save
 * anything, it moved the cost from disk to wall clock and paid for the message twice.
 *
 * 24000 is chosen against measurement rather than taste: the two reports that were cut were 10.8k
 * and 11.0k, so 24000 clears the observed shape with room and still refuses a pasted file, which is
 * the abuse the cap exists to stop. The marker below is unchanged and still fires past the new
 * ceiling, so nothing about the honesty of a cut entry changes: only where the line sits.
 */
const ENTRY_LIMIT = 24000

/**
 * The body as a mailbox file records it, saying so when that is not all of it.
 *
 * This was `text.slice(0, 8000)` with nothing else, in both files, so a longer message was cut and
 * the entry read as though it were the whole thing. Both the recipient and the sender's own record
 * were then well formed and wrong, which is the one shape this project exists to refuse, and it was
 * only ever survivable because a body had to fit inside a shell command to be sent at all. Moving the
 * body into a file removed that ceiling, so this one became reachable the same day.
 *
 * The count is exact and the marker names where the rest is, because a card that needs the full text
 * has somewhere to go and a card that does not is at least not misled about what it read.
 */
function capped(text: string): string {
  if (text.length <= ENTRY_LIMIT) return text
  const cut = text.length - ENTRY_LIMIT
  return (
    `${text.slice(0, ENTRY_LIMIT)}\n\n` +
    `*[Garden cut this entry here. ${cut} more characters were sent and are not shown. ` +
    "The sender has the whole of it in its outbox; ask for the part you need.]*"
  )
}

/** The shim an agent runs to send, found relative to this file so source and build both work. */
function sendShimPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'garden-send.mjs')
}

/** And the one it runs to ask for a card to exist, found the same way. */
function hireShimPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'garden-hire.mjs')
}

function taskShimPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'garden-task.mjs')
}

export interface Peer {
  title: string
  direction: 'to' | 'from'
  /** True when the wire carries an arrowhead at both ends, so either side may start something. */
  twoWay: boolean
  kind: string
  label: string
  mailDir: string
}

/**
 * Rewrite the list of who this session is wired to.
 *
 * Rewritten whole rather than appended, because a wire the owner deleted must disappear from
 * here too. A stale peer is worse than a missing one: it invites an agent to hand work to
 * something that is no longer connected to it.
 */
export function writePeers(session: TerminalSession, peers: Peer[]): void {
  const dir = mailDirFor(session.id)
  const outbox = outboxDirFor(session.id)
  const lines = [
    `# Connections for "${session.title}"`,
    '',
    'Garden maintains this file. It lists the cards this session is wired to on the board.',
    'Wires are the owner saying these sessions belong together; nothing here has been sent to you.',
    '',
  ]
  if (peers.length === 0) {
    lines.push('This session is not currently wired to anything.')
  } else {
    for (const p of peers) {
      /*
       * Say which way the wire runs, because that is the part with consequences. A one-way wire
       * from a coder to a reviewer means the coder hands work over and never hears back on that
       * line, and an agent reading this file has to be able to tell that from a wire it may reply
       * on. A two-way wire says either end can start something.
       */
      const arrow = p.twoWay
        ? 'both ways, so either of you can start something'
        : p.direction === 'to'
          ? 'you send to them, and they cannot reply on this wire'
          : 'they send to you, and you cannot send back on this wire'
      lines.push(`- **${p.title}** (${arrow}${p.label ? `, labelled "${p.label}"` : ''}, ${p.kind} wire)`)
      lines.push(`  mailbox: ${p.mailDir}`)
    }
  }

  /*
   * How to actually send one.
   *
   * This was missing entirely, and its absence made everything above decoration: the shim's path
   * travelled to every session as an environment variable and no file an agent reads ever mentioned
   * it, so the only thing that had ever sent a message along a wire was the test that called the
   * shim directly. A capability nobody is told about is not a capability.
   */
  lines.push(
    '',
    '## Sending to one of them',
    '',
    'Write what you want to say to a file, with your file writing tool rather than with a shell',
    'command, and then run this:',
    '',
    '```',
    `node "${forward(sendShimPath())}" --to "<their title>" --kind <kind> --task <task id> --file "${forward(outbox)}/<task id>.md"`,
    '```',
    '',
    /*
     * The body is out of the command entirely, and that is the second correction to this paragraph.
     *
     * It first told every card to use `--text "<what you want to say>"`. PowerShell reopens the
     * command line at a quote inside an argument value, so a message containing an apostrophe
     * arrived shattered into stray arguments and only the part before it would have been delivered.
     * That became stdin, which does survive quotes, and cards reasonably read `echo` and reached for
     * a heredoc when they had a paragraph to say.
     *
     * A heredoc puts the message back inside the command, which is where it may not be. Claude Code
     * splits a command on its separators and checks each part, and the part holding the message
     * matches no allow rule and meets a classifier that refuses what it cannot scan: "Command
     * exceeds the maximum analyzable length". The card then stops until the owner answers a prompt.
     * Measured over three days of his real board: 274 sends, 133 at or over the size that was
     * refused. His words for what that costs are "it stops work each time it happens".
     *
     * A path is the same length whatever is in the file, so this shape has no size at which it
     * starts failing. That is the whole reason it is the one shown.
     */
    'Never put the message inside the command itself, with an `echo` or a heredoc. A quote in the',
    'command is reopened by the shell and the rest of your message is lost, and a command carrying a',
    'few thousand characters cannot be security scanned, so it stops and waits for the owner to',
    'approve it by hand while you wait with it. A file has neither problem, and the command is the',
    'same length whether you are sending one line or four thousand words.',
    '',
    `Your outbox is \`${forward(outbox)}\` and already exists. Name the file after the task, so what`,
    'you actually sent is still there afterwards if anyone asks.',
    '',
    '`--text "..."` is still fine for one short line with no quotes in it. Anything longer goes in a',
    'file.',
    '',
    'Garden replies with what it did, or with the reason it refused, and a refusal is worth reading:',
    'it names the wire that is missing or the step that has not happened yet. It also says what became',
    'of the message, which is not the same as saying it was sent: a card with no process running is',
    'told to you as filed rather than as delivered.',
    '',
    'The `--task` id is what ties a conversation together. Use the one you were given, and use the',
    'same one every time you send about that piece of work, or the trail the owner reads back will',
    'have your message sitting on its own with nothing around it.',
    '',
    '### Kinds',
    '',
  )
  for (const [kind, meaning] of Object.entries(MAIL_KINDS)) {
    lines.push(`- \`${kind}\`: ${meaning}`)
  }
  lines.push(
    '',
    'A kind never decides which way a message may go. The wire does, and only the wire, so anything',
    'in the list above can travel either way along a wire that runs both ways.',
    '',
    'Two of these carry a duty rather than only a meaning. When somebody sends you `done`, you are',
    'expected to look at what they did and send them `confirm` before you tell anyone above you that',
    'the work is finished; Garden will refuse to pass it up until you have. And `assessment` is where',
    'you say how the finished work compares with what was actually asked for, which is a different',
    'question from whether the code is any good.',
    '',
    `Your own inbox is ${join(dir, 'INBOX.md')}.`,
    '',
    `What you have already sent is recorded in ${join(dir, 'SENT.md')}. Read it before you answer a`,
    'card you have spoken to before, so you are replying to the exchange rather than starting a new',
    'one. Every entry in both files carries the task id it belongs to; reuse it.',
    '',
  )
  writeFileSync(join(dir, 'PEERS.md'), lines.join('\n'), 'utf8')
}

const stamp = (at: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`
}

/**
 * Append a message to a session's inbox. Append, never rewrite: an inbox is a record.
 *
 * The kind and the task id are written into the entry, not just carried on the wire. PEERS.md tells
 * every card that the task id is what ties a conversation together and to reuse the one it was
 * given, and then the rendered inbox showed only sender, time and body. A card answering its first
 * message had nothing to thread onto and had to invent an id, which produces exactly the trail
 * PEERS.md warns against: two unrelated messages instead of one exchange. Found by the owner's own
 * orchestrator during a pair test, which had to make up `pair-check-1` to reply at all.
 */
export function postMessage(
  to: TerminalSession,
  fromTitle: string,
  text: string,
  meta?: { kind?: string; taskId?: string | null; fromId?: string },
): string {
  const dir = mailDirFor(to.id)
  const file = join(dir, 'INBOX.md')
  if (!existsSync(file)) {
    writeFileSync(file, `# Inbox for "${to.title}"\n\nMessages sent along wires on the Garden board.\n`, 'utf8')
  }
  const head = [`## From ${fromTitle}, ${stamp(new Date())}`]
  const bits: string[] = []
  if (meta?.kind) bits.push(`kind \`${meta.kind}\``)
  if (meta?.taskId) bits.push(`task \`${meta.taskId}\``)
  // Said in the entry itself, so a card replying does not have to be told separately which id to use.
  if (bits.length) head.push('', `${bits.join(', ')}. Reply on this same task id.`)
  appendFileSync(file, `\n${head.join('\n')}\n\n${capped(text)}\n`, 'utf8')
  return file
}

/**
 * The sender's own copy of what it sent.
 *
 * Without this a card's only record of a message is the other card's inbox, which it cannot read.
 * So a card could not answer "what did I already tell them", and neither could the owner reading
 * one card's directory. Same append-only rule as the inbox: a record, not a mailbox view.
 */
export function recordSent(
  fromId: string,
  toTitle: string,
  text: string,
  meta?: { kind?: string; taskId?: string | null; outcome?: string },
): string {
  const dir = mailDirFor(fromId)
  const file = join(dir, 'SENT.md')
  if (!existsSync(file)) {
    writeFileSync(file, '# Sent\n\nMessages this card sent along its wires.\n', 'utf8')
  }
  const bits: string[] = []
  if (meta?.kind) bits.push(`kind \`${meta.kind}\``)
  if (meta?.taskId) bits.push(`task \`${meta.taskId}\``)
  /*
   * What became of it, not merely that it was written.
   *
   * Every entry in here used to read the same whether the other card read the message and replied or
   * had no process at all, because the record was written before anything tried to wake anybody. A
   * card reviewing its own SENT.md to work out whether it had been answered could not tell the two
   * apart, which is the moment this file stops being evidence and starts being decoration.
   */
  if (meta?.outcome) bits.push(meta.outcome)
  const head = `## To ${toTitle}, ${stamp(new Date())}${bits.length ? `\n\n${bits.join(', ')}.` : ''}`
  appendFileSync(file, `\n${head}\n\n${capped(text)}\n`, 'utf8')
  return file
}

export function readInbox(sessionId: string): string {
  const file = join(mailDirFor(sessionId), 'INBOX.md')
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * What this card was asked to be, written where it can read it.
 *
 * The concurrency cap in the settings file is the part the CLI enforces, and it only limits how
 * many agents run at once. Everything else the owner set is an instruction rather than a rule: how
 * many helpers this card should keep to, what kind of card it is meant to be, and who it answers
 * to. An instruction nobody can read is not an instruction, and Garden was claiming to have
 * written this while writing nothing at all.
 *
 * Stated as a request, not as an enforced limit, because that is what it is.
 */
export function writePowers(
  session: {
    id: string
    title: string
    roleClass: string | null
    canSpawnAgents: boolean
    teamSize: number | null
    ownedPaths: string[] | null
  },
  answersTo: string | null,
): void {
  const dir = mailDirFor(session.id)
  const lines = [
    `# What "${session.title}" was asked to be`,
    '',
    'Garden maintains this file from the settings on this card. Some of it the CLI enforces and',
    'some of it is a request to you, and each line below says which.',
    '',
    `- You answer to ${answersTo ? `the card "${answersTo}"` : 'the owner directly'}. A request.`,
  ]

  /*
   * What this role may do, quoted from the one table that also writes the deny list.
   *
   * This used to be a second hardcoded map, and it drifted immediately: it told every manager that
   * the editing tools were denied so the only way it could change anything was to hire someone,
   * while Bash was still open. That sentence was false for every card that read it. One table, and
   * the enforced line comes from the same place as the denial.
   */
  if (session.roleClass) {
    const role = ROLE_POWERS[session.roleClass]
    lines.push(`- You are the ${session.roleClass}: ${role?.summary ?? session.roleClass}.`)
    if (role) {
      lines.push(`  ${role.enforced}`)
      lines.push(`  Denied by the CLI: ${role.denies.join(', ')}.`)
    }
    /*
     * The duty that comes with having anyone below you. Enforced, and said so, because the owner
     * added this step for a reason: without it a report walks from the worker to him with nobody
     * in between having looked at it.
     */
    if (role?.hires) {
      lines.push(
        '- When a card below you sends you `done`, look at what it actually did and send it',
        '  `confirm` before you pass the work up. Enforced: Garden refuses to let you report',
        '  something done while a report to you is still unanswered.',
      )
    }
  }

  /*
   * Which way to hand work out, which is a preference of the owner's rather than a rule.
   *
   * Both routes exist and both are allowed. The difference is what he can see. A card he can watch,
   * message, stop and come back to tomorrow is the unit this board is built out of, and work handed
   * along a wire leaves a trail in two mailboxes and a record on both cards. A subagent runs inside
   * somebody else's session and finishes; it earns its keep for the reading and the tool calls that
   * help one card get its own piece done, and it is the wrong shape for a piece of work that
   * somebody should own.
   *
   * Said as a preference and not enforced, deliberately. Denying the tool would stop an agent
   * reaching for help mid-task, which is the case where it is exactly right.
   */
  lines.push(
    '- Do your own work with your own subagents, and hand OUT the work that is not yours. A request.',
    '  The test is whose job it is, not how hard it is. Work inside your own part is yours: spawn as',
    '  many subagents as you need for reading around a problem, a search, a tool call or a second',
    '  opinion, and finish it yourself. Work that belongs to another card goes to that card, because',
    '  it was hired for it and starts from roots, instructions and reading that you do not have. You',
    '  would be redoing from scratch what somebody else already knows.',
    '  A card on the board can be watched, messaged, stopped and picked up again, and what passes',
    '  between two cards is recorded in both their mailboxes. A subagent runs inside your session',
    '  and is gone when it finishes, so nobody owns what it did.',
  )

  /*
   * How a card on this board comes to exist, which is the thing no card could previously find out.
   *
   * The shim exists, works and is handed to every session, and for a while the same was true of the
   * send shim and no agent ever used it, because nothing any agent could read said it was there. A
   * capability nobody is told about is the same as one that does not exist, so the exact command is
   * printed here rather than described.
   *
   * Both halves are stated, because which one applies is decided by the server from this card's own
   * role and not by anything the card passes.
   */
  const creates = !!(session.roleClass && ROLE_POWERS[session.roleClass]?.creates)
  lines.push(
    creates
      ? '- You are the one card that may bring another card into existence. Everything else asks you.'
      : '- You cannot create a card yourself, and you do not need to. Ask, and the orchestrator answers.',
    '  The command, either way. Write the roots to a file first, with your file writing tool:',
    '',
    '  ```',
    `  node "${forward(hireShimPath())}" --title "Loader worker" --role worker \\`,
    `    --reports-to ${session.id} --file "${forward(outboxDirFor(session.id))}/roots.md"`,
    '  ```',
    '',
    '  The roots are required and they go in the file, never inside the command: say what the card',
    '  is for, the part of the work it owns, what it must not touch, and who it defers to for the',
    '  rest. A card hired without them reads only the project instructions and answers as whatever',
    '  those describe rather than as the thing you hired. Real roots run to thousands of characters,',
    '  and a command carrying that much cannot be security scanned, so it stops and waits for the',
    '  owner.',
    '',
    '  `--reports-to` is in the example on purpose and leaving it out is not the safe default it',
    '  looks like. Without it the card is created with NO PARENT, which means no wire, which means',
    '  nothing can speak to it and it cannot answer. Pass another card id to put it under someone',
    '  else, or `garden-wire.mjs` afterwards to connect one that is already standing on its own.',
    creates
      ? '  Cards are created switched off. Start one with `--start <card id>` when you want it working.'
      : '  Your request is filed as mail to the orchestrator and answered along a wire. Nothing is',
    creates ? '' : '  created until it agrees.',
  )

  /*
   * The task contract, printed for the same reason the other two shims are.
   *
   * A card that cannot read its own contract works to what it remembers being told, which is the
   * drift this whole guard exists to stop. `show` is open to everybody on the board on purpose; the
   * four that change a contract are refused for a card that does not hand work out, and which of
   * those applies is decided by the server from this card's role rather than by anything it passes,
   * so both halves are stated here and neither is a promise this file is making on its own.
   */
  const dispatches = !!(session.roleClass && ROLE_POWERS[session.roleClass]?.hires)
  lines.push(
    '- Read the task you were given, rather than working from what you remember of it.',
    '',
    '  ```',
    `  node "${forward(taskShimPath())}" show --task <task id>`,
    '  ```',
    '',
    '  It prints who owns the task, who assigned it, who verifies it, the part of the tree it',
    '  covers, the acceptance criteria the work will actually be measured against, how it has',
    '  changed hands, and anything Garden refused on it. The criteria are hashed when the task is',
    '  opened, so whether they have been edited under you is a fact rather than an argument.',
    dispatches
      ? '  You hand work out, so the same command also takes `create`, `bind`, `reassign`, `split`'
      : '  Changing a contract belongs to the card that hands work out. Ask it rather than reaching',
    dispatches
      ? '  and `verifier`. A reassignment states a reason and Garden checks the reason itself, so a'
      : '  for these: `create`, `bind`, `reassign`, `split` and `verifier` are refused for you, and',
    dispatches
      ? '  wrong one comes back as a refusal naming what it found instead of your word for it.'
      : '  a refusal is not a thing to work around.',
  )

  /*
   * The part of the project this card is responsible for, and it is now partly enforced.
   *
   * The first attempt was to compile these paths into the card's settings file so the CLI refused
   * edits outside them, and that is not sayable: Claude Code evaluates deny rules before everything
   * else and a deny rule carries no exceptions, so there is no way to write "every file except
   * these", and a `Write(...)` path rule is accepted and then never consulted. Tested against the
   * installed CLI rather than assumed.
   *
   * What does work is the hook the card already runs. It sees each tool call before it happens and
   * can refuse one, which is the CLI's own supported mechanism rather than Garden overruling it.
   *
   * The split below is the honest one, and it matters. The editing tools are genuinely blocked. A
   * shell command is not, because the hook cannot tell which files a command line will touch, and
   * claiming otherwise would repeat the exact bug this file carries a scar from, where every
   * manager was told in writing about a denial that had never been written.
   */
  if (session.ownedPaths && session.ownedPaths.length > 0) {
    lines.push('- The part of the project that is yours:')
    for (const p of session.ownedPaths) lines.push(`  - \`${p}\``)
    lines.push(
      '  Enforced for the editing tools: Write, Edit, MultiEdit and NotebookEdit are refused',
      '  outside that list, and the refusal says so. Not enforced for Bash, because nothing can',
      '  tell in advance which files a shell command will write, so keeping to your own part there',
      '  is on you. That is how two cards working at once avoid landing on the same file.',
      '  Reading is not limited and never will be: read whatever you need to understand your own',
      '  part, and only put bytes on disk inside it.',
    )
  } else {
    lines.push('- No part of the project was marked as yours, so nothing narrows where you may work.')
  }

  if (!session.canSpawnAgents || session.teamSize === 0) {
    lines.push('- You may not hire agents at all. Enforced: the tool is denied and will refuse.')
  } else if (session.teamSize && session.teamSize > 0) {
    lines.push(
      `- Keep to ${session.teamSize} helper${session.teamSize === 1 ? '' : 's'} at a time. Partly enforced: the`,
      `  CLI caps how many run at once, but nothing stops you hiring more than ${session.teamSize} over a whole`,
      '  session, so the total is up to you.',
    )
  } else {
    lines.push('- No limit was set on hiring, so the CLI default applies.')
  }

  lines.push('', `Your inbox is ${join(dir, 'INBOX.md')} and who you are wired to is in PEERS.md.`, '')
  writeFileSync(join(dir, 'POWERS.md'), lines.join('\n'), 'utf8')
}
