import assert from 'node:assert/strict';

// Educational models, not implementations or benchmarks of Caffeine.
function replay(trace, capacity, policy) {
  const cache = new Map();
  const history = new Map();
  let hits = 0;
  const states = [];
  for (const [time, key] of trace.entries()) {
    history.set(key, (history.get(key) ?? 0) + 1);
    const hit = cache.has(key);
    if (hit) {
      hits++;
      const entry = cache.get(key);
      entry.frequency++;
      entry.time = time;
    } else {
      let admit = true;
      if (cache.size === capacity) {
        const victim = [...cache.entries()].sort((a, b) =>
          policy === 'LFU'
            ? a[1].frequency - b[1].frequency || a[1].time - b[1].time
            : a[1].time - b[1].time)[0][0];
        // Exact, unbounded, non-aging history: only illustrates admission.
        admit = policy !== 'Admission' || history.get(key) > history.get(victim);
        if (admit) cache.delete(victim);
      }
      if (admit) cache.set(key, { frequency: 1, time });
    }
    states.push({ key, hit, residents: [...cache.keys()] });
    assert.ok(cache.size <= capacity);
  }
  return { hits, misses: trace.length - hits, states };
}

const scan = ['A', 'B', 'C', 'A', 'B', 'C', 'X', 'Y', 'Z', 'A', 'B', 'C'];
const shift = ['A', 'B', 'A', 'B', 'A', 'B', 'C', 'D', 'C', 'D', 'C', 'D'];
for (const [name, trace, capacity, expected] of [
  ['scan', scan, 3, [3, 5, 6]],
  // C and D each reach frequency 3, tying the old residents; strict admission rejects them.
  ['shift', shift, 2, [8, 4, 4]],
]) {
  console.log(`${name}: capacity=${capacity}, trace=${trace.join(' ')}`);
  for (const [i, policy] of ['LRU', 'LFU', 'Admission'].entries()) {
    const result = replay(trace, capacity, policy);
    assert.equal(result.hits, expected[i]);
    console.log(`${policy}: hits=${result.hits}, misses=${result.misses}`);
  }
}

// Doubles cannot distinguish these adjacent integers.
assert.equal(Number(9007199254740992n), Number(9007199254740993n));
console.log('double precision: 2^53 and 2^53 + 1 collapse to the same Number');
