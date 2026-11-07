import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RING_STUCK_AFTER, ringLoopStep, type RingLoopFacts } from './ring-loop.js'

const running: RingLoopFacts = { enabled: true, stoppedBy: null, left: 2, total: 6, listChanged: false, firesUnchanged: 0, anyWorking: false }

test('a running loop carries on while goals are left, whatever their number', () => {
  assert.equal(ringLoopStep(running), 'carry-on')
  assert.equal(ringLoopStep({ ...running, left: 13, total: 14 }), 'carry-on')
})

test('it finishes when the ring is full, whatever its size', () => {
  assert.equal(ringLoopStep({ ...running, left: 0, total: 3 }), 'finish')
  assert.equal(ringLoopStep({ ...running, left: 0, total: 14 }), 'finish')
})

test('a list with no goals finishes rather than running forever', () => {
  assert.equal(ringLoopStep({ ...running, left: 0, total: 0 }), 'finish')
})

test('it pauses when repeated check-ins move nothing', () => {
  assert.equal(ringLoopStep({ ...running, firesUnchanged: RING_STUCK_AFTER - 1 }), 'carry-on')
  assert.equal(ringLoopStep({ ...running, firesUnchanged: RING_STUCK_AFTER }), 'pause')
})

test('it does not pause while a card is still working', () => {
  assert.equal(ringLoopStep({ ...running, firesUnchanged: 50, anyWorking: true }), 'carry-on')
})

test('a full ring given new goals runs again', () => {
  assert.equal(ringLoopStep({ ...running, enabled: false, stoppedBy: 'ring', left: 3, total: 9 }), 'resume')
})

test('a full ring with no new goals stays stopped', () => {
  assert.equal(ringLoopStep({ ...running, enabled: false, stoppedBy: 'ring', left: 0 }), 'stay-stopped')
})

test('a paused loop waits for the list to change', () => {
  const paused = { ...running, enabled: false, stoppedBy: 'stuck' as const }
  assert.equal(ringLoopStep(paused), 'stay-stopped')
  assert.equal(ringLoopStep({ ...paused, listChanged: true }), 'resume')
})

test('a disabled loop stays off, even with goals left and a changed list', () => {
  assert.equal(ringLoopStep({ ...running, enabled: false, stoppedBy: 'disabled', listChanged: true }), 'stay-stopped')
})

test('a loop stopped by hand stays stopped, even with goals left and a changed list', () => {
  assert.equal(ringLoopStep({ ...running, enabled: false, stoppedBy: 'owner', listChanged: true }), 'stay-stopped')
  assert.equal(ringLoopStep({ ...running, enabled: false, stoppedBy: null, listChanged: true }), 'stay-stopped')
})
