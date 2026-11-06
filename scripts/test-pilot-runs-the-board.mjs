/**
 * The orchestrator runs the board (canon 28), on a scratch board with its own server.
 *
 * A worker card is put at a permission prompt (a shell drawing one, marked blocked by the same hook a
 * CLI sends). Then: BOARD.md names the block and the options, the orchestrator is woken with it, the
 * orchestrator's answer lands on the worker's screen, answers the prompt does not offer are refused,
 * a card that is not at a prompt is refused, hold shows on BOARD.md, and a check-in arrives while
 * work is open.
 *
 *   npm run build && node scripts/test-pilot-runs-the-board.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.GARDEN_PILOT_CHECKIN_MS = '15000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const { openBoard } = await import('./lib/board.mjs')
const board = await openBoard({
  projectName: 'pilot',
  // The source, not the built copy, so this tests the code as it is now rather than the last build.
  entry: 'tsx',
  cards: [{ title: 'Orche', roleClass: 'orchestrator' }, { title: 'Unity worker', reportsTo: 0 }, 'Quiet card'],
  files: { 'TODO.md': '# To do\n\n- [ ] build the lighting pass @Unity worker\n' },
})
const [orche, worker, quiet] = board.cards
for (const c of [orche, worker, quiet]) board.ws.send(JSON.stringify({ t: 'session.start', sessionId: c.id }))
await sleep(6000)

// The worker draws a permission prompt and waits for a key, as a CLI does.
const promptScript =
  "Clear-Host; Write-Host 'Bash command'; Write-Host ''; Write-Host '  Unity.exe -projectPath C:\\scratch\\game'; " +
  "Write-Host '  Open the project in Unity'; Write-Host ''; Write-Host 'Do you want to proceed?'; " +
  "Write-Host '> 1. Yes'; Write-Host \"  2. Yes, and don't ask again for Unity.exe commands\"; " +
  "Write-Host '  3. No, and tell Claude what to do differently (esc)'; $k = [Console]::ReadKey($true); Write-Host \"PICKED:$($k.KeyChar)\"\r"
board.ws.send(JSON.stringify({ t: 'session.input', sessionId: worker.id, data: promptScript }))
await sleep(2500)
const hook = (event) =>
  fetch(`http://127.0.0.1:${board.port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gardenSessionId: worker.id, receivedAt: Date.now(), event }),
  }).then((r) => r.text())
await hook({ hook_event_name: 'SessionStart', session_id: 'pilot-w' })
await hook({ hook_event_name: 'PermissionRequest', session_id: 'pilot-w', tool_name: 'Bash', tool_input: { command: 'Unity.exe' } })

// Blocked for twenty seconds, then the next five-second sweep.
await sleep(28000)
const mail = join(board.home, 'mail', orche.id)
const boardFile = join(mail, 'BOARD.md')
const boardText = existsSync(boardFile) ? readFileSync(boardFile, 'utf8') : ''
check('BOARD.md is written for the orchestrator', boardText.includes('# The board'), boardFile)
check('it shows the worker blocked', /\*\*Unity worker\*\*.*blocked/.test(boardText))
check('with what it wants and the options', boardText.includes('Unity.exe -projectPath') && boardText.includes("2. Yes, and don't ask again"))
check('and what is left in TODO.md', boardText.includes('build the lighting pass'))
const inbox = existsSync(join(mail, 'INBOX.md')) ? readFileSync(join(mail, 'INBOX.md'), 'utf8') : ''
check('the orchestrator is woken about the block', inbox.includes('The board needs you') && inbox.includes('Unity worker is blocked'))

if (!inbox.includes('Unity worker is blocked') || !boardText.includes('Unity.exe -projectPath')) {
  console.log(['--- BOARD.md', boardText.slice(0, 1800), '--- INBOX.md', inbox.slice(0, 1500)].join('\n'))
}
const pilot = (...args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, ['server/bin/garden-pilot.mjs', ...args, '--project', board.project.id], {
      env: { ...process.env, GARDEN_HOME: board.home, GARDEN_PORT: String(board.port), GARDEN_SESSION_TOKEN: '' },
      encoding: 'utf8',
    }) }
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.message) }
  }
}
const bad = pilot('--answer', 'Unity worker', '7')
check('an option the prompt does not offer is refused', !bad.ok && bad.out.includes('offers 1. Yes'), bad.out.trim())
const notAt = pilot('--answer', 'Quiet card', '1')
check('a card not at a prompt is refused', !notAt.ok && notAt.out.includes('not at a prompt'), notAt.out.trim())
const good = pilot('--answer', 'Unity worker', '2')
check('the answer is accepted', good.ok && good.out.includes("2. Yes, and don't ask again"), good.out.trim().slice(0, 120))
await sleep(1500)
const shown = await new Promise((resolve) => {
  const onMsg = (raw) => {
    const m = JSON.parse(String(raw))
    if (m.t === 'session.scrollback' && m.sessionId === worker.id) {
      board.ws.off('message', onMsg)
      resolve(m.data ?? '')
    }
  }
  board.ws.on('message', onMsg)
  board.ws.send(JSON.stringify({ t: 'session.scrollback', sessionId: worker.id }))
  setTimeout(() => resolve(''), 4000)
})
check('and lands on the worker as that option', String(shown).includes('PICKED:2'))

pilot('--hold')
await sleep(6500)
check('hold shows on BOARD.md', readFileSync(boardFile, 'utf8').includes('The board is on hold'))
pilot('--go')

// A check-in while work is open (TODO.md has an item), with no new matter.
writeFileSync(join(mail, 'INBOX.md'), '')
await sleep(22000)
const later = existsSync(join(mail, 'INBOX.md')) ? readFileSync(join(mail, 'INBOX.md'), 'utf8') : ''
check('a check-in arrives while work is open', later.includes('Board check-in'))

await board.stop()
console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
