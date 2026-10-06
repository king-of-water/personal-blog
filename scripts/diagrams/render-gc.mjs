import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Native SVG connector overlays adapted from documd-visuals, Editorial theme.
const ink = '#2b2620', line = '#8a7f6d';
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x, y, value, size = 19, anchor = 'middle') =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" fill="${ink}">${esc(value)}</text>`;
const box = (x, y, w, h, labels, accent = false) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${accent ? '#d8dee0' : '#f5f0e4'}" stroke="${accent ? '#295279' : line}"/>` +
  labels.map((label, i) => text(x + w / 2, y + h / 2 + 6 + (i - (labels.length - 1) / 2) * 24, label)).join('');
const arrow = (d, dashed = false) => `<path d="${d}" fill="none" stroke="${line}" stroke-width="1.5" ${dashed ? 'stroke-dasharray="5 5"' : ''} marker-end="url(#arrow)"/>`;
function save(name, title, desc, height, content) {
  if (content.includes('undefined')) throw new Error(`Missing label: ${name}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="${height}" viewBox="0 0 780 ${height}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">${esc(desc)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="${line}"/></marker></defs><rect width="780" height="${height}" fill="#fdfaf3"/>${text(24, 34, title, 22, 'start')}${content}</svg>\n`;
  writeFileSync(fileURLToPath(new URL(`../../public/images/posts/gc-${name}.svg`, import.meta.url)), svg);
  console.log(`${name}: 780 × ${height}`);
}

save('request-lifetime', '请求结束后：检查所有强引用路径', '请求栈、缓存和异步队列都可以持有查询结果。请求返回只断开栈路径，缓存与排队任务仍能让结果存活；全部强路径断开后才具备回收条件。', 325,
  box(24, 72, 155, 65, ['请求栈', '有效局部引用']) +
  box(24, 177, 155, 65, ['运行时入口', '静态持有者']) +
  box(265, 72, 185, 65, ['订单缓存', '尚未删除的条目']) +
  box(265, 177, 185, 65, ['异步队列', '捕获结果的任务']) +
  box(560, 126, 195, 65, ['查询结果', '及响应缓冲'], true) +
  arrow('M179,104 H220 V59 H657 V126', true) +
  arrow('M179,209 H223 V104 H265') + arrow('M223,209 H265') +
  arrow('M450,104 H505 V147 H560') + arrow('M450,209 H505 V171 H560') +
  text(24, 280, '虚线：请求返回后断开的路径；实线：仍然存在的强路径。', 17, 'start') +
  text(24, 307, '移除一个持有者，不能替代检查其他持有者。', 17, 'start'));

const cell = (x, y, label, live = false) =>
  `<rect x="${x}" y="${y}" width="72" height="42" fill="${live ? '#d8dee0' : '#f5f0e4'}" stroke="${line}"/>${text(x + 36, y + 27, label, 17)}`;
const row = (x, y, values) => values.map((value, i) => cell(x + 72 * i, y, value, value === 'A' || value === 'C')).join('');
save('space-reclamation', '同一组对象：A、C 存活，B、D 已不可达', '标记清除留下分散空闲块；复制把 A、C 搬到目标区域后释放来源；整理将来源范围内的 A、C 紧凑排列。格子是等宽示意，不表示真实对象等大或 JVM 必须采用半空间布局。', 425,
  text(24, 83, '原布局', 18, 'start') + row(150, 57, ['A', 'B', 'C', 'D']) +
  text(24, 158, '标记清除', 18, 'start') + row(150, 132, ['A', '空', 'C', '空']) +
  text(470, 158, '不移动，空闲块分散', 18, 'start') +
  text(24, 245, '复制', 18, 'start') + row(150, 217, ['空', '空', '空', '空']) +
  arrow('M445,238 H478') + row(485, 217, ['A', 'C']) +
  text(294, 284, '来源释放', 17) + text(557, 284, '另一个目标区', 17) +
  text(24, 351, '标记整理', 18, 'start') + row(150, 325, ['A', 'C', '空', '空']) +
  text(470, 351, '原范围内重新排列', 18, 'start') +
  text(24, 405, '蓝色表示存活对象；目标空间比例由具体实现决定。', 17, 'start'));

save('g1-cycle', 'G1：先得到存活信息，再分批释放老年代区域', '年轻代回收阶段通过 Concurrent Start 启动并发标记，随后 Remark、Cleanup 确定信息并进入 Mixed 回收。疏散失败且不能维持分配时可能进入 Full GC。该图省略中间继续发生的 Young GC。', 455,
  box(24, 75, 213, 68, ['Young GC', 'STW：疏散年轻代']) +
  box(285, 75, 213, 68, ['Concurrent Start', 'STW：启动标记']) +
  box(546, 75, 210, 68, ['并发标记', '业务线程继续执行'], true) +
  arrow('M237,109 H285') + arrow('M498,109 H546') +
  arrow('M651,143 V221') +
  box(546, 221, 210, 68, ['Remark / Cleanup', '确定存活与候选区']) +
  box(285, 221, 213, 68, ['多次 Mixed GC', 'STW：年轻代 + 部分 Old']) +
  arrow('M546,255 H498') + arrow('M285,255 H130 V143') +
  text(143, 213, '本轮回收完成', 17) +
  arrow('M391,289 V344', true) +
  box(285, 344, 213, 60, ['可能 Full GC', 'STW：整堆整理']) +
  text(527, 329, '疏散失败且空间仍不足', 17) +
  text(24, 435, '简化周期：并发标记期间仍可发生 Young GC；暂停目标不是硬上限。', 17, 'start'));
