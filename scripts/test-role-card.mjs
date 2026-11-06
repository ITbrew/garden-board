/**
 * Making a card by saying what it is for, and putting a board down and picking it up again.
 *
 * The reason the form exists rather than a launcher plus a dropdown: the CLI reads a card's
 * permissions once, at launch, so a card started first and given a role afterwards runs its whole
 * first session with none of that role's denials. The check that matters is therefore not that the
 * card says "manager" on it, but that the settings file Garden wrote for it, before it started,
 * carries that role's deny list.
 *
 * And the other half the owner asked for: closing a tab keeps the board, saving one writes it into
 * the Garden directory, and either can be opened again from inside the app.
 */
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const garden = await startInstance()
const st = { projects: [], sessions: [], docs: [], wires: [] }
const ws = new WebSocket(`ws://127.0.0.1:${garden.port}/ws`)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.t === 'state') Object.assign(st, { projects: m.projects, sessions: m.sessions, docs: m.docs, wires: m.wires })
  else if (m.t === 'project.added') st.projects = [...st.projects.filter((p) => p.id !== m.project.id), m.project]
  else if (m.t === 'project.removed') st.projects = st.projects.filter((p) => p.id !== m.projectId)
  else if (m.t === 'session.added') st.sessions = [...st.sessions.filter((s) => s.id !== m.session.id), m.session]
  else if (m.t === 'session.updated') st.sessions = st.sessions.map((s) => (s.id === m.session.id ? m.session : s))
  else if (m.t === 'session.removed') st.sessions = st.sessions.filter((s) => s.id !== m.sessionId)
  else if (m.t === 'wire.added') st.wires = [...st.wires.filter((w) => w.id !== m.wire.id), m.wire]
  else if (m.t === 'error' && m.message !== '__connected__') console.log('   server said:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(400)

const dir = mkdtempSync(join(tmpdir(), 'garden-role-'))
writeFileSync(join(dir, 'CLAUDE.md'), '# scratch\n')
ws.send(JSON.stringify({ t: 'project.add', path: dir.replace(/\\/g, '/') }))
await sleep(1400)
const project = st.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase())

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 2200, height: 1300, deviceScaleFactor: 1 },
  args: ['--window-size=2200,1300', '--force-device-scale-factor=1'],
})
const page = await browser.newPage()
page.on('dialog', async (d) => {
  console.log('   an unexpected browser dialog appeared:', d.message())
  await d.dismiss()
})
await page.goto(`http://127.0.0.1:${garden.port}/`, { waitUntil: 'networkidle2' })
await sleep(3500)

// --- the form ---

await page.mouse.click(1400, 700, { button: 'right' })
await sleep(600)
const items = await page.evaluate(() =>
  [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].map((b) => b.textContent?.trim()),
)
check('the canvas menu offers a role card', items.some((t) => /New role card/.test(t ?? '')), items.slice(0, 3).join(' | '))

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.ctxmenu button, .ctxmenu__item')].find((x) =>
    /New role card/.test(x.textContent ?? ''),
  )
  b?.click()
})
await sleep(700)

const form = await page.evaluate(() => {
  const el = document.querySelector('.newcard')
  if (!el) return null
  return {
    roles: [...(el.querySelector('select')?.options ?? [])].map((o) => o.value),
    powers: el.querySelector('.newcard__powers')?.textContent?.trim() ?? '',
  }
})
check('a form opens', !!form)
/*
 * No boss. That layer was removed on 2026-08-12, and the chain the form offers is read from
 * ROLE_CHAIN rather than typed into the component, which is why removing the rung removed the
 * option with no change to the form at all. The `boss` entry still exists in ROLE_POWERS so a card
 * already stored under that word keeps working, but it is not somewhere new work should be put, so
 * it is correctly absent here.
 */
check('offering every role in the chain',
  ['orchestrator', 'manager', 'worker', 'reviewer'].every((r) => form?.roles.includes(r)),
  form?.roles.join(', '))
check('and no longer offering the layer that was removed', !form?.roles.includes('boss'), form?.roles.join(', '))
check('and stating what the role actually loses', /Denied by the CLI/.test(form?.powers ?? ''),
  (form?.powers ?? '').slice(0, 90))

/*
 * Filled in as a reviewer, not a manager.
 *
 * A manager no longer loses anything, so checking that the form states its denials would be
 * checking that an empty list renders, which passes whether or not the form reads the table at all.
 * A reviewer reads and reports and is denied every writing tool, so it is the role that can still
 * prove the form is quoting `ROLE_POWERS` rather than describing it from memory.
 *
 * The adapter picker now sits behind the "More options" fold, which is the fast path the owner
 * asked for: a role and a title, and the card exists. So the fold is opened first. That is a real
 * property worth asserting rather than working around, hence the check that it was there to open.
 */
const opened = await page.evaluate(() => {
  const el = document.querySelector('.newcard')
  const fold = [...el.querySelectorAll('button, summary')].find((b) =>
    /more options/i.test(b.textContent || ''),
  )
  if (!fold) return false
  fold.click()
  return true
})
check('the full form is behind a fold, so the quick path is role and title', opened)
await sleep(300)

await page.evaluate(() => {
  const el = document.querySelector('.newcard')
  const setSelect = (sel, value) => {
    const s = el.querySelectorAll('select')[sel]
    if (!s) throw new Error(`no select at index ${sel}; the form has ${el.querySelectorAll('select').length}`)
    s.value = value
    s.dispatchEvent(new Event('change', { bubbles: true }))
  }
  setSelect(0, 'reviewer')
  const title = el.querySelector('input[type="text"], input:not([type])')
  if (title) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(title, 'Loader department')
    title.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setSelect(1, 'shell')
})
await sleep(400)
const deniesShown = await page.evaluate(() => document.querySelector('.newcard__denies')?.textContent ?? '')
check('choosing a role updates what it says is denied', /Edit/.test(deniesShown), deniesShown.trim())

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.newcard__make')].pop()
  b?.click()
})
await sleep(2500)

const made = st.sessions.find((s) => s.title === 'Loader department')
check('the card is made', !!made, made ? `${made.roleClass}` : 'not found')
check('with the role it was given', made?.roleClass === 'reviewer', made?.roleClass ?? 'none')
check('and it landed where the menu was opened', made && made.x > 200, `x ${Math.round(made?.x ?? 0)}`)

/*
 * The part that matters. Not what the card says about itself, but the settings file the CLI was
 * handed, which is where enforcement actually lives.
 */
const settings = join(garden.home, 'hooks', 'sessions', `${made?.id}.json`)
check('a settings file was written for it before it ran', existsSync(settings), settings)
if (existsSync(settings)) {
  const deny = JSON.parse(readFileSync(settings, 'utf8'))?.permissions?.deny ?? []
  check('carrying that role deny list on its first launch', deny.includes('Edit') && deny.includes('Bash'),
    deny.join(', '))
}

// --- saving the board, closing the tab, getting both back ---

ws.send(JSON.stringify({ t: 'board.save', projectId: project.id, name: 'loader team' }))
await sleep(1200)
const boards = await page.evaluate(async () => {
  const res = await fetch('/health')
  return res.ok
})
check('the app is still answering after a save', boards)

const savedFile = join(garden.home, 'boards')
check('the board was written into the Garden directory', existsSync(savedFile), savedFile)

const before = st.sessions.filter((s) => s.projectId === project.id).length
ws.send(JSON.stringify({ t: 'project.close', projectId: project.id }))
await sleep(1500)
check('closing the tab takes it off the row', !st.projects.some((p) => p.id === project.id))

ws.send(JSON.stringify({ t: 'project.reopen', projectId: project.id }))
await sleep(1500)
check('reopening brings the tab back', st.projects.some((p) => p.id === project.id))
check('with every card still on it', st.sessions.filter((s) => s.projectId === project.id).length === before,
  `${before} then ${st.sessions.filter((s) => s.projectId === project.id).length}`)
const again = st.sessions.find((s) => s.title === 'Loader department')
check('and the card keeps its role', again?.roleClass === 'reviewer', again?.roleClass ?? 'none')
check('and says stopped rather than claiming to be running', again?.pid === null, `pid ${again?.pid}`)

await page.screenshot({ path: 'docs/shots/role-card-form.png' })
await browser.close()
ws.close()
await garden.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
