/**
 * A skill added to a role reaches the cards already on the board, not only the ones hired next.
 *
 * The owner asked for a hiring procedure "for all orchestrators". Adding a name to `ROLE_SKILLS` on
 * its own does not do that: a card's skills are snapshotted once, `ensureCardRoots` used to copy
 * nothing on a later launch, and `refreshCardRoots` re-copies only what the manifest already names
 * and is called by nothing. Both live orchestrators would have missed it entirely.
 *
 * So this composes a card the way it stood BEFORE the new skill existed, launches it again, and
 * checks three things: the missing skill arrives, a copy the card tailored is not overwritten, and a
 * skill the card collected for itself is left alone and stays out of the manifest.
 *
 * Run it with tsx: the shared package is consumed as TypeScript source, which is how the server
 * itself loads it, so there is no built copy of it to import.
 *
 * Temp directories only, with GARDEN_HOME pointed at one of them. It never reads or writes the live
 * board, the real `~/.garden`, or any real card.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/*
 * The suite runs every test with plain node, and plain node cannot load the TypeScript this one
 * imports. So it re-runs itself once under tsx rather than being left out of the suite, which is
 * where a test stops being run and therefore stops being true.
 */
if (!process.env.GARDEN_TSX) {
  const self = fileURLToPath(import.meta.url)
  const r = spawnSync(process.execPath, ['--import', 'tsx', self], {
    stdio: 'inherit',
    env: { ...process.env, GARDEN_TSX: '1' },
  })
  process.exit(r.status ?? 1)
}

const sandbox = mkdtempSync(join(tmpdir(), 'garden-topup-'))
process.env.GARDEN_HOME = join(sandbox, 'home')
mkdirSync(process.env.GARDEN_HOME, { recursive: true })

const { ROLE_SKILLS } = await import('../packages/shared/src/index.ts')
const { composeCardRoots, ensureCardRoots } = await import('../server/src/roots.ts')

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const KEEPS = ROLE_SKILLS.orchestrator
const NEW = 'hiring-a-card'
check('the orchestrator keeps the hiring procedure', KEEPS.includes(NEW), KEEPS.join(', '))

// A library to copy from, standing in for ~/.claude/skills. Every name the role keeps, plus a body
// per skill so a copy can be told from a tailored one.
const hirerDir = join(sandbox, 'hirer')
for (const name of KEEPS) {
  const dir = join(hirerDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\nlibrary copy of ${name}\n`)
}

// The card as it stood before the new skill existed: everything the role keeps except that one.
const cardDir = join(sandbox, 'card', 'Orchestrator-deadbeef')
const card = { title: 'Orchestrator', roleClass: 'orchestrator' }
const before = KEEPS.filter((n) => n !== NEW)
composeCardRoots(cardDir, card, { skills: before }, { hirerDir }, '2026-01-01T00:00:00.000Z')
check('composed without it, as an older card would be', !existsSync(join(cardDir, 'skills', NEW)))

// Two things that must survive: a kept skill this card tailored, and one it collected itself.
const tailored = join(cardDir, 'skills', before[0], 'SKILL.md')
writeFileSync(tailored, `---\nname: ${before[0]}\n---\n\nTAILORED BY THE CARD\n`)
const ownDir = join(cardDir, 'skills', 'gamma')
mkdirSync(ownDir, { recursive: true })
writeFileSync(join(ownDir, 'SKILL.md'), '---\nname: gamma\n---\n\nthe card found this itself\n')

// Launch again, which is the only moment anything tops up.
ensureCardRoots(cardDir, card, { hirerDir }, '2026-09-11T00:00:00.000Z')

const manifest = JSON.parse(readFileSync(join(cardDir, '.claude-plugin', 'garden-roots.json'), 'utf8'))
check('the new skill arrived on disk', existsSync(join(cardDir, 'skills', NEW, 'SKILL.md')))
check('and the manifest names it', manifest.skills.includes(NEW), manifest.skills.join(', '))
check(
  'the tailored copy was not overwritten',
  readFileSync(tailored, 'utf8').includes('TAILORED BY THE CARD'),
  readFileSync(tailored, 'utf8').split('\n').pop() || '',
)
check('the skill the card collected itself is still there', existsSync(join(ownDir, 'SKILL.md')))
check(
  'and Garden does not claim it put that one there',
  !manifest.skills.includes('gamma'),
  manifest.skills.join(', '),
)
check('the refreshed stamp moved', manifest.refreshed === '2026-09-11T00:00:00.000Z', manifest.refreshed)

// Second launch changes nothing, so a card is not re-copied over on every start. Guarded rather than
// assumed: with the top-up edited out, this line threw and the remaining checks never ran, which is
// one stack trace where there should have been a row per claim.
const arrived = join(cardDir, 'skills', NEW, 'SKILL.md')
if (existsSync(arrived)) writeFileSync(arrived, readFileSync(arrived, 'utf8') + '\nedited after the top-up\n')
ensureCardRoots(cardDir, card, { hirerDir }, '2026-09-12T00:00:00.000Z')
check(
  'a second launch copies nothing again',
  existsSync(arrived) && readFileSync(arrived, 'utf8').includes('edited after the top-up'),
)

// The library the real board copies from has to hold it, or every card gets a "missing" instead.
const machine = join(homedir(), '.claude', 'skills')
check(
  'the machine library holds the skill itself',
  existsSync(join(machine, NEW, 'SKILL.md')),
  existsSync(machine) ? readdirSync(machine).join(', ') : 'no library',
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
