import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { composeCardRoots } from './roots.js'

/*
 * An orchestrator on any project gets the skills its role names, on a machine with none of them in
 * the home folder and a project with none of its own. Canon 28.
 */
test('a new orchestrator on another project receives the skills Garden ships', () => {
  const home = mkdtempSync(join(tmpdir(), 'garden-skills-home-'))
  const project = mkdtempSync(join(tmpdir(), 'garden-skills-project-'))
  const cardDir = mkdtempSync(join(tmpdir(), 'garden-skills-card-'))
  const was = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.USERPROFILE = home
  process.env.HOME = home
  try {
    assert.equal(homedir(), home)
    const got = composeCardRoots(cardDir, { title: 'Orchestrator', roleClass: 'orchestrator' }, {}, { projectPath: project }, 'now')
    assert.ok(got.skills.includes('running-a-tab'), `got ${got.skills.join(', ')}; missing ${got.missing.join(', ')}`)
    assert.ok(got.skills.includes('goal-ring'))
    assert.ok(existsSync(join(cardDir, 'skills', 'running-a-tab', 'SKILL.md')))
  } finally {
    process.env.USERPROFILE = was.USERPROFILE
    process.env.HOME = was.HOME
    for (const d of [home, project, cardDir]) rmSync(d, { recursive: true, force: true })
  }
})
