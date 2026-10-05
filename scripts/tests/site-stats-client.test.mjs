import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('../../src/scripts/site-stats.ts', import.meta.url), 'utf8'));
async function run({ article = false, counted = false, storage = true, ok = true, views = 1234, path = '/' } = {}) {
	const calls = [], writes = [], attrs = [];
	const counter = { textContent: '—', closest: () => ({ setAttribute: (...args) => attrs.push(args) }) };
	const context = {
		document: { querySelector: selector => selector === '[data-post-stats]' ? (article ? {} : null) : counter },
		window: { location: { pathname: path } }, Date, Number, Error,
		localStorage: {
			getItem: () => { if (!storage) throw Error('blocked'); return counted ? '1' : null; },
			setItem: (...args) => writes.push(args),
		},
		fetch: async (...args) => { calls.push(args); return { ok, json: async () => ({ views }) }; },
	};
	await runInNewContext(source.replace('void updateSiteStats();', 'updateSiteStats();'), context);
	return { calls, writes, counter, attrs };
}

test('first homepage visit records and renders formatted total', async () => {
	const { calls, writes, counter } = await run();
	assert.equal(calls[0][1].method, 'POST');
	assert.equal(JSON.parse(calls[0][1].body).path, '/');
	assert.equal(writes.length, 1);
	assert.equal(counter.textContent, '1,234');
});
test('refresh and blocked storage only read the total', async () => {
	for (const options of [{ counted: true }, { storage: false }]) {
		const { calls, writes } = await run(options);
		assert.equal(calls[0][1], undefined);
		assert.equal(writes.length, 0);
	}
});
test('article page never increments the global endpoint', async () => {
	const { calls } = await run({ article: true, path: '/posts/example/' });
	assert.equal(calls[0][1], undefined);
});
test('failure or malformed total does not mark visit as recorded', async () => {
	for (const options of [{ ok: false }, { views: -1 }, { views: '123' }]) {
		const { writes, counter, attrs } = await run(options);
		assert.equal(counter.textContent, '暂不可用');
		assert.equal(writes.length, 0);
		assert.equal(attrs[0][0], 'title');
	}
});
