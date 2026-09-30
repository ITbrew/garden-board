/**
 * The choice made at first launch decides the permission mode cards open in. Canon 01 revision 3.
 *
 * The owner: "fewer approval prompts and runs as admin". `setup.json` with `approvals: "never-ask"`
 * must put cards in bypass mode, with the "accept responsibility" screen skipped because no one is at
 * a card's keyboard to accept it; anything else, including no setup.json, keeps auto mode as before.
 * Read from the settings file the server writes at start, which is built by the same function as each
 * card's own. Its own Garden on its own port and workspace, serving the BUILT app: run
 * `npm run build` first.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

async function settingsFor(setup) {
  const home = mkdtempSync(join(tmpdir(), 'garden-setup-choice-'))
  if (setup) writeFileSync(join(home, 'setup.json'), JSON.stringify(setup), 'utf8')
  const garden = await startInstance({ home })
  try {
    return JSON.parse(readFileSync(join(home, 'hooks', 'settings.json'), 'utf8'))
  } finally {
    await garden.stop()
  }
}

const never = await settingsFor({ elevated: true, approvals: 'never-ask' })
check('"never-ask" opens cards in bypass mode', never.permissions?.defaultMode === 'bypassPermissions', never.permissions?.defaultMode)
check('and skips the accept-responsibility screen nobody could answer', never.skipDangerousModePermissionPrompt === true)
check('the mail shim is still allowed by name', (never.permissions?.allow ?? []).some((a) => a.includes('garden-send')))

const auto = await settingsFor({ elevated: false, approvals: 'auto' })
check('"auto" keeps auto mode', auto.permissions?.defaultMode === 'auto', auto.permissions?.defaultMode)
check('and does not skip the screen', auto.skipDangerousModePermissionPrompt === undefined)

const none = await settingsFor(null)
check('with no choice made yet, auto mode as before', none.permissions?.defaultMode === 'auto', none.permissions?.defaultMode)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
