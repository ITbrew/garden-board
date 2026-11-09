// The server answers a project's file list after the walk was made asynchronous (canon 01),
// on a board of its own. Needs `npm run build` first.
import { openBoard } from './lib/board.mjs'

const board = await openBoard({ files: { 'CLAUDE.md': '# a', 'notes.md': 'b' } })
let pass = true
try {
  const files = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no doc.list answer in 10 s')), 10000)
    board.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      if (m.t === 'doc.list' && m.projectId === board.project.id) {
        clearTimeout(timer)
        resolve(m.files)
      }
    })
    board.ws.send(JSON.stringify({ t: 'doc.list', projectId: board.project.id }))
  })
  const ok = files.includes('CLAUDE.md') && files.includes('notes.md')
  console.log(ok ? 'PASS' : 'FAIL', 'doc.list answers with the project files:', JSON.stringify(files))
  pass = ok
} catch (err) {
  console.log('FAIL', err.message)
  pass = false
} finally {
  await board.stop()
}
process.exit(pass ? 0 : 1)
