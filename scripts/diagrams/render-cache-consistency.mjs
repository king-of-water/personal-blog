import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Compact native SVG layout, adapted from documd-visuals connector overlays.
// Editorial palette; every figure is a process, not a component inventory.
const ink = '#2b2620', line = '#8a7f6d', ground = '#fdfaf3';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x, y, value, size = 20, anchor = 'middle') =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" fill="${ink}">${escape(value)}</text>`;
const box = (x, y, w, h, labels, kind = '') => {
  const fill = kind === 'good' ? '#dee3d6' : kind === 'bad' ? '#eed9d3' : '#f5f0e4';
  const border = kind === 'good' ? '#466b48' : kind === 'bad' ? '#943b37' : line;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" stroke="${border}"/>` +
    labels.map((label, i) => text(x + w / 2, y + h / 2 + 7 + (i - (labels.length - 1) / 2) * 25, label)).join('');
};
const arrow = d => `<path d="${d}" fill="none" stroke="${line}" stroke-width="1.5" marker-end="url(#arrow)"/>`;
const diamond = (cx, cy, w, h, label) => `<path d="M${cx},${cy - h / 2} L${cx + w / 2},${cy} L${cx},${cy + h / 2} L${cx - w / 2},${cy} Z" fill="#ebe4d4" stroke="${line}"/>${text(cx, cy + 7, label)}`;
function save(name, title, desc, height, content) {
  if (content.includes('undefined')) throw new Error(`Missing diagram label: ${name}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="${height}" viewBox="0 0 780 ${height}" role="img" aria-labelledby="title desc"><title id="title">${escape(title)}</title><desc id="desc">${escape(desc)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="${line}"/></marker></defs><rect width="780" height="${height}" fill="${ground}"/>${text(26, 35, title, 22, 'start')}${content}</svg>\n`;
  writeFileSync(fileURLToPath(new URL(`../../public/images/posts/cache-consistency-${name}.svg`, import.meta.url)), svg);
  console.log(`${name}: 780 × ${height}`);
}

save('read', '读取流程：命中与回填是两条路径', '读取缓存，命中则返回；未命中则查询数据库、回填并设置 TTL，再返回查询结果。', 320,
  box(35, 85, 160, 60, ['读取缓存 key']) + diamond(300, 115, 130, 80, '命中？') +
  box(465, 85, 260, 60, ['返回缓存值'], 'good') + arrow('M195,115 H235') + arrow('M365,115 H465') + text(405, 99, '是', 18) +
  box(210, 210, 185, 65, ['查询数据库', '得到 v41']) + box(435, 210, 180, 65, ['回填 + TTL']) +
  arrow('M300,155 V210') + text(323, 189, '否', 18) + arrow('M395,242 H435') +
  arrow('M615,242 H715') + text(711, 227, '返回', 18) + text(711, 259, '查询结果', 18));

function sequence(name, title, desc, roles, steps, footer) {
  const xs = [100, 290, 490, 680];
  const height = 170 + steps.length * 48;
  let content = roles.map((role, i) => box(xs[i] - 69, 57, 138, 42, [role]) +
    `<path d="M${xs[i]},101 V${height - 60}" stroke="${line}" stroke-dasharray="5 5"/>`).join('');
  steps.forEach(([from, to, label], i) => {
    const y = 135 + i * 48;
    const x1 = xs[from], x2 = xs[to];
    content += arrow(`M${x1},${y} H${x2}`) + text((x1 + x2) / 2, y - 10, label, 18);
  });
  content += box(35, height - 48, 710, 36, [footer], 'bad');
  save(name, title, desc, height, content);
}
sequence('delete-first', '先删缓存：旧值在提交前被重新装回', '写者删除缓存，读者未命中并读取数据库 v41，回填 v41 后写者才提交 v42。',
  ['写请求 W', '读请求 R', '数据库', '缓存'],
  [[0, 3, '1. DEL v41'], [1, 3, '2. GET：miss'], [1, 2, '3. 查询 → 返回 v41'], [1, 3, '4. SET v41'], [0, 2, '5. COMMIT v42']],
  '最终：数据库 v42，缓存 v41；提交后没有再次失效');
sequence('update-race', '直接更新缓存：两次写入的顺序倒转', 'A 提交 v42 后暂停，B 提交 v43 并更新缓存，A 恢复后写回 v42。',
  ['写请求 A', '写请求 B', '数据库', '缓存'],
  [[0, 2, '1. COMMIT v42；A 暂停'], [1, 2, '2. COMMIT v43'], [1, 3, '3. SET v43'], [0, 3, '4. A 恢复：SET v42']],
  '数据库：42 → 43；缓存：43 → 42，发生版本倒退');
sequence('stale-fill', '先写库再删除：旧读仍能在删除后回填', 'R 未命中并读到 v41 后暂停，W 提交 v42 并成功删除缓存，R 随后回填旧值 v41。',
  ['读请求 R', '写请求 W', '数据库', '缓存'],
  [[0, 3, '1. GET：miss'], [0, 2, '2. 查询 → v41；R 暂停'], [1, 2, '3. COMMIT v42'], [1, 3, '4. DEL 成功'], [0, 3, '5. R 恢复：SET v41']],
  '删除成功也不能撤销读请求已经拿到的旧快照');

save('outbox', '可靠失效：提交留下事件，失败保留重试', '同一数据库事务更新数据并写事件，提交失败则回滚；提交成功后 Worker 删除缓存，删除失败或超时保留事件重试。', 450,
  box(30, 76, 260, 65, ['同一数据库事务', '更新 v42 + 写事件']) + diamond(390, 108, 140, 90, '提交？') +
  box(535, 78, 215, 60, ['回滚，无事件'], 'bad') + arrow('M290,108 H320') + arrow('M460,108 H535') + text(497, 94, '否', 18) +
  box(260, 197, 260, 60, ['Worker 处理事件', '删除缓存 key']) + arrow('M390,153 V197') + text(414, 182, '是', 18) +
  text(172, 185, '写入确认已返回', 18) + diamond(390, 328, 170, 88, '删除确认？') + arrow('M390,257 V284') +
  box(555, 299, 190, 60, ['标记已处理'], 'good') + arrow('M475,328 H555') + text(511, 313, '是', 18) +
  box(30, 291, 235, 75, ['保留事件，退避重试', '积压告警 / 接管'], 'bad') + arrow('M305,328 H265') + text(230, 279, '否 / 超时', 18) +
  arrow('M147,291 V226 H260') + text(147, 402, '下一次尝试仍来自可恢复记录', 18, 'start'));

save('version-gate', '回填资格：空缓存也要记住版本水位', 'floor=42 已生效且低版本值已清理，候选在同一原子操作内与 floor 和当前值版本比较，低版本候选被拒绝。', 360,
  box(30, 75, 225, 65, ['floor 已推进到 42', '低版本值已清除']) + box(310, 75, 225, 65, ['旧 loader', '尝试回填 v41']) + arrow('M255,107 H310') +
  diamond(423, 230, 215, 100, '版本满足门槛？') + arrow('M423,140 V180') + text(630, 173, '读取 floor 与当前版本', 18) + text(630, 200, '比较和写入不可交错', 18) +
  box(35, 200, 225, 65, ['拒绝回填', '需要新值则重查'], 'bad') + arrow('M315,230 H260') + text(285, 211, '否', 18) +
  box(580, 240, 170, 65, ['写入候选', '并设置 TTL'], 'good') + arrow('M530,230 H552 V272 H580') + text(557, 219, '是', 18) +
  text(35, 330, '前提：水位可靠存在；缺失水位不能直接当成版本零', 18, 'start'));

save('double-delete', '延迟双删：第二次删除能否赶上旧回填', '两条路径都先删除缓存并提交 v42；旧回填在第二次删除之前完成则被清除，在第二次删除之后完成则仍留下旧值。', 370,
  text(30, 68, '共同前提：DEL① → COMMIT v42；旧读已经拿到 v41', 18, 'start') +
  text(30, 102, '路径 A：旧回填先完成', 18, 'start') +
  box(30, 117, 200, 65, ['旧读回填 v41']) + box(290, 117, 200, 65, ['延迟 DEL②']) +
  box(550, 117, 200, 65, ['缓存为空', '下次读回源'], 'good') + arrow('M230,149 H290') + arrow('M490,149 H550') +
  text(30, 228, '路径 B：旧读暂停得更久', 18, 'start') +
  box(30, 243, 200, 65, ['延迟 DEL②']) + box(290, 243, 200, 65, ['旧读回填 v41']) +
  box(550, 243, 200, 65, ['缓存 v41', '旧值仍然存在'], 'bad') + arrow('M230,275 H290') + arrow('M490,275 H550') +
  text(30, 346, '固定延迟不能证明所有旧读都已结束', 18, 'start'));

save('binlog-invalidate', 'binlog 同步：删除确认之后才能确认消费', '提交后的有效变更被订阅、可靠投递，消费者映射缓存键并删除；失败或超时保留事件重试，删除确认后才确认消费位置。', 435,
  box(30, 80, 210, 60, ['事务提交 v42', 'binlog 有效变更']) +
  box(285, 80, 210, 60, ['订阅并解析', '可靠投递事件']) +
  box(540, 80, 210, 60, ['消费者映射 key', '执行 DEL']) +
  arrow('M240,110 H285') + arrow('M495,110 H540') +
  diamond(645, 230, 160, 90, '删除确认？') + arrow('M645,140 V185') +
  box(285, 197, 210, 65, ['保留未确认事件', '退避重试'], 'bad') +
  arrow('M565,230 H495') + text(530, 211, '否 / 超时', 18) +
  arrow('M390,197 V170 H520 V110 H540') +
  box(540, 325, 210, 65, ['确认消费位置', '后续读 miss 回源'], 'good') +
  arrow('M645,275 V325') + text(674, 309, '是', 18) +
  text(30, 416, '订阅投递位点 ≠ 缓存消费完成位点', 18, 'start'));

save('version-invalidate', '版本失效：推进门槛，但不误删更高版本', '事件 v42 到达后原子推进 floor 到至少 42，仅删除低于门槛的已有值，保留空缓存或更高版本值。', 355,
  box(30, 75, 225, 65, ['收到事件 v42', '当前 floor = 41']) +
  box(310, 75, 225, 65, ['floor = max(41, 42)', '门槛推进到 42']) + arrow('M255,107 H310') +
  diamond(423, 230, 210, 100, '存在低版本值？') + arrow('M423,140 V180') +
  box(35, 200, 220, 65, ['删除旧值 v41'], 'bad') + arrow('M318,230 H255') + text(285, 211, '是', 18) +
  box(580, 200, 170, 65, ['保留空缓存', '或 v42 / v43'], 'good') + arrow('M528,230 H580') + text(554, 211, '否', 18) +
  text(35, 329, '推进门槛与清理低版本值：同一个不可交错的操作', 18, 'start'));
