/**
 * How a card renders each save outcome, from the message alone.
 *
 * What this proves, and what it deliberately does not. It drives the card with an injected
 * `doc.saved` rather than the server's own, so it answers one question only: given a message of
 * exactly this shape, does the card draw the right thing. It is not the end-to-end proof and is not
 * a substitute for it. `test-doc-save-badge.mjs` is that proof, and it runs against the real server
 * answering for itself.
 *
 * It was written when the server sent nothing at all on a save, so these two states were unreachable
 * and injection was the only way to exercise them. The server answers properly now. The script kept
 * its value and lost its premise at the same moment: the card was already confirmed before the
 * injection ran, so the "still waiting" check failed and the injected refusal was overwriting a
 * completed save rather than resolving an outstanding one. So the real frame for the card under test
 * is now held back, and the injected one takes its place.
 *
 * The answer is injected in the browser by wrapping `window.WebSocket` before the app loads and
 * dispatching a real MessageEvent on the live socket. Nothing in the app is modified, nothing under
 * `server/` is touched, and no test-only branch exists in the shipped code. The message shape is the
 * real one: `{ t: 'doc.saved', cardId, mtime }` with NO error key on success, and the raw exception
 * string in `error` on failure.
 *
 * The failure case is run against a file that has genuinely been made read-only, so the injected
 * error describes something that actually happened rather than a fiction.
 *
 *   npm run build -w @garden/web
 *   node scripts/test-doc-save-answered.mjs
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failures++
}

const ORIGINAL = '# before\n\nOriginal text.\n'
const TYPED = 'A line the owner just typed.'
const REAL_ERROR = 'EPERM: operation not permitted, open'

const proj = mkdtempSync(join(tmpdir(), 'a2-answered-'))
for (const f of ['ok.md', 'refused.md']) writeFileSync(join(proj, f), ORIGINAL, 'utf8')

const inst = await startInstance()
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1900, height: 1200, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(e.stack || String(e)))

/*
 * The socket is wrapped before any of the app's own code runs, so the app's connection is the one
 * that gets hold of. Nothing is faked about the socket itself: it connects to the real sandbox
 * server and carries every real message. The only addition is a way to hand it one more frame.
 */
await page.evaluateOnNewDocument(() => {
  const Real = window.WebSocket
  const sockets = []
  function Wrapped(...args) {
    const ws = new Real(...args)
    /*
     * Hold back the server's real answer for one card, so the injected one is the only one it sees.
     *
     * When this was written the server sent nothing at all on a save, so every card sat in the
     * unanswered state for free and injecting an answer was the only way to reach the other two.
     * The server answers properly now, which is the fix this script was scaffolding for, and that
     * broke the premise: the card was already confirmed before the injection ran, so the "waiting"
     * check failed and the injected refusal was overwriting a completed save rather than resolving
     * an outstanding one.
     *
     * What this still proves is worth keeping and is covered nowhere else: the card renders each
     * state correctly from the message alone, with no dependence on server timing. The end-to-end
     * path, where the real server's own answer drives the card, is proven by test-doc-save-badge.
     */
    ws.addEventListener(
      'message',
      (event) => {
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
      },
      true,
    )
    sockets.push(ws)
    return ws
  }
  Wrapped.prototype = Real.prototype
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapped[k] = Real[k]
  window.WebSocket = Wrapped
  window.__dropSavedFor = null
  window.__serverSays = (obj) => {
    const ws = sockets[sockets.length - 1]
    if (!ws) throw new Error('the app never opened a socket')
    /*
     * Lift the gate before dispatching, or this frame is swallowed by the same filter that is
     * holding back the server's. The gate exists to keep the card outstanding until this call, and
     * this call is the moment it stops being outstanding, so the two are the same event.
     */
    window.__dropSavedFor = null
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) }))
  }
})

async function seed() {
  const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/ws`)
  const st = { projects: [], docs: [] }
  ws.on('message', (r) => {
    const m = JSON.parse(String(r))
    if (m.t === 'state') { st.projects = m.projects; st.docs = m.docs }
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
  for (const f of ['ok.md', 'refused.md']) {
    ws.send(JSON.stringify({ t: 'doc.open', projectId: project.id, relPath: f }))
    await sleep(700)
  }
  ws.close()
  return Object.fromEntries(st.docs.map((d) => [d.relPath, d.id]))
}

const readCard = (file) =>
  page.evaluate((f) => {
    const card = [...document.querySelectorAll('.node--doc')].find((n) =>
      (n.querySelector('.doc-path')?.textContent || '').includes(f),
    )
    if (!card) return null
    const head = card.querySelector('.node-head')
    const badge = [...head.querySelectorAll('span')].find((s) => /doc-(saved|dirty|unknown|failed)$/.test(s.className))
    return {
      badgeClass: badge ? badge.className : null,
      badgeText: badge ? badge.textContent.trim() : null,
      badgeTitle: badge ? badge.getAttribute('title') : null,
      editorOpen: !!card.querySelector('.doc-edit'),
      editorText: card.querySelector('.doc-edit')?.value || '',
      bodyText: card.querySelector('.doc-body')?.textContent || '',
      buttons: [...head.querySelectorAll('button')].map((b) => b.textContent.trim()),
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
  const ids = await seed()
  await page.goto(`http://127.0.0.1:${inst.port}/`, { waitUntil: 'networkidle2' })
  await sleep(2200)

  /*
   * ONE: the server confirms the write.
   *
   * Pre-fix failure this would have caught: the success badge could not render at all, and the word
   * it would have rendered was "saving", a progress word for a finished action, driven by a boolean
   * set the instant the button was clicked rather than by anything the server said.
   */
  await typeInto('ok.md')
  // Swallow the real answer for this card, so the injected one is the only one it sees.
  await page.evaluate((id) => { window.__dropSavedFor = id }, ids['ok.md'])
  await clickIn('ok.md', 'Save')
  await sleep(500)
  const beforeAnswer = await readCard('ok.md')
  check(
    'before the answer the card says only that it is waiting',
    beforeAnswer.badgeClass === 'doc-unknown',
    JSON.stringify([beforeAnswer.badgeClass, beforeAnswer.badgeText]),
  )

  const realMtime = statSync(join(proj, 'ok.md')).mtimeMs
  await page.evaluate((cardId, mtime) => window.__serverSays({ t: 'doc.saved', cardId, mtime }), ids['ok.md'], realMtime)
  await sleep(600)
  const confirmed = await readCard('ok.md')
  check(
    'a confirmed write says saved, in the past tense, and says when',
    /^saved \d{1,2}:\d{2}( ?[AaPp]\.?[Mm]\.?)?$/.test(confirmed.badgeText || ''),
    JSON.stringify(confirmed.badgeText),
  )
  check('and it is drawn as a success', confirmed.badgeClass === 'doc-saved', JSON.stringify(confirmed.badgeClass))
  check('a confirmed write closes the editor', confirmed.editorOpen === false)
  check(
    'the card takes up the bytes the server said it wrote',
    confirmed.bodyText.includes(TYPED),
    JSON.stringify(confirmed.bodyText.slice(0, 70)),
  )
  check(
    'the bytes the card is showing are the bytes on disk',
    readFileSync(join(proj, 'ok.md'), 'utf8').includes(TYPED),
  )

  /*
   * The confirmation stays up, and the stamp is what earns it the right to.
   *
   * An earlier version of this took the badge down after six seconds, on the argument that a bare
   * "saved" left up becomes a claim about the file's present state. The stamp answers that without
   * going silent: it records one confirmed write at one time, which stays true, and a blind reviewer
   * had already found that a card which goes neutral after the click cannot be told from a card
   * nobody ever clicked.
   */
  await sleep(6500)
  const later = await readCard('ok.md')
  check(
    'the confirmation is still readable later, and still carries its time',
    later.badgeClass === 'doc-saved' && later.badgeText === confirmed.badgeText,
    JSON.stringify([later.badgeClass, later.badgeText]),
  )
  check(
    'and a reader can tell that card from one nobody ever clicked',
    later.badgeText !== null && later.badgeText !== '',
    'a card with no badge at all is indistinguishable from an untouched one',
  )

  /*
   * TWO: the server refuses the write.
   *
   * The file is genuinely read-only first, so the error being injected describes something that
   * really happened.
   *
   * Pre-fix failure this would have caught: the per-card "not saved" branch was unreachable, so a
   * refused write showed nothing on the card at all, and the card went on rendering the text the
   * disk had just rejected.
   */
  const refusedPath = join(proj, 'refused.md')
  await typeInto('refused.md')
  execFileSync('attrib', ['+R', refusedPath])
  await page.evaluate((id) => { window.__dropSavedFor = id }, ids['refused.md'])
  await clickIn('refused.md', 'Save')
  await sleep(700)
  const refusalHeld = readFileSync(refusedPath, 'utf8') === ORIGINAL
  check('the file on disk really did refuse the write', refusalHeld, refusalHeld ? '' : 'the read-only attribute did not hold')

  const errText = `${REAL_ERROR} '${refusedPath}'`
  await page.evaluate(
    (cardId, mtime, error) => window.__serverSays({ t: 'doc.saved', cardId, mtime, error }),
    ids['refused.md'],
    statSync(refusedPath).mtimeMs,
    errText,
  )
  await sleep(600)
  const refused = await readCard('refused.md')
  check('a refused write is named as a refusal', refused.badgeText === 'not saved', JSON.stringify(refused.badgeText))
  check('and it is not drawn as ordinary unsaved work', refused.badgeClass === 'doc-failed', JSON.stringify(refused.badgeClass))
  check(
    'the reason travels with the badge rather than being left to a banner',
    (refused.badgeTitle || '').includes(errText),
    JSON.stringify(refused.badgeTitle),
  )
  check(
    'and the badge tells the owner where his text went, not only what the OS said',
    /press Edit/i.test(refused.badgeTitle || ''),
    JSON.stringify(refused.badgeTitle),
  )
  check('a refused write leaves the editor open', refused.editorOpen === true)
  check('with the rejected text still in it', refused.editorText.includes(TYPED))

  // Leaving the editor must not leave the card showing text the file does not contain.
  await page.keyboard.press('Escape')
  await sleep(500)
  const afterEscape = await readCard('refused.md')
  check(
    'a card never renders text the disk refused',
    !afterEscape.bodyText.includes(TYPED),
    afterEscape.bodyText.includes(TYPED) ? 'the card is showing a line that is not in the file' : '',
  )
  check('and it still says the write did not land', afterEscape.badgeText === 'not saved', JSON.stringify(afterEscape.badgeText))

  // Re-opening the editor must hand the rejected work back rather than throwing it away.
  await clickIn('refused.md', 'Edit')
  await sleep(600)
  const reopened = await readCard('refused.md')
  check(
    'reopening the editor offers the rejected text back',
    reopened.editorText.includes(TYPED),
    JSON.stringify(reopened.editorText.slice(0, 70)),
  )

  execFileSync('attrib', ['-R', refusedPath])
  check('no console errors while all of this happened', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
  await inst.stop()
  try { execFileSync('attrib', ['-R', join(proj, 'refused.md')]) } catch {}
  rmSync(proj, { recursive: true, force: true })
}

console.log(
  `\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}` +
    '\nNote: the doc.saved answers above were injected in the browser, because the server does not' +
    '\nsend them yet. This checks the card against the agreed message shape, not the app end to end.',
)
process.exit(failures === 0 ? 0 : 1)
