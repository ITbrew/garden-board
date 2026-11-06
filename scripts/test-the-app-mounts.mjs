/**
 * The app draws something.
 *
 * The cheapest possible assertion, and it exists because the failure it names got all the way to the
 * owner's screen. A render-time ReferenceError in one settings row threw during mount, React tore
 * the whole tree down, and what he got was an empty window. Every other signal said the app was
 * fine: both ports answered, the HTML came back 200, the server log was empty, and pressing F5 drew
 * the board for about a quarter of a second before it went blank again.
 *
 * Nothing in the suite said "the app did not mount". The browser tests would have failed, but they
 * would have failed as "could not find the card element", which reads as a layout problem and sends
 * the next person to the wrong file. So this is deliberately the first thing to run and the least
 * clever thing in the directory: open the built app, wait, and assert there is a page there.
 *
 * A port answering is not the app working. That is the whole lesson and it is worth one file.
 *
 *   npm run build
 *   node scripts/test-the-app-mounts.mjs
 */
import puppeteer from 'puppeteer-core'
import { openBoard } from './lib/board.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const board = await openBoard({ projectName: 'mounts', cards: [{ title: 'A card' }] })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 2200, height: 1200, deviceScaleFactor: 1 },
})
const page = await browser.newPage()

/*
 * Collected from before the first navigation, because the error this guards against happens during
 * the first mount. A listener attached afterwards sees a quiet page and reports success.
 */
const thrown = []
page.on('pageerror', (e) => thrown.push(e.stack || String(e)))

await page.goto(`${board.UI}/`, { waitUntil: 'networkidle2' })
await sleep(2500)

const seen = await page.evaluate(() => {
  const root = document.getElementById('root')
  return {
    rootExists: !!root,
    rootChildren: root ? root.children.length : 0,
    textLength: document.body.innerText.trim().length,
    buttons: document.querySelectorAll('button').length,
  }
})

check('the page has a root element', seen.rootExists)
check('React mounted something into it', seen.rootChildren > 0, `${seen.rootChildren} children`)
/*
 * A number rather than "not empty", because a torn-down tree can still leave a stray node behind and
 * an assertion that accepts one character is an assertion that accepts a blank screen. The real
 * board draws roughly nineteen thousand characters; a hundred is far below anything that has ever
 * been a working board and far above any debris.
 */
check('there is readable text on screen', seen.textLength > 100, `${seen.textLength} characters`)
check('there are controls on screen', seen.buttons > 0, `${seen.buttons} buttons`)

/*
 * Last, so that when the mount fails the output says what threw rather than only that nothing was
 * drawn. The stack is the part that names the file.
 */
check('nothing threw while the app started', thrown.length === 0, thrown.slice(0, 2).join(' | ').slice(0, 400))

await browser.close()
await board.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
