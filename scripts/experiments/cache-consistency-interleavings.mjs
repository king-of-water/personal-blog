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
  if (version < state.floor || (state.value !== null && version < state.value)) return false;
  state.value = version;
  return true;
}
function invalidate(state, version) {
  state.floor = Math.max(state.floor, version);
  if (state.value !== null && state.value < state.floor) state.value = null;
}
const guarded = { floor: 41, value: 41 };
invalidate(guarded, 42);
assert.equal(fill(guarded, 41), false);
assert.equal(fill(guarded, 42), true);
invalidate(guarded, 43);
assert.equal(fill(guarded, 43), true);
invalidate(guarded, 42); // A duplicate, older event cannot lower the floor.
assert.equal(guarded.value, 43);
assert.equal(fill(guarded, 42), false);

const lostFloor = { floor: 42, value: null };
lostFloor.floor = 0; // Eviction/restart: missing floor treated as zero is unsafe.
assert.equal(fill(lostFloor, 41), true);

const commitAt = 20;
const fillAt = 200;
const ttl = 60;
assert(fillAt + ttl > commitAt + ttl);

console.log(JSON.stringify({
  deleteBeforeCommit: summarize(first, 41),
  deleteAfterCommitWithColdCache: summarize(after, null),
  twoWriters: { schedules: writers.length, stale: writerResults.filter(r => r.cache < r.db).length },
  delayedDoubleDelete: 'late fill after both deletes remains stale',
  versionGate: 'rejects old fill and preserves monotonic floor',
  lostFloor: 'counterexample: treating missing floor as zero admits old data',
  ttl: { commitAt, fillAt, ttl, expiresAt: fillAt + ttl },
  limitation: 'Finite schedules and atomic in-memory models; no provider, durability, latency or concurrency guarantee.',
}, null, 2));
