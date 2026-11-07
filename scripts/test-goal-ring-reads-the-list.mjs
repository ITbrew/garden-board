/**
 * The goal ring's reading of TODO.md. Canon 26, "The goal ring". No server and no board: run with
 * `npx tsx scripts/test-goal-ring-reads-the-list.mjs`.
 */
import { defaultStep, parseGoal } from '../apps/web/src/goals.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failures++
}

const LIST = [
  '# TO DO',
  '',
  '## Now: Stable board (1 of 3)',
  '',
  'Garden keeps responding while many cards work at once.',
  '',
  '- [x] **Main thread** @Orchestrator',
  '  - Why: Slow work leaves the server thread.',
  '  - End: The board keeps answering during a disk stall.',
  '- [ ] Heavy load @Worker one',
  '  - Start: Watch the freeze record.',
  '  - End: No freeze over 5 s.',
  '  - [x] Freeze record',
  '    - Why: Garden logs every freeze.',
  '    - End: Every freeze is logged.',
  '  - [ ] Busy build #doing',
  '- [ ] Restart #needs-you',
  '',
  '## Later: Public copy',
  '',
  '- [ ] Quotes',
  '',
].join('\r\n')

const goal = parseGoal(LIST, ['Orchestrator', 'Worker', 'Worker one'])
check('reads the Now heading, without its typed count', goal?.title === 'Stable board', goal?.title)
check('text under the heading describes the goal', goal?.description.startsWith('Garden keeps'), goal?.description)
check('only that goal is read', goal?.steps.length === 3, String(goal?.steps.length))
check('counts what is done', goal?.done === 1, String(goal?.done))

const [main, heavy, restart] = goal.steps
check('bold and the card name leave the label', main.label === 'Main thread', main.label)
check('the card name is kept apart', main.owner === 'Orchestrator', String(main.owner))
check('the longest card title wins', heavy.owner === 'Worker one', String(heavy.owner))
check('a tick is done', main.state === 'done', main.state)
check('Why is the description', main.description.startsWith('Slow work'), main.description)
check('End is what done means', main.doneWhen.startsWith('The board keeps'), main.doneWhen)
check('Start stands in when there is no Why', heavy.description.startsWith('Watch'), heavy.description)
check('nested items are parts', heavy.parts.map((p) => p.label).join() === 'Freeze record,Busy build', heavy.parts.map((p) => p.label).join())
check('a bullet under a part describes that part', heavy.parts[0].description.startsWith('Garden logs'), heavy.parts[0].description)
check('End under a part is its exit', heavy.parts[0].doneWhen === 'Every freeze is logged.', heavy.parts[0].doneWhen)
check('and never its description', !heavy.parts[0].description.includes('Every freeze'))
const finished = parseGoal('- [ ] Outcome\n  - [x] One\n  - [x] Two\n', [])
check('a goal whose sub-goals are all done reads done', finished?.steps[0].state === 'done' && finished?.done === 1, finished?.steps[0].state)
check('a step takes its state from its parts', heavy.state === 'doing', heavy.state)
check('an old needs-you tag is hidden and means nothing', restart.state === 'next' && restart.label === 'Restart', `${restart.state} ${restart.label}`)
check('the step under way opens first', defaultStep(goal) === 1, String(defaultStep(goal)))

check('a part under way raises its step', parseGoal('## Now: A\n- [ ] B\n  - [ ] C #doing\n', [])?.steps[0].state === 'doing')
check('no items means no goal', parseGoal('# TO DO\n\nJust notes.\n', []) === null)
check('with no Now heading, the first heading with items is the goal', parseGoal('# Notes\n\ntext\n\n## Build\n- [ ] A\n', [])?.title === 'Build')
check('a list with no heading still has a goal', parseGoal('- [ ] A\n- [x] B\n', [])?.steps.length === 2)

const OLD = '# Plan\n\nnotes\n\n## First\n- [x] A\n- [x] B\n\n## Second\n- [x] C\n- [ ] D\n\n## Third\n- [ ] E\n'
const old = parseGoal(OLD, [])
check('an old list draws each heading as a goal', old?.steps.map((s) => s.label).join() === 'First,Second,Third', old?.steps.map((s) => s.label).join())
check('and its items as sub-goals', old?.steps[1].parts.map((p) => p.label).join() === 'C,D')
check('with states from those items', old?.steps.map((s) => s.state).join() === 'done,doing,next', old?.steps.map((s) => s.state).join())
check('and the count of finished goals', old?.done === 1 && old?.title === 'Plan', JSON.stringify([old?.done, old?.title]))
check('a Now heading still wins', parseGoal('## Now: X\n- [ ] A\n\n## Later\n- [ ] B\n', [])?.steps.length === 1)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
