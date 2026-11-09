import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { listMarkdown } from './docs.js'

test('the project file list is read off the thread and skips dependency folders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'garden-docs-'))
  try {
    mkdirSync(join(root, 'docs', 'deep'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(root, 'CLAUDE.md'), 'a')
    writeFileSync(join(root, 'docs', 'deep', 'b.md'), 'b')
    writeFileSync(join(root, 'node_modules', 'x', 'c.md'), 'c')
    writeFileSync(join(root, 'photo.raw'), 'd')
    const pending = listMarkdown(root)
    assert.ok(pending instanceof Promise, 'returns before the walk finishes')
    assert.deepEqual(await pending, ['CLAUDE.md', 'docs/deep/b.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
