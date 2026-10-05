import assert from 'node:assert/strict';

// Teaching model: integer allocation, local refund reservations and lift arithmetic.
// This does not model database transactions, payment providers or experiment validity.
function allocateDiscount(grossMinor, discountMinor) {
  assert(grossMinor.length > 0);
  for (const value of [...grossMinor, discountMinor]) {
    assert(Number.isSafeInteger(value) && value >= 0);
  }
  const gross = grossMinor.map(BigInt);
  const total = gross.reduce((sum, value) => sum + value, 0n);
  const discount = BigInt(discountMinor);
  assert(discount <= total, 'discount exceeds gross');
  if (total === 0n) return grossMinor.map(() => 0);
  const portions = gross.map((value, index) => ({
    index,
    amount: (value * discount) / total,
    remainder: (value * discount) % total,
  }));
  const assigned = portions.reduce((sum, part) => sum + part.amount, 0n);
  const ranked = [...portions].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (let index = 0; index < Number(discount - assigned); index++) {
    ranked[index].amount += 1n;
  }
  return portions.map((part) => Number(part.amount));
}

class RefundLedger {
  constructor(itemLimits) {
    this.itemLimits = new Map(Object.entries(itemLimits));
    this.requests = new Map();
  }

  reserve(id, item, amount) {
    assert(Number.isSafeInteger(amount) && amount > 0);
    const existing = this.requests.get(id);
    if (existing) {
      assert.equal(existing.item, item, 'same identity, conflicting item');
      assert.equal(existing.amount, amount, 'same identity, conflicting amount');
      return existing;
    }
    assert(this.itemLimits.has(item), 'unknown item');
    const committed = [...this.requests.values()]
      .filter((request) => request.item === item && request.state !== 'FAILED')
      .reduce((sum, request) => sum + BigInt(request.amount), 0n);
    assert(committed + BigInt(amount) <= BigInt(this.itemLimits.get(item)), 'refund limit exceeded');
    const request = { item, amount, state: 'RESERVED' };
    this.requests.set(id, request);
    return request;
  }

  update(id, state) {
    const request = this.requests.get(id);
    assert(request, 'unknown refund');
    assert(['UNKNOWN', 'SUCCESS', 'FAILED'].includes(state));
    if (['SUCCESS', 'FAILED'].includes(request.state)) {
      assert.equal(request.state, state, 'cannot overwrite terminal fact');
      return;
    }
    // FAILED means a confirmed failure with no future provider side effect.
    request.state = state;
  }
}

const discounts = allocateDiscount([12900, 7100], 3000);
assert.deepEqual(discounts, [1935, 1065]);
assert.deepEqual(allocateDiscount([100, 100, 100], 100), [34, 33, 33]);
assert.deepEqual(allocateDiscount([0, 0], 0), [0, 0]);
assert.throws(() => allocateDiscount([100], 101));
let allocationCases = 0;
for (let a = 0; a <= 12; a++) {
  for (let b = 0; b <= 12; b++) {
    for (let discount = 0; discount <= a + b + 3; discount++) {
      const gross = [a, b, 3];
      const allocated = allocateDiscount(gross, discount);
      assert.equal(allocated.reduce((sum, value) => sum + value, 0), discount);
      allocated.forEach((value, index) => assert(value <= gross[index]));
      assert.deepEqual(allocated, allocateDiscount(gross, discount));
      allocationCases++;
    }
  }
}

const ledger = new RefundLedger({ A: 10965, B: 6035 });
const original = ledger.reserve('refund_demo_A_1', 'A', 10965);
ledger.update('refund_demo_A_1', 'UNKNOWN');
assert.equal(ledger.reserve('refund_demo_A_1', 'A', 10965), original);
assert.throws(() => ledger.reserve('refund_demo_A_2', 'A', 1));
assert.throws(() => ledger.reserve('refund_demo_A_1', 'A', 100));
ledger.update('refund_demo_A_1', 'SUCCESS');
ledger.update('refund_demo_A_1', 'SUCCESS');
assert.throws(() => ledger.update('refund_demo_A_1', 'FAILED'));
assert.throws(() => ledger.reserve('refund_demo_A_2', 'A', 1));
ledger.reserve('refund_demo_B_1', 'B', 100);
ledger.update('refund_demo_B_1', 'FAILED');
ledger.reserve('refund_demo_B_2', 'B', 6035);

function lift(treatmentUsers, treatmentReturns, controlUsers, controlReturns, extraCost) {
  for (const value of [treatmentUsers, treatmentReturns, controlUsers, controlReturns]) {
    assert(Number.isSafeInteger(value) && value >= 0);
  }
  assert(treatmentUsers > 0 && controlUsers > 0);
  assert(treatmentReturns <= treatmentUsers && controlReturns <= controlUsers);
  assert(Number.isFinite(extraCost) && extraCost >= 0);
  const treatmentRate = treatmentReturns / treatmentUsers;
  const controlRate = controlReturns / controlUsers;
  const absoluteLift = treatmentRate - controlRate;
  const incrementalReturns = treatmentUsers * absoluteLift;
  return {
    treatmentRate,
    controlRate,
    absoluteLift,
    relativeLift: controlRate > 0 ? absoluteLift / controlRate : null,
    incrementalReturns,
    costPerIncrementalReturn: incrementalReturns > 0 ? extraCost / incrementalReturns : null,
  };
}

const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9);
const experiment = lift(10000, 2200, 10000, 2000, 1000);
close(experiment.absoluteLift, 0.02);
close(experiment.relativeLift, 0.1);
close(experiment.incrementalReturns, 200);
close(experiment.costPerIncrementalReturn, 5);
close(lift(10000, 2200, 5000, 1000, 1000).incrementalReturns, 200);
assert.equal(lift(10000, 2000, 10000, 2000, 1000).costPerIncrementalReturn, null);
assert.equal(lift(10000, 1900, 10000, 2000, 1000).costPerIncrementalReturn, null);
assert.equal(lift(10000, 100, 10000, 0, 1000).relativeLift, null);
assert.throws(() => lift(0, 0, 100, 10, 100));

console.log(JSON.stringify({
  allocationCases,
  discounts,
  payableMinor: [12900 - discounts[0], 7100 - discounts[1]],
  refundChecks: 'passed (local model only)',
  experiment: Object.fromEntries(Object.entries(experiment).map(([key, value]) =>
    [key, value === null ? null : Number(value.toFixed(8))],
  )),
  limitation: 'Synthetic examples; no provider protocol, concurrency or statistical significance claim.',
}, null, 2));
