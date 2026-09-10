/**
 * Reading the token counter out of what the CLI actually printed.
 *
 * The fixtures below are real lines, captured from a live session's buffer and from the owner's
 * own screen, rather than invented ones. That matters more than usual here: this parser is the
 * one place Garden reads rendered output instead of a published file, so it has to be checked
 * against the exact shapes the CLI draws, including the awkward one with no thousands suffix.
 */
import { readTokens, TokenTally, fractionOf } from '../server/dist/tokens.js'

let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const spinner = '\u001b[33m✢ Drizzling…\u001b[0m (4m 22s · ↓ 9.9k tokens)'
check('a spinner figure with a k suffix', readTokens(spinner).turn === 9900, String(readTokens(spinner).turn))

const bare = '✶Flummoxing… · 1s · ↓4 tokens)'
check('a bare count with no suffix', readTokens(bare).turn === 4, String(readTokens(bare).turn))

const millions = '✻ Thinking… (12m 1s · ↓ 1.2M tokens)'
check('a count in millions', readTokens(millions).turn === 1200000, String(readTokens(millions).turn))

const tree = [
  '  ● main',
  '  ◯ archivist  You are working in C:\Garden, a Node+TypeScript+Re...      3m 45s · ↓ 72.0k tokens',
  '  ◯ pipeline   You are working in C:\Garden, a Node+TypeScript+Re...      3m 12s · ↓ 90.4k tokens',
].join('\n')
const read = readTokens(tree)
check('each agent row is read separately', read.agents.get('archivist') === 72000 && read.agents.get('pipeline') === 90400,
  JSON.stringify([...read.agents]))

// A sentence that merely contains the word must not be mistaken for a counter row.
const prose = 'I will now count the tokens in the file and report back.'
check('ordinary prose is not read as an agent row', readTokens(prose).agents.size === 0)

// The running total banks each turn's peak when the counter restarts.
const tally = new TokenTally()
tally.observe(4000)
tally.observe(9900)
const afterFirst = tally.observe(9900)
check('a turn in progress reads as its own figure', afterFirst === 9900, String(afterFirst))
const afterReset = tally.observe(200)
check('a new turn banks the last one rather than losing it', afterReset === 10100, String(afterReset))
const afterGrowth = tally.observe(5000)
check('and keeps accumulating from there', afterGrowth === 14900, String(afterGrowth))

/*
 * The window comes from the model, so the model has to be passed.
 *
 * These three called `fractionOf` with the total alone, which is the signature it had before the
 * denominator stopped being a constant. A missing model resolves to an unknown window, an unknown
 * window is null by design, and null was being compared against 0.25. The test was failing on its
 * own staleness while the function was doing exactly the right thing.
 */
const OPUS = 'claude-opus-5'
check('the gauge is a fraction of a one million window', fractionOf(250000, OPUS) === 0.25, String(fractionOf(250000, OPUS)))
check('and never exceeds full', fractionOf(4000000, OPUS) === 1, String(fractionOf(4000000, OPUS)))
check('nothing seen means a blank gauge, not zero', fractionOf(null, OPUS) === null)
/*
 * And the case the gauge exists for: a model whose window nobody knows leaves the bar blank rather
 * than picking a denominator. A made-up denominator answers "is this session too full to trust"
 * confidently and wrongly, which is worse than not answering.
 */
check('an unknown model leaves the gauge blank rather than guessing', fractionOf(250000, 'some-other-model') === null)
check('and so does no model at all', fractionOf(250000, null) === null)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
