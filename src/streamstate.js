// The streaming state machine, kept free of the DOM and of the network so the
// transitions can be tested in Node.
//
// idle → connecting → live → stopping → idle
// A dropped socket while live moves to reconnecting, which either returns to
// live or gives up at idle with an error.

export const STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  LIVE: 'live',
  STOPPING: 'stopping',
  RECONNECTING: 'reconnecting',
};

const TABLE = {
  [STATE.IDLE]: { start: STATE.CONNECTING },
  [STATE.CONNECTING]: { ready: STATE.LIVE, stop: STATE.STOPPING, fail: STATE.IDLE },
  [STATE.LIVE]: { drop: STATE.RECONNECTING, stop: STATE.STOPPING, fail: STATE.STOPPING },
  [STATE.RECONNECTING]: { ready: STATE.LIVE, stop: STATE.STOPPING, fail: STATE.IDLE },
  [STATE.STOPPING]: { done: STATE.IDLE },
};

/** The state after one event, or the same state when the event does not apply. */
export function nextState(current, event) {
  return TABLE[current]?.[event] ?? current;
}

/** True while frames are leaving the machine. */
export function isOnAir(state) {
  return state === STATE.LIVE;
}

/** True while a start or a stop is in flight. */
export function isBusy(state) {
  return state === STATE.CONNECTING || state === STATE.STOPPING || state === STATE.RECONNECTING;
}

export const MAX_RETRIES = 2;

/**
 * Backoff before a reconnect attempt. Attempt 0 waits 1 s, attempt 1 waits 2 s,
 * and the delay stops growing at 8 s. Null means give up.
 * @param {number} attempt
 */
export function retryDelay(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_RETRIES) return null;
  return Math.min(1000 * 2 ** attempt, 8000);
}
