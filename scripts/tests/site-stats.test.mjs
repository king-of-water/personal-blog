import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequestGet, onRequestPost } from '../../functions/api/site-stats.js';

function database() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(readFileSync(new URL('../../migrations/0001_post_stats.sql', import.meta.url), 'utf8'));
	return {
		sqlite,
		env: { DB: { prepare(sql) {
			const stmt = sqlite.prepare(sql);
			return { first: async () => stmt.get(), run: async () => stmt.run() };
		} } },
	};
}
const request = (path) => new Request('https://example.com/api/site-stats', {
	method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
});

test('empty total is zero; GET does not add views', async () => {
	const { env, sqlite } = database();
	try {
		const response = await onRequestGet({ env });
		assert.deepEqual(await response.json(), { views: 0 });
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM post_stats').get().n, 0);
	} finally { sqlite.close(); }
});

test('retains historical article views; counts other pages atomically without changing likes', async () => {
	const { env, sqlite } = database();
	try {
		sqlite.exec("INSERT INTO post_stats(slug, views, likes) VALUES ('first', 120, 8), ('second', 34, 2)");
		assert.deepEqual(await (await onRequestGet({ env })).json(), { views: 154 });
		for (const path of ['/', '/backend/', '/agent/ai-coding/', '/posts/', '/about/']) {
			assert.equal((await onRequestPost({ env, request: request(path) })).status, 200);
		}
		assert.deepEqual(await (await onRequestGet({ env })).json(), { views: 159 });
		assert.equal(sqlite.prepare("SELECT views FROM post_stats WHERE slug='@site-pages'").get().views, 5);
		assert.equal(sqlite.prepare("SELECT likes FROM post_stats WHERE slug='first'").get().likes, 8);
	} finally { sqlite.close(); }
});

test('rejects articles, assets, unrecognized paths, queries and invalid JSON', async () => {
	const { env, sqlite } = database();
	try {
		for (const path of ['/posts/first/', '/api/stats/first', '/images/avatar.jpg', '//', '/bogus/', '/?x=1', null]) {
			assert.equal((await onRequestPost({ env, request: request(path) })).status, 400);
		}
		assert.equal((await onRequestPost({ env, request: new Request('https://example.com', { method: 'POST', body: '{' }) })).status, 400);
		assert.deepEqual(await (await onRequestGet({ env })).json(), { views: 0 });
	} finally { sqlite.close(); }
});

test('missing DB returns 503 rather than a fabricated zero', async () => {
	assert.equal((await onRequestGet({ env: {} })).status, 503);
	assert.equal((await onRequestPost({ env: {}, request: request('/') })).status, 503);
});
