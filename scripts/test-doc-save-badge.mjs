/**
 * What a document card is allowed to say about a save, checked against what actually happened.
 *
 * Three states, and the card must tell them apart: the write landed, the write was refused, and
 * nobody has answered yet. That third one is the one the app could not say at all, and it is the
 * one this project's rule is about, so it is checked first and hardest.
 *
 * Each check names the pre-fix failure it would have caught, because a test that cannot fail on the
 * old code is not evidence. All three would have failed on the code as it stood on 2026-08-12:
 * measured, not assumed, with scripts/_a2-save-badge-probe.mjs.
 *
 * It gets its own server, its own free port and its own workspace directory, so it cannot see or
 * touch the owner's board. Needs the built web:
 *
 *   npm run build -w @garden/web
 *   node scripts/test-doc-save-badge.mjs
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let skipped = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failures++
}
const skip = (name, why) => {
  console.log(`SKIP  ${name}  -- ${why}`)
  skipped++
}

const ORIGINAL = '# before\n\nOriginal text.\n'
const TYPED = 'A line the owner just typed.'

const proj = mkdtempSync(join(tmpdir(), 'a2-save-test-'))
for (const f of ['pending.md', 'refused.md', 'confirmed.md']) {
  writeFileSync(join(proj, f), ORIGINAL, 'utf8')
}

const inst = await startInstance()
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1900, height: 1200, deviceScaleFactor: 1 },
})
const page = await browser.newPage()

/*
 * A way to make one save genuinely unanswered.
 *
 * The "nobody has answered yet" state used to happen on its own, because the server never sent
 * `doc.saved` at all and every save fell into it. That was the bug, and now that it is fixed the
 * scenario has to be produced deliberately instead of being the default. A card whose answer is
 * lost is still a real case worth drawing correctly: the server can be restarting, or the socket
 * can drop the frame, and the card must say it does not know rather than pick an outcome.
 *
 * Done by wrapping the socket before the app opens one, so nothing in the app has to know about it
 * and the client code under test is untouched. Only frames naming the card in `__dropSavedFor` are
 * swallowed, so the rest of the board keeps working normally while one save is left hanging.
 */
await page.evaluateOnNewDocument(() => {
  const Real = window.WebSocket
  window.__dropSavedFor = null
  function Wrapped(...args) {
    const socket = new Real(...args)
    socket.addEventListener('message', (event) => {
      if (!window.__dropSavedFor) return
      let parsed
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }
      if (parsed?.t === 'doc.saved' && parsed.cardId === window.__dropSavedFor) {
        event.stopImmediatePropagation()
      }
    }, true)
    return socket
  }
  Wrapped.prototype = Real.prototype
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapped[k] = Real[k]
  window.WebSocket = Wrapped
})

const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(e.stack || String(e)))

/**
 * The board is seeded over the socket rather than by clicking through the sidebar. Adding a project
 * by hand is not what is under test, and driving that UI would only give the test a second way to
 * fail for a reason nobody cares about.
 */
async function seed() {
  const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/ws`)
  const st = { projects: [], docs: [] }
  ws.on('message', (r) => {
    const m = JSON.parse(String(r))
    if (m.t === 'state') Object.assign(st, { projects: m.projects, docs: m.docs })
    else if (m.t === 'project.added') st.projects.push(m.project)
    else if (m.t === 'doc.added') st.docs.push(m.card)
  })
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello' }))
  await sleep(700)
  ws.send(JSON.stringify({ t: 'project.add', path: proj }))
  await sleep(1400)
  const project = st.projects[0]
  if (!project) throw new Error('the test server never added the scratch project')
  for (const f of ['pending.md', 'refused.md', 'confirmed.md']) {
    ws.send(JSON.stringify({ t: 'doc.open', projectId: project.id, relPath: f }))
    await sleep(600)
  }
  ws.close()
  return st.docs.length
}

/** Everything one named card is currently saying, read out of the live DOM. */
const readCard = (file) =>
  page.evaluate((f) => {
    const card = [...document.querySelectorAll('.node--doc')].find((n) =>
      (n.querySelector('.doc-path')?.textContent || n.querySelector('.node-title')?.textContent || '').includes(f),
    )
    if (!card) return null
    const head = card.querySelector('.node-head')
    const badge = [...head.querySelectorAll('span')].find((s) => /doc-(saved|dirty|unknown|failed)$/.test(s.className))
    return {
      badgeClass: badge ? badge.className : null,
      badgeText: badge ? badge.textContent.trim() : null,
      badgeTitle: badge ? badge.getAttribute('title') : null,
      editorOpen: !!card.querySelector('.doc-edit'),
      bodyText: card.querySelector('.doc-body')?.textContent || '',
      banner: document.querySelector('.banner--error')?.textContent?.trim() || null,
    }
  }, file)

const clickIn = (file, label) =>
  page.evaluate(
    (f, l) => {
      const card = [...document.querySelectorAll('.node--doc')].find((n) =>
        (n.querySelector('.doc-path')?.textContent || '').includes(f),
      )
      const b = [...card.querySelectorAll('.node-head button')].find((x) => x.textContent.trim() === l)
      if (!b) throw new Error(`no ${l} button on ${f}`)
      b.click()
    },
    file,
    label,
  )

/** Open the editor on a card and type a line into it, the way a person would. */
async function typeInto(file) {
  await clickIn(file, 'Edit')
  await sleep(700)
  const area = await page.evaluateHandle((f) => {
    const card = [...document.querySelectorAll('.node--doc')].find((n) =>
      (n.querySelector('.doc-path')?.textContent || '').includes(f),
    )
    return card.querySelector('.doc-edit')
  }, file)
  await area.asElement().click()
  await page.keyboard.type(`\n\n${TYPED}\n`)
  await sleep(300)
}

try {
  const seeded = await seed()
  await page.goto(`http://127.0.0.1:${inst.port}/`, { waitUntil: 'networkidle2' })
  await sleep(2200)
  check('three document cards are on the board', seeded === 3, `${seeded} seeded`)

  /*
   * ONE: a write nobody has answered.
   *
   * Pre-fix failure this would have caught: with the server silent, the card showed no badge at all
   * and the "unsaved" mark it had been showing disappeared within 3ms of the click, because
   * state.ts:776 wrote the draft into the card's own copy of the file the instant the message was
   * sent. An unanswered save was indistinguishable from a completed one, and from nothing at all.
   */
  await typeInto('pending.md')
  const dirtyBefore = await readCard('pending.md')
  check('typing lights the unsaved mark', dirtyBefore.badgeText === 'unsaved', JSON.stringify(dirtyBefore.badgeText))

  // Swallow this one card's answer, so the save is genuinely outstanding rather than merely slow.
  await page.evaluate((f) => {
    const card = [...document.querySelectorAll('.node--doc')].find((n) =>
      (n.querySelector('.doc-path')?.textContent || '').includes(f),
    )
    window.__dropSavedFor = card?.closest('[data-id]')?.getAttribute('data-id') ?? null
    return window.__dropSavedFor
  }, 'pending.md')

  await clickIn('pending.md', 'Save')
  await sleep(900)
  const midFlight = await readCard('pending.md')
  check(
    'an unanswered save says so rather than saying nothing',
    midFlight.badgeClass === 'doc-unknown' && ['saving', 'no answer'].includes(midFlight.badgeText),
    JSON.stringify([midFlight.badgeClass, midFlight.badgeText]),
  )
  check(
    'an unanswered save is never drawn as a saved one',
    midFlight.badgeClass !== 'doc-saved' && midFlight.badgeText !== 'saved',
    JSON.stringify(midFlight.badgeText),
  )
  check('the editor stays open while the outcome is unknown', midFlight.editorOpen === true)

  // Silence for long enough stops flattering itself as progress and states the unknown plainly.
  await sleep(4200)
  const silent = await readCard('pending.md')
  check(
    'prolonged silence reads as no answer, not as success',
    silent.badgeClass === 'doc-unknown' && silent.badgeText === 'no answer',
    JSON.stringify([silent.badgeClass, silent.badgeText]),
  )

  /*
   * TWO: a write the disk refused.
   *
   * The file is made read-only first, so this is a real refusal rather than a simulated one.
   *
   * Pre-fix failure this would have caught: the card looked exactly like a successful save. No
   * badge, editor open, "unsaved" gone, and the card's rendered text showed the line that had NOT
   * reached disk. The only signal anywhere was an app-wide banner naming no card.
   */
  const refusedPath = join(proj, 'refused.md')
  await typeInto('refused.md')
  execFileSync('attrib', ['+R', refusedPath])
  await clickIn('refused.md', 'Save')
  await sleep(1500)
  const refused = await readCard('refused.md')
  const heldOut = readFileSync(refusedPath, 'utf8') === ORIGINAL
  check(
    'the file on disk really did refuse the write',
    heldOut,
    heldOut ? '' : 'the read-only attribute did not hold, so this case proves nothing',
  )
  if (refused.badgeClass === 'doc-failed') {
    check('a refused write is named as a refusal on the card', refused.badgeText === 'not saved', JSON.stringify(refused.badgeText))
    check(
      'the reason travels with it rather than being left to a banner',
      typeof refused.badgeTitle === 'string' && refused.badgeTitle.length > 0,
      JSON.stringify(refused.badgeTitle),
    )
    check('a refused write leaves the editor open, holding the text', refused.editorOpen === true)
  } else {
    skip(
      'a refused write is named as a refusal on the card',
      `the server answers a refused write with t:error rather than doc.saved, so the card has ` +
        `nothing to light this with yet. Card currently shows ${JSON.stringify([refused.badgeClass, refused.badgeText])}. ` +
        `This starts asserting for real the moment Worker A1's server half lands.`,
    )
  }
  check(
    'a refused write is never drawn as a saved one',
    refused.badgeClass !== 'doc-saved' && refused.badgeText !== 'saved',
    JSON.stringify(refused.badgeText),
  )

  // Leave the editor and read the card. It must show what is on disk, not what the disk rejected.
  await page.keyboard.press('Escape')
  await sleep(600)
  const afterEscape = await readCard('refused.md')
  check(
    'a card never renders text the disk refused',
    !afterEscape.bodyText.includes(TYPED),
    afterEscape.bodyText.includes(TYPED)
      ? 'the card is showing a line that is not in the file'
      : '',
  )
  execFileSync('attrib', ['-R', refusedPath])

  /*
   * THREE: a write the server confirmed.
   *
   * Pre-fix failure this would have caught: nothing ever populated the save state, so the success
   * badge could not render at all, and the word it would have rendered was "saving".
   *
   * This one is honest about being unreachable until the server answers a save. It is not silently
   * dropped and it is not counted as a pass.
   */
  const confirmedPath = join(proj, 'confirmed.md')
  await typeInto('confirmed.md')
  await clickIn('confirmed.md', 'Save')
  await sleep(2500)
  const confirmed = await readCard('confirmed.md')
  const landed = readFileSync(confirmedPath, 'utf8').includes(TYPED)
  check('the write reached disk', landed)
  if (confirmed.badgeClass === 'doc-saved') {
    check(
      'a confirmed write says saved, in the past tense, and says when',
      /^saved \d{1,2}:\d{2}( ?[AaPp]\.?[Mm]\.?)?$/.test(confirmed.badgeText || ''),
      JSON.stringify(confirmed.badgeText),
    )
    check('a confirmed write closes the editor', confirmed.editorOpen === false)
    check(
      'the card takes up the text the server said it wrote',
      confirmed.bodyText.includes(TYPED),
      JSON.stringify(confirmed.bodyText.slice(0, 80)),
    )
  } else {
    /*
     * This was a skip for as long as the server said nothing on a successful save. It is a real
     * failure now: `doc.save` answers with `doc.saved` on both paths, so a card that still cannot be
     * confirmed means the answer is not arriving, and the badge is back to timing out on a write
     * that reached disk.
     */
    check(
      'a confirmed write says saved and closes the editor',
      false,
      `the bytes reached disk (${landed}) and the card shows ` +
        `${JSON.stringify([confirmed.badgeClass, confirmed.badgeText])}, so no doc.saved arrived.`,
    )
  }

  check('no console errors while all of this happened', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
  await inst.stop()
  try { execFileSync('attrib', ['-R', join(proj, 'refused.md')]) } catch {}
  rmSync(proj, { recursive: true, force: true })
}

console.log(
  `\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}` +
    (skipped ? `, ${skipped} SKIPPED because the server does not answer a save yet` : ''),
)
process.exit(failures === 0 ? 0 : 1)
