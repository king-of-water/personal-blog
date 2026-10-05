const json = (data, status = 200) => new Response(JSON.stringify(data), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const totalViews = async (db) => {
	const stats = await db.prepare('SELECT COALESCE(SUM(views), 0) AS views FROM post_stats').first();
	return { views: stats.views };
};

export const onRequestGet = async ({ env }) => {
	if (!env.DB) return json({ error: 'statistics database is not configured' }, 503);
	return json(await totalViews(env.DB));
};

export const onRequestPost = async ({ env, request }) => {
	if (!env.DB) return json({ error: 'statistics database is not configured' }, 503);
	let payload;
	try { payload = await request.json(); }
	catch { return json({ error: 'invalid request body' }, 400); }
	// Article views already use /api/stats/:slug; never count them twice here.
	const path = payload?.path;
	if (typeof path !== 'string' || path.length > 160 ||
		!/^\/(?:|(?:about|projects|toolbox|industry|posts)\/|(?:backend|agent)\/(?:[a-z0-9-]+\/)?)$/.test(path)) {
		return json({ error: 'invalid page path' }, 400);
	}
	// Reserved row cannot collide with a valid article slug. Reuse the existing DB
	// binding and schema, preserving all historical article views without migration.
	await env.DB.prepare(`INSERT INTO post_stats (slug, views) VALUES ('@site-pages', 1)
		ON CONFLICT(slug) DO UPDATE SET views = views + 1, updated_at = CURRENT_TIMESTAMP`).run();
	return json(await totalViews(env.DB));
};
