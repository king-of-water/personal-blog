const responseJson = (data, status = 200) => new Response(JSON.stringify(data), {
	status,
	headers: {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	},
});

const validSlug = (slug) => /^[a-z0-9][a-z0-9-]{0,127}$/.test(slug);

const visitorHash = async (slug, visitorId) => {
	const input = new TextEncoder().encode(`${slug}:${visitorId}`);
	const digest = await crypto.subtle.digest('SHA-256', input);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const ensurePost = (db, slug) => db
	.prepare('INSERT OR IGNORE INTO post_stats (slug) VALUES (?)')
	.bind(slug)
	.run();

const readStats = async (db, slug, visitorId) => {
	const stats = await db
		.prepare('SELECT views, likes FROM post_stats WHERE slug = ?')
		.bind(slug)
		.first();
	let liked = false;

	if (visitorId) {
		const hash = await visitorHash(slug, visitorId);
		liked = Boolean(await db
			.prepare('SELECT 1 FROM post_likes WHERE slug = ? AND visitor_hash = ?')
			.bind(slug, hash)
			.first());
	}

	return { views: stats?.views ?? 0, likes: stats?.likes ?? 0, liked };
};

export const onRequestGet = async ({ env, params, request }) => {
	const slug = String(params.slug ?? '');
	if (!validSlug(slug)) return responseJson({ error: 'invalid slug' }, 400);
	if (!env.DB) return responseJson({ error: 'statistics database is not configured' }, 503);

	await ensurePost(env.DB, slug);
	const visitorId = new URL(request.url).searchParams.get('visitor');
	return responseJson(await readStats(env.DB, slug, visitorId));
};

export const onRequestPost = async ({ env, params, request }) => {
	const slug = String(params.slug ?? '');
	if (!validSlug(slug)) return responseJson({ error: 'invalid slug' }, 400);
	if (!env.DB) return responseJson({ error: 'statistics database is not configured' }, 503);

	let payload;
	try {
		payload = await request.json();
	} catch {
		return responseJson({ error: 'invalid request body' }, 400);
	}

	const action = payload?.action;
	const visitorId = typeof payload?.visitorId === 'string' ? payload.visitorId : '';
	if (!['view', 'like'].includes(action)) return responseJson({ error: 'invalid action' }, 400);
	if (visitorId.length < 16 || visitorId.length > 100) return responseJson({ error: 'invalid visitor id' }, 400);

	await ensurePost(env.DB, slug);

	if (action === 'view') {
		await env.DB.prepare('UPDATE post_stats SET views = views + 1, updated_at = CURRENT_TIMESTAMP WHERE slug = ?')
			.bind(slug)
			.run();
		return responseJson(await readStats(env.DB, slug, visitorId));
	}

	const hash = await visitorHash(slug, visitorId);
	const existing = await env.DB
		.prepare('SELECT 1 FROM post_likes WHERE slug = ? AND visitor_hash = ?')
		.bind(slug, hash)
		.first();

	if (existing) {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM post_likes WHERE slug = ? AND visitor_hash = ?').bind(slug, hash),
			env.DB.prepare('UPDATE post_stats SET likes = MAX(0, likes - 1), updated_at = CURRENT_TIMESTAMP WHERE slug = ?').bind(slug),
		]);
	} else {
		await env.DB.batch([
			env.DB.prepare('INSERT INTO post_likes (slug, visitor_hash) VALUES (?, ?)').bind(slug, hash),
			env.DB.prepare('UPDATE post_stats SET likes = likes + 1, updated_at = CURRENT_TIMESTAMP WHERE slug = ?').bind(slug),
		]);
	}

	return responseJson(await readStats(env.DB, slug, visitorId));
};
