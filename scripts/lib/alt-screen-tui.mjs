/**
 * A stand-in for a full-screen CLI, used to ask ConPTY one question and nothing else.
 *
 * The fault under investigation is specific to the ALTERNATE screen buffer: a program that takes
 * over the whole screen, draws a box sized to the current width, and redraws when that width
 * changes. `test-terminal-geometry.mjs` tried a plain shell and could not make it appear, and the
 * reason is that a shell sits on the main screen and repaints nothing on a resize.
 *
 * The real CLI would be better evidence and cannot be used here: this machine puts an account shim
 * in front of `claude`, and a scratch folder maps to no account, so it stops on a question nobody is
 * watching. It also costs the owner's money to look at a rectangle.
 *
 * What makes this a measurement rather than a demo: every redraw stamps its own number into every
 * line it writes. The program knows how many times it drew and says so on exit. So the count of
 * `DRAW-7` in the byte stream is not an estimate, it is the answer to "how many copies of the
 * seventh screen came out of ConPTY", and anything above one was not sent by this program.
 */
const write = (s) => process.stdout.write(s)

let draws = 0

function paint() {
  draws++
  const cols = Math.max(20, process.stdout.columns || 80)
  const rows = Math.max(6, process.stdout.rows || 24)
  const w = cols - 1

  // Clear and home, the way a TUI repaints its whole screen.
  write('\x1b[2J\x1b[H')
  write('╭' + '─'.repeat(w - 2) + '╮\r\n')
  write('│' + ` DRAW-${draws} at ${cols}x${rows} `.padEnd(w - 2).slice(0, w - 2) + '│\r\n')
  write('╰' + '─'.repeat(w - 2) + '╯\r\n')
  // Body wide enough that a reflow to a narrower grid has to wrap something.
  const body = Math.min(8, rows - 5)
  for (let i = 0; i < body; i++) {
    const tag = `ROW-${draws}-${i}-`
    write(tag + '#'.repeat(Math.max(0, w - tag.length)) + '\r\n')
  }
  write(`\x1b[${rows};1HREADY-${draws}`)
}

write('\x1b[?1049h')
paint()

// Node raises this on Windows when the console screen buffer changes size, which is what ConPTY
// does to it on a resize. It does not, in practice, on this machine, which is what makes the
// duplicate count unambiguous: the program drew once and everything else in the stream came from
// somewhere else.
process.stdout.on('resize', paint)

/*
 * Redraw on demand, so a test can ask for the thing a real CLI does after a resize.
 *
 * A TUI repaints its whole screen when the width changes. That matters for a separate question from
 * the one above: whether a buffer holding screens drawn at two different widths can be replayed into
 * one terminal without the older one showing through. Any byte on stdin paints again.
 */
if (process.stdin.isTTY) process.stdin.setRawMode?.(true)
process.stdin.on('data', () => paint())
process.stdin.resume()

process.on('SIGINT', () => {
  write('\x1b[?1049l')
  write(`\r\nDRAWS-TOTAL=${draws}\r\n`)
  process.exit(0)
})

// Stay up. The test kills the session when it is finished.
setInterval(() => {}, 1 << 30)
