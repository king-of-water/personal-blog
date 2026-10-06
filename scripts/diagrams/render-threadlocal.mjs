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
  writeFileSync(fileURLToPath(new URL(`../../public/images/posts/threadlocal-${name}.svg`, import.meta.url)), svg);
  console.log(`${name}: 780 × ${height}`);
}

save('request-reuse', '同一个工作线程：请求结束不等于绑定结束', '路径 A 设置 user-A 后不清理，路径 B 同线程读取到 user-A；finally 清理后下一次读取才没有旧用户。', 365,
  text(25, 77, '没有清理', 18, 'start') +
  box(25, 95, 205, 68, ['请求 A', 'set(user-A)']) +
  box(290, 95, 205, 68, ['A 结束', '工作线程继续存活']) +
  box(555, 95, 200, 68, ['请求 B：get', '读到 user-A'], 'bad') +
  arrow('M230,129 H290') + arrow('M495,129 H555') +
  text(25, 215, '顶层范围 finally 清理', 18, 'start') +
  box(25, 233, 205, 68, ['请求 A', 'set(user-A)']) +
  box(290, 233, 205, 68, ['A 结束', 'finally remove']) +
  box(555, 233, 200, 68, ['请求 B：get', '没有旧用户'], 'good') +
  arrow('M230,267 H290') + arrow('M495,267 H555') +
  text(25, 344, '不需要 GC：ThreadLocal key 仍然有效，也会发生串用。', 18, 'start'));

save('retention-paths', '引用链：key 变弱，不会让 value 同时变弱', '工作线程经由 ThreadLocalMap、Entry 数组和 Entry 强引用业务 value，Entry 弱引用 ThreadLocal key；key 有效和 key 失效都可能留下过期业务值。', 355,
  box(25, 83, 155, 70, ['工作线程']) +
  box(215, 83, 175, 70, ['ThreadLocalMap', 'Entry 数组']) +
  box(425, 83, 145, 70, ['Entry']) +
  box(610, 83, 145, 70, ['业务 value']) +
  arrow('M180,118 H215') + arrow('M390,118 H425') + arrow('M570,118 H610') +
  box(388, 235, 220, 64, ['ThreadLocal key']) +
  '<path d="M497,153 V235" fill="none" stroke="#8a7f6d" stroke-width="1.5" stroke-dasharray="5 5" marker-end="url(#arrow)"/>' +
  text(576, 200, '弱引用', 18) +
  text(25, 198, '实线：强引用', 18, 'start') +
  text(25, 333, 'key 有效：业务主动结束绑定；key 失效：后续表操作可能清理。', 18, 'start'));

save('context-transfer', '异步传播：提交时捕获，执行后恢复', '提交方捕获不可变上下文并包装任务；执行方保存旧值，安装快照执行任务，无论正常返回还是异常，finally 恢复旧值或移除。', 385,
  box(25, 80, 205, 64, ['提交方读取 CURRENT', '捕获小型快照']) +
  box(290, 80, 205, 64, ['包装任务', '提交执行器']) +
  box(550, 80, 205, 64, ['实际执行线程', '保存 previous']) +
  arrow('M230,112 H290') + arrow('M495,112 H550') +
  box(550, 230, 205, 68, ['安装快照', '执行 action']) +
  arrow('M652,144 V230') +
  box(270, 230, 225, 68, ['finally', '恢复 previous / 移除']) +
  arrow('M550,264 H495') + text(500, 210, '正常或异常', 18) +
  text(25, 355, 'CallerRuns 也适用：不能误删提交线程原有的外层上下文。', 18, 'start'));
