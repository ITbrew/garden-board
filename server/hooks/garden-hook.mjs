/**
 * Garden's observer hook.
 *
 * This runs inside the CLI's own process on every hook event, so the first rule is that it must
 * never change what the CLI does and never make it wait. It reads the payload from stdin, posts a
 * copy to Garden, and exits 0 with empty stdout no matter what happens: no output means no
 * decision, which is what keeps this an observer rather than a second authority arguing with the
 * guards the owner already has.
 *
 * A dead Garden, a wrong port, a malformed payload and a refused connection all end the same way,
 * silently and successfully. The alternative is a hook that can wedge a terminal, and a tool that
 * can wedge the terminals it exists to manage would be worse than no tool.
 */
import { request } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.GARDEN_PORT) || 5178
const TIMEOUT_MS = 1200

/**
 * What this process will say on the way out. An empty object everywhere except SessionStart.
 *
 * An empty JSON object is "no decision, carry on", which is exactly what an observer should say.
 * Silence means the same thing on paper, but PreToolUse has shipped at least one build that
 * surfaced an error for it (claude-code#45761), and a hook that puts a red line in the owner's
 * terminal has already failed at being invisible.
 */
let output = '{}'

function done() {
  try {
    process.stdout.write(output)
  } catch {
    // A closed pipe is not a reason to keep this process alive.
  }
  process.exit(0)
}

const read = (dir, name) => {
  try {
    return readFileSync(join(dir, name), 'utf8').trim()
  } catch {
    return ''
  }
}

const readPath = (path) => {
  try {
    return path ? readFileSync(path, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

/**
 * A section of the startup brief, cut to its own budget rather than to whatever is left.
 *
 * The CLI spills hook output over ten thousand characters to a file and leaves a preview and a path
 * in its place, so an oversized brief does not fail loudly, it quietly stops being the brief. One
 * shared cap at the end handled that by cutting whatever came last, which meant adding a tier above
 * the card's brief would have silently eaten the card's brief.
 *
 * Each section gets its own allowance, and a section that does not fit says so and names the file,
 * so a card that wants the rest can read it. Trimmed and complete are different states and the card
 * is told which one it is looking at.
 */
const section = (text, limit, path, keep = 'head') => {
  if (!text) return ''
  if (text.length <= limit) return text

  /*
   * Some files are newest-last and must be cut from the front instead. An inbox and a lessons file
   * are both append-only records where the useful end is the bottom, so trimming them like a
   * document would keep the history and throw away the news.
   */
  if (keep === 'tail') {
    const note = `[Earlier entries not shown. The whole file is at ${path}.]`
    // The note is part of the allowance, not an extra on top of it. Adding it afterwards is what
    // made the total overshoot and land on the backstop, which cut a different section instead.
    const from = text.slice(-Math.max(0, limit - note.length - 2))
    const start = from.indexOf('\n')
    return `${note}\n\n${start > -1 ? from.slice(start + 1) : from}`
  }

  /*
   * Cut at a paragraph boundary, and say what was dropped rather than only that something was.
   *
   * The old cut landed mid-sentence and left a note naming the file. Measured on 2026-08-14, the
   * shared roots file was cut inside the words "do not infer ownership", taking the whole rule about
   * never pointing a script at the live board with it, and nobody ever followed the note. A path
   * with no statement of what is at the end of it is not an instruction, it is a footnote.
   */
  const headings = (from) =>
    from
      .split('\n')
      .filter((l) => l.startsWith('#'))
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .filter(Boolean)

  // Two passes, because the note names what was dropped and therefore cannot be measured until the
  // cut is known, while the cut has to leave room for the note. The first pass is an estimate and
  // the second is the real one, which converges because the second note is never longer.
  let room = limit
  let kept = ''
  for (let pass = 0; pass < 2; pass++) {
    const cut = text.slice(0, Math.max(0, room))
    const boundary = cut.lastIndexOf('\n\n')
    kept = boundary > room / 2 ? cut.slice(0, boundary) : cut
    const dropped = headings(text.slice(kept.length))
    const what = dropped.length ? ` Not shown here: ${dropped.join('; ')}.` : ''
    const where = path ? ` Read ${path} for it.` : ''
    const note = `[Trimmed to fit the startup brief.${what}${where}]`
    if (pass === 1 || kept.length + note.length + 2 <= limit) {
      return `${kept}\n\n${note}`.slice(0, limit)
    }
    room = limit - note.length - 2
  }
  return kept
}

/**
 * Whether this CLI is the card's own session, or something the card started.
 *
 * Garden spawns a card's shell with GARDEN_SESSION_ID, GARDEN_CARD and GARDEN_MAIL_DIR set, and
 * inheritance is the whole point: a hook five processes down still knows which card it belongs to.
 * That is also the hole. An agent inside the card that shells out and runs `claude` again, or the
 * owner typing `claude` at that card's prompt, produces a brand new session which inherits all
 * three, so it was briefed "You are running as Boss" and every event it fired was posted under
 * Boss's id. A separate conversation, possibly in another folder, wearing a card's identity. That
 * is the failure this app exists to refuse, and no environment variable can fix it, because a
 * descendant inherits whatever is put in one.
 *
 * What a descendant cannot inherit is being first. Garden sets GARDEN_LAUNCH to a fresh random
 * value every time it spawns a card's shell, and the first CLI to present that value writes a
 * claim into the card's own mail directory. The card's own CLI is necessarily first, because it is
 * the process that any descendant is started from. A later session presenting a launch that is
 * already claimed by a different CLI session id is therefore below the one that claimed it.
 *
 * Be clear about what that proves and what it does not. It proves ordering within one launch. It
 * does NOT prove ancestry: the honest way to prove ancestry on Windows is to walk the parent chain,
 * and every way of doing that from Node here costs a process spawn, on a hook that runs on every
 * event and has to be gone inside a second. Ordering is the cheap signal that is right in the case
 * that actually happens.
 *
 * Three legitimate things must never be read as a descendant, so they are handled by name:
 *
 * A restart of the card. Garden generates a new GARDEN_LAUNCH on every spawn, so the old claim no
 * longer matches and the new session claims freshly. This is why the value cannot be the card id,
 * which is stable for the life of the card: a restarted card would have found its own dead claim
 * sitting there and briefed itself as a descendant of itself.
 *
 * A resume, a compact, or `/clear`. All three fire SessionStart again, from the same process, and
 * the CLI does not always keep the same session id across them. Any source other than "startup"
 * means a session the CLI restarted in place rather than a new invocation, so the claim moves to
 * the new id instead of refusing it. A nested `claude --resume` would slip through this, which is
 * the deliberate direction: briefing a real card matters more than catching every impostor.
 *
 * The owner starting a session by hand in the card's shell after the CLI exited. SessionEnd
 * releases the claim, so the next startup in that launch takes it. If the CLI was killed without
 * firing SessionEnd, that session is treated as a descendant and gets no brief, which is visibly
 * wrong rather than quietly wrong, and turning the card off and on fixes it.
 *
 * With no GARDEN_LAUNCH in the environment at all, nothing here can be proved either way, and this
 * returns true so an older Garden, or a card started some other way, behaves exactly as it did
 * before. Same for an unreadable or unwritable mail directory. Uncertainty brief the session; only
 * a claim actually held by a different session withholds anything.
 */
const CLAIM_FILE = '.launch-claim.json'

function readClaim(dir) {
  try {
    const c = JSON.parse(readFileSync(join(dir, CLAIM_FILE), 'utf8'))
    return c && typeof c === 'object' ? c : null
  } catch {
    return null
  }
}

function writeClaim(dir, claim) {
  try {
    writeFileSync(join(dir, CLAIM_FILE), JSON.stringify(claim), 'utf8')
  } catch {
    // A claim that cannot be written leaves every session looking like the first one, which briefs
    // the real card and briefs a descendant too. That is the same behaviour as before this existed,
    // and it is the right way to fail: a card that is never briefed is the louder bug.
  }
}

/**
 * Decide once per process whether this event belongs to the card, and remember the verdict for the
 * sessions that were turned away.
 *
 * The judgement is only ever made at SessionStart, because that is the one event carrying `source`,
 * which is what separates a new invocation from the CLI restarting a session in place. Every other
 * event is matched against the small list of session ids already refused. Anything not on that list
 * is treated as the card's, on purpose: subagents and teammates fire events under ids this hook
 * never saw start, and refusing those would lose a whole team from the board to catch nothing.
 */
function isOwnSession(event) {
  const launch = process.env.GARDEN_LAUNCH
  const dir = process.env.GARDEN_MAIL_DIR
  if (!launch || !dir) return true

  const cli = typeof event.session_id === 'string' ? event.session_id : null
  const claim = readClaim(dir)
  const held = claim && claim.launch === launch ? claim : null
  const denied = Array.isArray(held?.denied) ? held.denied : []
  if (cli && denied.includes(cli)) return false

  if (event.hook_event_name === 'SessionEnd') {
    if (held && cli && held.cli === cli) writeClaim(dir, { ...held, ended: true })
    return true
  }
  if (event.hook_event_name !== 'SessionStart') return true

  // No claim for this launch yet, so this is the first CLI of it, which is the card's own.
  if (!held) {
    writeClaim(dir, { launch, cli, ended: false, denied: [] })
    return true
  }
  if (!cli || held.cli === cli) return true
  // Not a fresh invocation: the CLI restarted this session in place, so the claim follows it.
  if (event.source && event.source !== 'startup') {
    writeClaim(dir, { ...held, cli, ended: false })
    return true
  }
  // The claimed session said goodbye, so the shell it left behind is still the card's to use.
  if (held.ended) {
    writeClaim(dir, { ...held, cli, ended: false })
    return true
  }

  // A second CLI started under a launch another session is still holding. Kept to the last few ids
  // because this only has to cover sessions currently alive, and the file should stay small enough
  // to read on every event without thinking about it.
  writeClaim(dir, { ...held, denied: [...denied, cli].slice(-16) })
  return false
}

/** The tools that change a file. Reading is never restricted, so nothing else is considered. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * The file a write tool is about to change, or null when this is not a write or the payload does
 * not name a path.
 *
 * Two separate checks need this same answer now, the card's own territory and the shared flag the
 * server hands out, and they must agree about what "the file being written" means. A second copy of
 * the spelling list would drift the first time a tool grows another field name, and then one check
 * would guard a write the other waved through.
 *
 * file_path is documented for Write and Edit. The other two are not documented, so several
 * spellings are tried and an unrecognised shape returns null, which every caller reads as "say
 * nothing" rather than as "no path, so refuse". A wrong refusal blocks real work and gets blamed on
 * the model rather than on Garden.
 */
function writeTarget(event) {
  const tool = typeof event.tool_name === 'string' ? event.tool_name : null
  if (!tool || !WRITE_TOOLS.has(tool)) return null
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {}
  const target = [input.file_path, input.filePath, input.notebook_path, input.path].find(
    (p) => typeof p === 'string' && p,
  )
  return target || null
}

/**
 * Refuse a write outside this card's own files, or return null to say nothing.
 *
 * The owner's model is that a boss owns the repo, a manager owns an area and a worker owns files,
 * and the settings file cannot express that. The CLI evaluates deny before allow and a deny rule
 * cannot carry exceptions, so "edit only these paths" has no rule form, and `Write(...)` path rules
 * are accepted and then never consulted. Writing one would have handed the card a restriction the
 * CLI silently ignores, which is worse than admitting there is none. This is the supported way to
 * express it: the CLI asks before the call, and this answers.
 *
 * It refuses only, never permits. A card with no territory is not mentioned, so every existing card
 * behaves exactly as it did, and the CLI's own permission layer stays the only thing granting
 * anything. Reads are untouched: a specialist still has to understand the code around its own.
 *
 * When the tool is a write but no path can be read out of the payload, this says nothing rather
 * than guessing, which is why writeTarget returns null instead of a guess. The brief tells the
 * agent its territory in words as well, so the boundary is not resting on this alone.
 */
function writeOutsideTerritory(event, target) {
  const raw = process.env.GARDEN_OWNED_PATHS
  if (!raw || !target) return null

  let owned
  try {
    owned = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(owned) || owned.length === 0) return null

  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const file = norm(target)

  /*
   * A card's own two directories are never somebody else's work, whatever territory it was given.
   *
   * Without this, the first card handed owned paths would be unable to write the outgoing message
   * file that PEERS.md tells every card to write, and so would be unable to send at all: a setting
   * meant to stop two cards editing one file would silently become a communication outage. Its
   * memory directory is here for the same reason, because every card is told to leave its notes and
   * what it learned there before it finishes.
   *
   * Strict prefix rather than the loose matching used below for repo paths, and only the two
   * directories named in THIS process's environment. Not "any mail directory": that would let a card
   * write straight into another card's INBOX.md and forge a delivery, which is a worse hole than the
   * one this whole function exists to close.
   */
  const mine = [process.env.GARDEN_MAIL_DIR, process.env.GARDEN_MEMORY_DIR]
    .filter((p) => typeof p === 'string' && p)
    .map(norm)
  if (mine.some((own) => file === own || file.startsWith(`${own}/`))) return null
  const inside = owned.some((p) => {
    if (typeof p !== 'string' || !p) return false
    const own = norm(p)
    // A folder covers everything under it; a file matches itself. Compared on a boundary so that
    // owning "src/app" does not silently also claim "src/application".
    return file === own || file.startsWith(`${own}/`) || file.endsWith(`/${own}`) || file.includes(`/${own}/`)
  })
  if (inside) return null

  return (
    `This card owns ${owned.join(', ')} and ${target} is outside that. Garden refused the write ` +
    'rather than let two cards edit the same file. If this really is your work, ask the owner to ' +
    'widen what this card owns, or hand it to the card that does own it.'
  )
}

/**
 * What a verifier may touch, refused here rather than in the CLI's settings.
 *
 * The role exists because a persistent independent verifier has to be able to report, and `reviewer`
 * cannot: Bash is denied to it, `garden-send.mjs` runs under Bash, and Write is denied so it cannot
 * even write the file the shim sends. So `verifier` is given Write, Edit and Bash by the CLI and has
 * them narrowed here, to its own two directories and to Garden's three shims.
 *
 * The cost of that arrangement, stated rather than left to be discovered: for every other role the
 * deny list is a backstop that holds even with this hook removed, and for this one the hook is the
 * only line. Canon 20 says so in those words. It is here rather than there because the settings file
 * has no rule shape for "these paths and no others": the CLI evaluates deny before allow, a deny
 * cannot carry exceptions, and `Write(<path>)` rules are accepted and then never consulted.
 *
 * Both checks are local and need no server, so they hold with Garden down, which is the same
 * property the territory check above has and for the same reason.
 */
const VERIFIER_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function verifierRefusal(event) {
  if (process.env.GARDEN_ROLE !== 'verifier') return null
  const tool = typeof event.tool_name === 'string' ? event.tool_name : null
  if (!tool) return null

  if (VERIFIER_WRITE_TOOLS.has(tool)) {
    const target = writeTarget(event)
    // No readable path is no opinion, exactly as it is for territory: a wrong refusal blocks real
    // work and gets blamed on the model rather than on Garden.
    if (!target) return null
    const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const file = norm(target)
    const mine = [process.env.GARDEN_MAIL_DIR, process.env.GARDEN_MEMORY_DIR]
      .filter((p) => typeof p === 'string' && p)
      .map(norm)
    if (mine.some((own) => file === own || file.startsWith(`${own}/`))) return null
    return (
      `This card verifies work and does not change it, so Garden refused the write to ${target}. ` +
      'A verifier that edits the thing it is checking has checked nothing. Write your findings to ' +
      'a file in your own outbox and send them, and the card that owns the work will make the change.'
    )
  }

  if (tool === 'Bash') {
    const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {}
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command.trim()) return null
    /*
     * Matched at the START of the command and nowhere else, because anything looser is not a check.
     * A command is allowed to be `node "<shim>" --to ...`, with or without the quotes and with or
     * without the `node`, and that is the whole grammar: no separators, no pipes, no second command
     * after one. Something that merely CONTAINS a shim path would let `rm -rf x; node <shim> ...`
     * through, which is the shape this is here to stop.
     */
    const head = command.trim().replace(/^node\s+/i, '').replace(/^["']/, '').replace(/\\/g, '/').toLowerCase()
    const first = head.split(/["'\s]/)[0]
    const isShim = ['garden-send.mjs', 'garden-hire.mjs', 'garden-task.mjs'].some(
      (s) => first === s || first.endsWith(`/${s}`),
    )
    /*
     * A separator anywhere is a refusal even when the command starts with a shim, because
     * `node <shim> --to X ; rm -rf y` starts with a shim and is not a send. None of the three shims
     * takes an argument that needs one: every value they accept is a card title, an id, a single
     * word or a path.
     */
    if (isShim && !/[;&|><`]|\$\(/.test(command)) return null
    return (
      'This card verifies work and does not run it. The only commands a verifier may run are ' +
      "Garden's own shims: garden-send.mjs to report what you found, garden-task.mjs to read the " +
      'task you are checking, garden-hire.mjs if you were given hiring. Read with Read, Grep and ' +
      'Glob, which are open to you.'
    )
  }

  return null
}

/**
 * How long the flag request gets before this hook stops waiting for it.
 *
 * It is deliberately far shorter than the post that follows it, because the two are sequential and
 * the whole process still has to be gone inside the same budget it had before. The server is on
 * loopback and answers out of memory, so anything that takes longer than this is not a slow answer,
 * it is a server that is restarting or gone, and the right response to that is to stop waiting.
 */
const CLAIM_TIMEOUT_MS = 400

/**
 * Ask the server whether another live card is already working this file, and call back with the
 * server's own refusal text or with null to allow.
 *
 * The owner's complaint was concrete: two cards edited the same file at the same time and the edits
 * fought. Territory answers "is this mine", which is static and set when the card was made. This
 * answers "is somebody in it right now", which nothing on this machine could know except the server
 * that watches every card, so it has to be asked, and it has to be asked before the write rather
 * than reported after it.
 *
 * Every failure path here allows the write. A refused connection, a timeout, a socket dying
 * mid-response, a non-JSON body, a 500, a body with no `deny` string: all of them end in next(null).
 * That is not laziness about error handling, it is the priority. Garden not running is the normal
 * state of this machine most of the time, and a hook that blocked writes whenever Garden was down
 * would make the CLI unusable to fix Garden. An occasional collision is the cheaper failure, and
 * the territory check above still stands on its own with no server at all.
 */
/**
 * The tools that dispatch a subagent, under both of the names this project has seen them called.
 *
 * `server/src/hooks-install.ts` already had to learn this the hard way and says so: "Task is what
 * the matcher syntax calls the dispatch tool, but the permission entry is Agent". Which of the two
 * arrives in `tool_name` depends on the build, so both are matched. Matching one and guessing wrong
 * is the failure that matters here, because it would leave the board saying a card has a spawn
 * limit while the card spawns freely, and a limit that does not refuse is worse than no limit: the
 * panel would be asserting something Garden cannot back up.
 *
 * A name that is not on this list is not treated as a dispatch, so every other tool call goes
 * through untouched and unasked.
 */
const DISPATCH_TOOLS = new Set(['Task', 'Agent'])

function isDispatch(event) {
  const tool = typeof event.tool_name === 'string' ? event.tool_name : null
  return Boolean(tool && DISPATCH_TOOLS.has(tool))
}

/**
 * Ask the server whether this card has spawned its allowance, and refuse the dispatch if it has.
 *
 * The same shape as `askForClaim` below and for the same reasons, down to the timeout: the server
 * answers or it does not, and not answering means the dispatch goes ahead. Canon 15 forbids a
 * silent refusal, and it equally forbids Garden becoming a thing that stops work when its own
 * backend is down. A limit that fails closed on a restart would look exactly like the CLI breaking.
 *
 * This is the one place Garden refuses a subagent, and it can only be here. Garden hears about a
 * subagent through `SubagentStart`, which the CLI fires after its own dispatch, so a check anywhere
 * downstream would be refusing to record something that is already running. `PreToolUse` is before.
 */
function askForDispatch(gardenSessionId, next) {
  let settled = false
  const finish = (reason) => {
    if (settled) return
    settled = true
    next(reason)
  }

  let body
  try {
    body = JSON.stringify({ gardenSessionId })
  } catch {
    return finish(null)
  }

  const token = process.env.GARDEN_SESSION_TOKEN
  const req = request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/dispatch',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => {
        text += d
        if (text.length > 64 * 1024) {
          req.destroy()
          finish(null)
        }
      })
      res.on('error', () => finish(null))
      res.on('end', () => {
        try {
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed.deny === 'string' && parsed.deny) return finish(parsed.deny)
        } catch {
          // An unparseable body is an unexpected answer, and unexpected means allow.
        }
        finish(null)
      })
    },
  )
  req.setTimeout(CLAIM_TIMEOUT_MS, () => {
    req.destroy()
    /*
     * Said out loud on stderr, for the same reason the claim timeout is: the dispatch is about to
     * happen without having been counted, and a subagent spawned during a restart should not be
     * indistinguishable from one Garden allowed.
     */
    try {
      process.stderr.write(
        `[garden] Garden did not answer in ${CLAIM_TIMEOUT_MS}ms, so this dispatch went ahead without ` +
          'being checked against this card\'s subagent allowance. The server is restarting or down.\n',
      )
    } catch {
      // A closed pipe must never stop the dispatch either.
    }
    finish(null)
  })
  req.on('error', (err) => {
    /*
     * The same correction this file already made for the claim door, applied here rather than
     * learned again: nothing listening answers instantly with ECONNREFUSED, so the 400 ms timeout
     * never fires and this is the path a dispatch during a restart actually takes. Guarded on
     * `settled` because a destroyed request arrives here a moment later and one event earns one
     * line.
     */
    if (!settled) {
      try {
        process.stderr.write(
          `[garden] Garden did not answer (${err?.code ?? 'connection failed'}), so this dispatch went ` +
            "ahead without being checked against this card's subagent allowance. The server is down or " +
            'not listening on this port.\n',
        )
      } catch {
        // A closed pipe must never stop the dispatch either.
      }
    }
    finish(null)
  })
  req.end(body)
}

function askForClaim(gardenSessionId, target, next) {
  let settled = false
  const finish = (reason) => {
    if (settled) return
    settled = true
    next(reason)
  }

  let body
  try {
    body = JSON.stringify({ gardenSessionId, path: target })
  } catch {
    return finish(null)
  }

  /*
   * The card's token travels with the claim, and the server resolves the writer from it.
   *
   * Without this the only thing naming the writer was `gardenSessionId` in the body, which any
   * process that inherited the environment could put anything in, so the territory check was being
   * applied to whichever card the writer claimed to be. The three shims have sent this header since
   * tokens landed; this door was the one that did not.
   */
  const token = process.env.GARDEN_SESSION_TOKEN
  const req = request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/claim',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => {
        text += d
        // A reason long enough to matter is a sentence. Anything past this is not an answer.
        if (text.length > 64 * 1024) {
          req.destroy()
          finish(null)
        }
      })
      res.on('error', () => finish(null))
      res.on('end', () => {
        try {
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed.deny === 'string' && parsed.deny) return finish(parsed.deny)
        } catch {
          // An unparseable body is an unexpected answer, and unexpected means allow.
        }
        finish(null)
      })
    },
  )
  req.setTimeout(CLAIM_TIMEOUT_MS, () => {
    req.destroy()
    /*
     * Say it out loud, because the write is about to happen unchecked.
     *
     * Canon 20 is explicit that the write goes ahead when nothing answers, and equally explicit that
     * the transcript should show it went ahead unasked, so a file edited during a restart is not
     * indistinguishable from one Garden approved. On stderr rather than stdout: stdout carries this
     * hook's decision as JSON and a stray line in it would be read as a malformed decision. Which
     * means the line shows in the transcript rather than inline, and that is as far as a PreToolUse
     * hook can print without arguing with the tool it is observing.
     */
    try {
      process.stderr.write(
        `[garden] ${target}: Garden did not answer in ${CLAIM_TIMEOUT_MS}ms, so this write went ahead ` +
          'without being checked against another card holding the file or against this card\'s task ' +
          'territory. The server is restarting or down.\n',
      )
    } catch {
      // A closed pipe must never stop the write either.
    }
    finish(null)
  })
  req.on('error', (err) => {
    /*
     * The commonest "Garden is down" is not the timeout, it is this.
     *
     * Nothing listening on the port answers instantly with ECONNREFUSED, so the write goes ahead in
     * about a millisecond and the 400 ms timeout above never fires. That is the case the transcript
     * most needs a line for, and it was the silent one: a write during a restart looked exactly like
     * a write Garden approved. Guarded on `settled` because the timeout destroys the request, which
     * arrives here as an error a moment later, and one event deserves one line.
     */
    if (!settled) {
      try {
        process.stderr.write(
          `[garden] ${target}: Garden did not answer (${err?.code ?? 'connection failed'}), so this ` +
            'write went ahead without being checked against another card holding the file or against ' +
            "this card's task territory. The server is down or not listening on this port.\n",
        )
      } catch {
        // A closed pipe must never stop the write either.
      }
    }
    finish(null)
  })
  req.end(body)
}

/**
 * The one place this hook stops being a pure observer, and the reason is that nothing else could
 * do this job.
 *
 * Garden writes each card a POWERS.md saying what it was asked to be and a PEERS.md saying who it
 * is wired to, and for a long time it wrote them and stopped there. A file on disk is not context:
 * the session had no reason to look, so a card opened knowing nothing about itself and answered as
 * whatever the shared project memory happened to describe. The owner watched an orchestrator card
 * introduce itself using another session's identity file, which is the exact failure this fixes.
 *
 * SessionStart is the CLI's own supported place to add context, so the brief arrives through the
 * documented door rather than by Garden typing into the terminal and hoping the prompt was ready.
 * It is read straight off disk instead of being fetched from the server, because the moment this
 * matters most is a card restarting while the server is restarting too.
 *
 * Still no decision, no denial, and no argument with any guard the owner already has: the only
 * thing added is a description of the card, and if the files are not there, nothing is added.
 */
function sessionStartContext() {
  const dir = process.env.GARDEN_MAIL_DIR
  if (!dir) return null
  const powers = read(dir, 'POWERS.md')
  const peers = read(dir, 'PEERS.md')
  /*
   * The owner's own back and forth with this card, if he has drawn it a message card.
   *
   * Separate from the inbox on purpose, and that separation is the entire feature. Mail is other
   * cards handing work along wires; this is the one human on the board talking to this one card,
   * and his reason for wanting it apart was that the two sentences he exchanged with his
   * orchestrator were impossible to find among everything else it was doing.
   */
  const notes = read(dir, 'NOTES.md')
  // The brief counts too. It is now the only instructions some cards have, so a card with a brief
  // and nothing else must not fall out here with nothing injected.
  /*
   * The brief, only when the launch did not already carry it.
   *
   * It now travels as `--append-system-prompt-file`, which has no budget, so it arrives whole
   * however long it grows. That flag was verified against the installed CLI rather than taken from
   * the help text: a probe answered "BANANAS" to "what is 2+2" because the file told it to.
   *
   * This path stays for a card whose directory has no `CLAUDE.md` at launch, and for any launcher
   * that does not set the flag. When both routes fire the card gets the same instructions twice,
   * once whole and once cut, and cannot tell which is authoritative, so the adapter sets
   * GARDEN_BRIEF_DELIVERED and this defers to it.
   */
  const ownBrief =
    process.env.GARDEN_BRIEF_DELIVERED === '1' || !process.env.GARDEN_MEMORY_DIR
      ? ''
      : read(process.env.GARDEN_MEMORY_DIR, 'CLAUDE.md')

  /*
   * Corrections, which are the one part of a card's memory that must arrive before it acts.
   *
   * The board has always drawn the memory column as `always` in play. Nothing loaded it. A card was
   * told the directory existed, in one line at the very end of its startup context, and left to
   * decide for itself whether to go and look, which is why a manager card wrote down that it had
   * been running on the wrong instructions and could not tell. Notes and playbook stay on demand,
   * named in ROOTS.md; lessons do not, because a correction that arrives after the mistake is not
   * a correction.
   */
  const lessons = process.env.GARDEN_MEMORY_DIR ? read(process.env.GARDEN_MEMORY_DIR, 'LESSONS.md') : ''
  /*
   * The two tiers above this card's own, read off disk at the moment the session starts.
   *
   * General to specific: what every card is told, then what this kind of card is told, then what
   * this card is told. The order is the point. A worker does not need to be told how to run a blind
   * review, and a reviewer does not need the hiring budget, and both of those used to arrive anyway
   * inside a document written for somebody else entirely.
   */
  const sharedRoots = readPath(process.env.GARDEN_ROOTS_ALL)
  const roleRoots = readPath(process.env.GARDEN_ROOTS_ROLE)
  if (!powers && !peers && !ownBrief && !sharedRoots && !roleRoots && !lessons && !notes) return null

  const card = process.env.GARDEN_CARD || 'a card'
  const parts = [
    `You are running as "${card}", a card on the owner's Garden board. This is who you are in`,
    'this session. A card does not inherit the project\'s instructions or the machine\'s: everything',
    'below is what applies to you, narrowing from every card, to your role, to you.',
    '',
  ]

  /*
   * Allowances are worked out from what is actually here, not fixed in advance.
   *
   * Fixed caps were the original design and they failed in the one way that matters: silently, and
   * worst on the busiest cards. Measured on 2026-08-14 across the owner's real board, 265 files were
   * over their cap. `PEERS.md`, the file naming every card this one is allowed to message, was
   * capped at 600 and ran to 6244, so a manager was seeing a tenth of its own wires. Lessons ran to
   * 6501 against 1800. A number chosen once cannot track a file that grows every time the card
   * works, which is exactly what these files do.
   *
   * So: every section asks for what it is, and if the total fits, nothing is cut at all. When it
   * does not fit, the space is shared out smallest-first, which means a small file is always whole
   * and only the genuinely large ones are trimmed, splitting what is left evenly between them.
   */
  const budget = 9200
  /*
   * The instruction tiers do not compete for space with the rest.
   *
   * Fair sharing alone would let them be trimmed whenever a card's mail and lessons grew, and they
   * are the two files that say what a card must never do. Measured: with real file sizes the shared
   * roots came fourth by size and lost a quarter of themselves to a full inbox, which is the
   * original defect wearing a better algorithm. They are served first, out of their own reserve.
   *
   * The reserve is a ceiling as well as a floor. Instructions past it are not protected, because a
   * tier that large is a writing problem and `scripts/roots-fit.mjs` is where it should be caught.
   */
  const RESERVE = 6200
  /*
   * The inbox is the one input with no natural size, and it is capped for that reason alone.
   *
   * Measured on the live board: one card's INBOX.md is 281,051 characters, another's 197,498. Under
   * plain sharing an inbox that size takes an equal slice of everything, which it then spends on
   * mail the card has mostly already dealt with, while PEERS.md gets cut. PEERS is the file naming
   * who this card may send to, so trimming it to make room for old mail is how a handoff stops
   * being possible. Mail also arrives live while a card runs; this section is only the catch-up for
   * time it spent switched off, and the trim marker names the file for the rest.
   */
  const INBOX_MAX = 400
  const wanted = []
  const ask = (text, path, keep = 'head', lead = null, first = false) => {
    if (text) wanted.push({ text, path, keep, lead, first })
  }

  ask(sharedRoots, process.env.GARDEN_ROOTS_ALL, 'head', null, true)
  ask(roleRoots, process.env.GARDEN_ROOTS_ROLE, 'head', null, true)

  /*
   * The brief, on the fallback route only. See where `ownBrief` is read for why it is usually empty.
   *
   * Its old allowance was 3000 characters, and giving it up is what pays for the lessons section
   * below. Measured before the change: a real boss brief was 5236 characters and a real manager
   * brief 7410, so the budget was never enough for the thing it was budgeting.
   */
  ask(ownBrief, join(process.env.GARDEN_MEMORY_DIR || '', 'CLAUDE.md'))
  ask(powers, join(dir, 'POWERS.md'))
  /*
   * Peers are protected alongside the instruction tiers, and powers deliberately are not.
   *
   * Both describe limits, but they fail differently. A card whose POWERS list is cut tries something
   * and is refused, which is visible and recoverable in one turn. A card whose PEERS list is cut
   * cannot see a wire it has, so it silently does not hand work over, and nobody learns that it
   * could have. The invisible failure gets the protection.
   */
  ask(peers, join(dir, 'PEERS.md'), 'head', null, true)
  /*
   * The owner's notes, kept from the NEWEST end and protected alongside the instruction tiers.
   *
   * Newest end because a conversation's last exchange is the one that is still open, and cutting
   * from the front here would hand back the greeting and drop the question. Protected because this
   * is the only thing in the whole injection that the owner wrote to this card by hand, and it
   * fails invisibly if it is cut: the card cannot tell that it was asked something, so it does not
   * answer, and he reads that as being ignored.
   */
  ask(
    notes,
    join(dir, 'NOTES.md'),
    'tail',
    'Your message card with the owner. This is only the two of you, kept out of the terminal and ' +
      'out of your mail so it stays findable. Reply by appending to this same file, and keep it to ' +
      'what you would say to him rather than what you did:',
    true,
  )
  /*
   * Lessons are kept from the NEWEST end.
   *
   * The seeded header says "newest at the bottom", so cutting from the front keeps the stalest
   * corrections and throws away the ones the card learned most recently. That is precisely
   * backwards, and it would have been the behaviour of every other section applied unchanged.
   */
  ask(
    lessons,
    join(process.env.GARDEN_MEMORY_DIR || '', 'LESSONS.md'),
    'tail',
    'What you learned the last times you did this job. These are corrections, so they come before you act rather than after:',
  )
  /*
   * Where the rest of this card's roots are, before the inbox rather than after it.
   *
   * It used to be the last line written, after an inbox tail of up to 1200 characters, under a 9000
   * character backstop that the budgets could reach. So the one line telling a card where its own
   * memory lives was the first thing to be dropped, on exactly the cards with the most mail, which
   * are the busiest ones.
   */
  if (process.env.GARDEN_MEMORY_DIR) {
    parts.push(
      `Your own roots are in ${process.env.GARDEN_MEMORY_DIR}, and they survive being turned off.`,
      'ROOTS.md there says what to open and the condition that means open it now. Your notes and your',
      'playbook are in that same directory. Read from them when the task calls for it rather than at',
      'the start: reading widely to feel prepared is what cancels the reason this board exists.',
      '',
    )
  }
  /*
   * Mail that arrived while this card was switched off.
   *
   * A running card is told the moment something lands, by a line written into its own terminal. A
   * card that was off cannot be told anything, and its inbox is append-only, so whatever was said
   * to it while it was away is sitting in the file unread. Startup is the one moment it can be
   * handed over. The tail rather than the whole file, because an inbox is a permanent record and
   * the old end of it is history, not instructions.
   */
  const inbox = read(dir, 'INBOX.md')
  if (inbox) {
    wanted.push({
      text: inbox,
      path: join(dir, 'INBOX.md'),
      keep: 'tail',
      lead: 'Messages arrived on your wires while you were off. Read these before you start, and reply along the wire each came from:',
      cap: INBOX_MAX,
    })
  }

  /*
   * Max-min fair sharing. Smallest first, each taking either what it needs or an equal share of
   * what is left, whichever is less, and handing its slack to the ones behind it.
   *
   * The property that matters: if everything fits, nothing is cut. On a card whose files total less
   * than the budget, which is most cards, this loop is a no-op and the whole startup context is
   * exact. Only a card carrying genuinely more than fits ever sees a trim, and then the big files
   * pay for it rather than whichever one happened to be last in the list.
   */
  // The fixed prose and every section's own lead line are spent before anything is shared out, so
  // the allocation is against what is genuinely free rather than against the whole budget.
  let left = budget - parts.join('\n').length - wanted.reduce((n, s) => n + (s.lead?.length ?? 0) + 2, 0)

  // Capped sections are settled first, at their cap or their length, whichever is smaller. A card
  // with three lines of mail gives the rest of its cap straight back to everything else.
  for (const s of wanted.filter((s) => s.cap)) {
    s.allow = Math.min(s.text.length, s.cap)
    left -= s.allow
  }

  let reserve = RESERVE
  for (const s of wanted.filter((s) => s.first)) {
    s.allow = Math.min(s.text.length, reserve)
    reserve -= s.allow
    left -= s.allow
  }

  const rest = wanted.filter((s) => !s.first && !s.cap)
  let n = rest.length
  for (const s of [...rest].sort((a, b) => a.text.length - b.text.length)) {
    const share = Math.max(0, Math.floor(left / n))
    s.allow = Math.min(s.text.length, share)
    left -= s.allow
    n--
  }

  for (const s of wanted) {
    if (s.lead) parts.push(s.lead, '')
    parts.push(section(s.text, s.allow, s.path, s.keep), '')
  }

  /*
   * A backstop, and it should now never fire.
   *
   * The allocation above is computed against this same number, so crossing it would mean an
   * arithmetic bug rather than a large file. It stays because the consequence is bad and silent:
   * past the CLI's ten thousand character ceiling the whole thing is spilled to a file and replaced
   * with a preview and a path, so a startup brief that grew would stop being a brief without
   * anything failing.
   */
  return parts.join('\n').slice(0, 9600)
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  raw += d
  // A runaway payload is not worth forwarding and not worth buffering.
  if (raw.length > 4 * 1024 * 1024) raw = raw.slice(0, 4 * 1024 * 1024)
})
process.stdin.on('error', done)
process.stdin.on('end', () => {
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return done()
  }
  if (!event || typeof event !== 'object') return done()

  /*
   * A session that cannot be proved to be this card's gets nothing and gives nothing.
   *
   * No brief, because telling a separate conversation it is Boss is how a session ends up
   * answering as a card it is not. No post, rather than a post with a null id, because the server
   * falls back to matching on the CLI's session id and a descendant resuming the card's own
   * conversation would be attributed anyway. And no territory refusal, since a card's owned paths
   * describe that card's work and have no business governing somebody else's session.
   */
  if (!isOwnSession(event)) return done()

  const denyWrite = (reason) => {
    output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  }

  if (event.hook_event_name === 'SessionStart') {
    const context = sessionStartContext()
    if (context) {
      output = JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
      })
    }
  }

  if (event.hook_event_name === 'PreToolUse') {
    const target = writeTarget(event)
    /*
     * The verifier's narrowing is asked first, because it is the wider of the two: it covers Bash
     * as well as the editing tools, and a verifier with no owned paths would otherwise be told
     * nothing at all by the check below.
     */
    const verifierNo = verifierRefusal(event)
    if (verifierNo) {
      denyWrite(verifierNo)
      return postEvent(event)
    }
    /*
     * A dispatch is asked about before the write checks below, because it is not a write and would
     * otherwise fall past both of them with `target` null.
     *
     * Same condition as the claim: only a real card asks, because `GARDEN_SESSION_ID` is what names
     * the card whose allowance is being counted, and a descendant session that merely inherited the
     * environment must not spend a card's allowance under its name any more than it may take a
     * file flag in it.
     */
    if (isDispatch(event) && process.env.GARDEN_SESSION_ID) {
      return askForDispatch(process.env.GARDEN_SESSION_ID, (reason) => {
        if (reason) denyWrite(reason)
        postEvent(event)
      })
    }
    const refusal = writeOutsideTerritory(event, target)
    if (refusal) {
      // Already refused for being outside this card's own paths, so who else is in the file is not
      // a question worth a round trip. The write is not happening either way.
      denyWrite(refusal)
      return postEvent(event)
    }
    /*
     * Only a real card asks for the flag. GARDEN_SESSION_ID is what names the holder, so without it
     * there is nobody to hold anything and no card to protect from.
     *
     * This sits below the isOwnSession check further up on purpose, and it could not sit above it.
     * A session that is not the card's own is a separate conversation that merely inherited the
     * card's environment, and letting it take flags in the card's name would be worse than the
     * collision it is meant to prevent: it would park a flag under an id whose real session never
     * touched the file, and the release when that card's process ends would not cover it. The same
     * reasoning that stops a descendant from being briefed or posted stops it from claiming.
     */
    const gardenSessionId = process.env.GARDEN_SESSION_ID
    if (target && gardenSessionId) {
      return askForClaim(gardenSessionId, target, (reason) => {
        if (reason) denyWrite(reason)
        postEvent(event)
      })
    }
  }

  // Every event still reaches the server exactly as it did before, and every event that is not a
  // write in a card gets there in one round trip, unchanged.
  postEvent(event)
})

function postEvent(event) {
  const body = JSON.stringify({
    /*
     * Set by Garden when it spawned the shell this CLI is running in, and inherited all the way
     * down. This is what ties a hook firing to a card on the board without matching on pids,
     * working directories or timing, none of which survive two sessions in one folder.
     */
    gardenSessionId: process.env.GARDEN_SESSION_ID || null,
    receivedAt: Date.now(),
    event,
  })

  const req = request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/hook',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    },
    (res) => {
      res.resume()
      res.on('end', done)
    },
  )
  req.setTimeout(TIMEOUT_MS, () => {
    req.destroy()
    done()
  })
  req.on('error', done)
  req.end(body)
}

// Last-resort guard: whatever happens above, this process is gone well inside a second and a half.
// A write in a card can now make two requests back to back, so this is the thing that holds the
// budget rather than the individual timeouts adding up to it. It writes whatever output was decided
// by then, so a denial that was already worked out is still spoken on the way out.
setTimeout(done, TIMEOUT_MS + 300).unref()
