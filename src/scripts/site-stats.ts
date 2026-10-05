async function updateSiteStats() {
	const counter = document.querySelector<HTMLElement>('[data-site-view-count]');
	const path = window.location.pathname.replace(/\/+$/, '') + '/';
	const article = Boolean(document.querySelector('[data-post-stats]'));
	const key = `king-of-water:site-view:${path}:${new Date().toISOString().slice(0, 10)}`;
	let counted = false;
	let storageAvailable = true;
	try { counted = localStorage.getItem(key) === '1'; }
	catch { storageAvailable = false; }
	// Without local storage, read totals only rather than count every refresh.
	const record = !article && storageAvailable && !counted;
	if (!record && !counter) return;
	try {
		const response = await fetch('/api/site-stats', record ? {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path }),
		} : undefined);
		if (!response.ok) throw new Error('statistics unavailable');
		const stats = await response.json();
		if (!Number.isSafeInteger(stats.views) || stats.views < 0) throw new Error('invalid statistics');
		if (record) {
			try { localStorage.setItem(key, '1'); } catch { /* Storage may become unavailable. */ }
		}
		if (counter) counter.textContent = stats.views.toLocaleString('zh-CN');
	} catch {
		if (counter) {
			counter.textContent = '暂不可用';
			counter.closest('[data-site-views]')?.setAttribute('title', '统计服务暂不可用，请稍后刷新');
		}
	}
}

void updateSiteStats();
