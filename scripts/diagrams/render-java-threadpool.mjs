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
  writeFileSync(fileURLToPath(new URL(`../../public/images/posts/java-threadpool-${name}.svg`, import.meta.url)), svg);
  console.log(`${name}: 780 × ${height}`);
}

save('flow', 'execute：新建、入队、扩容、拒绝', '少于核心数量时尝试新建；否则尝试入队并复查状态；入队失败则尝试按最大数量新建，仍失败则拒绝。', 550,
  diamond(270, 115, 280, 90, '按 core 新建成功？') +
  box(550, 85, 200, 60, ['执行首次任务'], 'good') +
  arrow('M410,115 H550') + text(480, 100, '是', 18) +
  diamond(270, 245, 280, 90, '运行且入队成功？') +
  arrow('M270,160 V200') + text(295, 185, '否', 18) +
  box(550, 212, 200, 66, ['复查关闭状态', '必要时尝试补线程']) +
  arrow('M410,245 H550') + text(480, 230, '是', 18) +
  diamond(270, 375, 280, 90, '按 max 新建成功？') +
  arrow('M270,290 V330') + text(295, 315, '否', 18) +
  box(550, 345, 200, 60, ['执行首次任务'], 'good') +
  arrow('M410,375 H550') + text(480, 360, '是', 18) +
  box(155, 460, 230, 54, ['调用拒绝处理器'], 'bad') +
  arrow('M270,420 V460') + text(295, 445, '否', 18) +
  text(26, 540, '已关闭且能移除刚入队任务时，同样进入拒绝处理器。', 18, 'start'));

save('results', '任务失败后：异常退出，还是保存进 Future', '直接执行普通 Runnable 的未捕获异常导致工作线程退出；submit 默认包装的 FutureTask 保存失败，通过 get 和 afterExecute 检查。', 350,
  box(25, 80, 155, 74, ['execute', '普通 Runnable']) +
  box(217, 80, 155, 74, ['run 抛异常']) +
  box(410, 80, 155, 74, ['工作线程退出'], 'bad') +
  box(602, 80, 155, 74, ['未捕获异常', '处理器']) +
  arrow('M180,117 H217') + arrow('M372,117 H410') + arrow('M565,117 H602') +
  box(25, 220, 155, 74, ['submit', 'FutureTask']) +
  box(217, 220, 155, 74, ['run 保存失败']) +
  box(410, 220, 155, 74, ['工作线程复用'], 'good') +
  box(602, 220, 155, 74, ['get 报告失败', '钩子可以观察']) +
  arrow('M180,257 H217') + arrow('M372,257 H410') + arrow('M565,257 H602') +
  text(25, 330, '前提：普通工作线程执行；任务包装和 CallerRuns 会改变异常路径。', 18, 'start'));

save('schedule', '定时任务：到期取出，周期成功后重新排队', '任务包装后进入延迟队列，到期且有工作线程才能执行；成功的周期任务计算下一次时间并重新入队，单次完成或异常则结束 Future。', 450,
  box(25, 80, 195, 64, ['包装任务', '记录触发时间']) +
  box(285, 80, 195, 64, ['进入延迟队列']) +
  box(545, 80, 195, 64, ['到期且有线程', '取出任务']) +
  arrow('M220,112 H285') + arrow('M480,112 H545') +
  box(25, 228, 195, 64, ['执行任务']) +
  arrow('M642,144 V183 H122 V228') +
  diamond(383, 260, 245, 100, '周期且成功？') +
  arrow('M220,260 H260') +
  box(545, 228, 195, 64, ['计算下一次时间', '重新入队']) +
  arrow('M505,260 H545') + text(525, 244, '是', 18) +
  arrow('M740,260 H760 V58 H382 V80') +
  box(258, 365, 250, 64, ['单次结束或异常', '记录 Future 状态']) +
  arrow('M383,310 V365') + text(408, 345, '否', 18));
