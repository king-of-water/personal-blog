import assert from 'node:assert/strict';

// Deterministic protocol models, not a Redis/MySQL implementation or stress test.
function interleave(a, b) {
  if (!a.length) return [b];
  if (!b.length) return [a];
  return [
    ...interleave(a.slice(1), b).map(tail => [a[0], ...tail]),
    ...interleave(a, b.slice(1)).map(tail => [b[0], ...tail]),
  ];
}

function readWrite(trace, initialCache) {
  let db = 41;
  let cache = initialCache;
  let missed = false;
  let loaded;
  for (const step of trace) {
    if (step === 'MISS') missed = cache === null;
    if (step === 'LOAD' && missed) loaded = db;
    if (step === 'SET' && missed) cache = loaded;
    if (step === 'COMMIT') db = 42;
    if (step.startsWith('DEL')) cache = null;
  }
  return { db, cache, stale: cache !== null && cache < db };
}

const reader = ['MISS', 'LOAD', 'SET'];
const first = interleave(['DEL', 'COMMIT'], reader);
const after = interleave(['COMMIT', 'DEL'], reader);
const summarize = (schedules, initialCache) => ({
  schedules: schedules.length,
  stale: schedules.filter(trace => readWrite(trace, initialCache).stale).length,
});
assert.equal(readWrite(['DEL', 'MISS', 'LOAD', 'SET', 'COMMIT'], 41).cache, 41);
assert.equal(readWrite(['MISS', 'LOAD', 'COMMIT', 'DEL', 'SET'], null).cache, 41);
assert.equal(readWrite(['MISS', 'LOAD', 'COMMIT', 'DEL1', 'DEL2', 'SET'], null).cache, 41);

const writers = interleave(['A_COMMIT', 'A_SET'], ['B_COMMIT', 'B_SET'])
  .filter(trace => trace.indexOf('A_COMMIT') < trace.indexOf('B_COMMIT'));
const writerResults = writers.map(trace => {
  let db = 41;
  let cache = 41;
  for (const step of trace) {
    if (step === 'A_COMMIT') db = 42;
    if (step === 'B_COMMIT') db = 43;
    if (step === 'A_SET') cache = 42;
    if (step === 'B_SET') cache = 43;
  }
  return { trace, db, cache };
});
assert(writerResults.some(r => r.db === 43 && r.cache === 42));

function fill(state, version) {
  if (state.floor === null) return 'unknown-floor';
  if (version < state.floor || (state.value !== null && version < state.value)) return 'stale';
  state.value = version;
  return 'stored';
}
function invalidate(state, version) {
  state.floor = Math.max(state.floor, version);
  if (state.value !== null && state.value < state.floor) state.value = null;
}
const guarded = { floor: 41, value: 41 };
invalidate(guarded, 42);
assert.equal(fill(guarded, 41), 'stale');
assert.equal(fill(guarded, 42), 'stored');
invalidate(guarded, 43);
assert.equal(fill(guarded, 43), 'stored');
invalidate(guarded, 42); // A duplicate, older event cannot lower the floor.
assert.equal(guarded.value, 43);
assert.equal(fill(guarded, 42), 'stale');

const lostFloor = { floor: 42, value: null };
lostFloor.floor = 0; // Eviction/restart: missing floor treated as zero is unsafe.
assert.equal(fill(lostFloor, 41), 'stored');
const unknownFloor = { floor: null, value: null };
assert.equal(fill(unknownFloor, 41), 'unknown-floor');
assert.equal(unknownFloor.value, null);

assert.equal(readWrite(['DEL1', 'MISS', 'LOAD', 'COMMIT', 'SET', 'DEL2'], 41).cache, null);
assert.equal(readWrite(['DEL1', 'MISS', 'LOAD', 'COMMIT', 'DEL2', 'SET'], 41).cache, 41);

// A durable confirmation flag survives this model's consumer restart.
// Redis/MQ persistence and transport failures are deliberately not simulated.
function consumeEvent(state, { confirmFirst = false, failAfter } = {}) {
  if (state.confirmed) return 'skipped';
  for (const action of confirmFirst ? ['ACK', 'DEL'] : ['DEL', 'ACK']) {
    if (action === 'ACK') state.confirmed = true;
    if (action === 'DEL') state.value = null;
    if (action === failAfter) return 'crashed';
  }
  return 'done';
}
const acknowledgedTooEarly = { value: 41, confirmed: false };
assert.equal(consumeEvent(acknowledgedTooEarly, { confirmFirst: true, failAfter: 'ACK' }), 'crashed');
assert.equal(consumeEvent(acknowledgedTooEarly), 'skipped');
assert.equal(acknowledgedTooEarly.value, 41);
const safelyReplayable = { value: 41, confirmed: false };
assert.equal(consumeEvent(safelyReplayable, { failAfter: 'DEL' }), 'crashed');
assert.equal(safelyReplayable.confirmed, false);
safelyReplayable.value = 42; // A fresh read fills the cache before replay.
assert.equal(consumeEvent(safelyReplayable), 'done');
assert.equal(safelyReplayable.value, null); // Duplicate DEL costs a miss, not an old SET.
assert.equal(safelyReplayable.confirmed, true);

const commitAt = 20;
const fillAt = 200;
const ttl = 60;
assert(fillAt + ttl > commitAt + ttl);

console.log(JSON.stringify({
  deleteBeforeCommit: summarize(first, 41),
  deleteAfterCommitWithColdCache: summarize(after, null),
  twoWriters: { schedules: writers.length, stale: writerResults.filter(r => r.cache < r.db).length },
  delayedDoubleDelete: 'clears a fill before DEL2; a later fill remains stale',
  versionGate: 'rejects old fill and preserves monotonic floor',
  lostFloor: 'counterexample: treating missing floor as zero admits old data',
  unknownFloor: 'rejects fills until the missing floor is safely recovered',
  consumerRecovery: 'ACK-before-DEL can lose work; DEL-before-ACK permits replay',
  ttl: { commitAt, fillAt, ttl, expiresAt: fillAt + ttl },
  limitation: 'Finite schedules and atomic in-memory models; no provider, durability, latency or concurrency guarantee.',
}, null, 2));
