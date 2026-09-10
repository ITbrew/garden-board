/**
 * Reports the gap between arrivals on stdin, so a test can measure how a line is actually typed.
 *
 * Garden sends a card's line as the text, then the carriage return a moment later, because a CLI
 * composer that receives both in one burst reads it as pasted text and leaves it sitting unsent.
 * That gap is the whole mechanism and nothing measured it: the delay was a number in the source and
 * an assumption about what came out the other end.
 */
/*
 * Raw mode, and it is the whole reason this file has a comment.
 *
 * A terminal in its ordinary cooked mode does not hand a program each keystroke: the line discipline
 * collects characters until a return and delivers the line in one piece. So a first version of this
 * without raw mode reported the text and the return arriving together no matter how far apart they
 * were actually sent, at 40ms and at 150ms alike, and very nearly convicted Garden of a merge that
 * was happening inside the fixture measuring it.
 */
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let last = 0
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  const now = Date.now()
  const gap = last ? now - last : 0
  last = now
  const what = d.includes('\r') ? 'CR' : JSON.stringify(d.slice(0, 20))
  process.stdout.write(`ARRIVAL ${what} gap=${gap}\r\n`)
})
process.stdin.resume()
setInterval(() => {}, 1 << 30)
