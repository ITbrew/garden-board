/**
 * Which cards are actually sitting on top of each other, read from the board itself.
 *
 * Opened read-only against whatever database is live, because the question "do cards overlap" has
 * an exact answer in stored coordinates and no answer at all in a screenshot of one corner of the
 * canvas. Reports every pair closer than the padding a card is supposed to keep, and says which
 * kind of card each one is, since the owner's complaint is specifically that the roots and history
 * cards land on the sessions they belong to.
 */
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PAD = 26
const db = new Database(process.env.GARDEN_DB || join(process.env.GARDEN_HOME || join(homedir(), '.garden'), 'garden.db'), {
  readonly: true,
})

const projects = db.prepare('SELECT id, name FROM projects').all()
let total = 0

for (const project of projects) {
  const cards = [
    ...db
      .prepare('SELECT id, title AS name, x, y, width, height, collapsed FROM sessions WHERE projectId = ?')
      .all(project.id)
      .map((r) => ({ ...r, kind: 'session' })),
    ...db
      .prepare('SELECT id, title AS name, x, y, width, height, collapsed, web FROM docs WHERE projectId = ?')
      .all(project.id)
      .map((r) => ({ ...r, kind: r.web === 'history' ? 'history' : r.web === 'context' ? 'roots' : 'doc' })),
  ].map((c) => ({ ...c, h: c.collapsed ? 38 : c.height }))

  const bad = []
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i]
      const b = cards[j]
      const gapX = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width))
      const gapY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h))
      const gap = Math.max(gapX, gapY)
      if (gap < PAD) bad.push({ a, b, gap: Math.round(gap) })
    }
  }

  console.log(`\n${project.name}  (${cards.length} cards)`)
  if (bad.length === 0) {
    console.log('  every pair keeps its distance')
    continue
  }
  total += bad.length
  for (const { a, b, gap } of bad.sort((p, q) => p.gap - q.gap)) {
    const how = gap < 0 ? `overlapping by ${-gap}px` : `only ${gap}px apart`
    console.log(`  ${how}: [${a.kind}] ${a.name}  <->  [${b.kind}] ${b.name}`)
  }
}

console.log(`\n${total} pair${total === 1 ? '' : 's'} too close across ${projects.length} project(s).`)
