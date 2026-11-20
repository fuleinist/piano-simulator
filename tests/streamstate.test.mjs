// Streaming state machine tests. Run: node --test tests/streamstate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RETRIES, STATE, isBusy, isOnAir, nextState, retryDelay } from '../src/streamstate.js';

test('a session walks idle → connecting → live → stopping → idle', () => {
  let state = STATE.IDLE;
  state = nextState(state, 'start');
  assert.equal(state, STATE.CONNECTING);
  state = nextState(state, 'ready');
  assert.equal(state, STATE.LIVE);
  state = nextState(state, 'stop');
  assert.equal(state, STATE.STOPPING);
  state = nextState(state, 'done');
  assert.equal(state, STATE.IDLE);
});

test('a failed connect returns to idle, not to live', () => {
  assert.equal(nextState(STATE.CONNECTING, 'fail'), STATE.IDLE);
  assert.equal(nextState(STATE.RECONNECTING, 'fail'), STATE.IDLE);
});

test('a drop while live reconnects, and a ready returns to live', () => {
  assert.equal(nextState(STATE.LIVE, 'drop'), STATE.RECONNECTING);
  assert.equal(nextState(STATE.RECONNECTING, 'ready'), STATE.LIVE);
  assert.equal(nextState(STATE.RECONNECTING, 'stop'), STATE.STOPPING);
});

test('an event that does not apply leaves the state alone', () => {
  assert.equal(nextState(STATE.IDLE, 'ready'), STATE.IDLE);
  assert.equal(nextState(STATE.IDLE, 'stop'), STATE.IDLE);
  assert.equal(nextState(STATE.LIVE, 'start'), STATE.LIVE);
  assert.equal(nextState(STATE.STOPPING, 'ready'), STATE.STOPPING);
});

test('an unknown state survives an unknown event', () => {
  assert.equal(nextState('bogus', 'start'), 'bogus');
});

test('only live is on air', () => {
  assert.equal(isOnAir(STATE.LIVE), true);
  for (const state of [STATE.IDLE, STATE.CONNECTING, STATE.STOPPING, STATE.RECONNECTING]) {
    assert.equal(isOnAir(state), false);
  }
});

test('connecting, stopping and reconnecting count as busy', () => {
  assert.equal(isBusy(STATE.CONNECTING), true);
  assert.equal(isBusy(STATE.STOPPING), true);
  assert.equal(isBusy(STATE.RECONNECTING), true);
  assert.equal(isBusy(STATE.IDLE), false);
  assert.equal(isBusy(STATE.LIVE), false);
});

test('the retry backoff doubles and then stops', () => {
  assert.equal(retryDelay(0), 1000);
  assert.equal(retryDelay(1), 2000);
  assert.equal(retryDelay(MAX_RETRIES), null, 'no more retries past the cap');
  assert.equal(retryDelay(-1), null);
  assert.equal(retryDelay(1.5), null);
});
