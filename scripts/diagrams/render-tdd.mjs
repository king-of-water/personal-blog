import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Connector-overlay layout adapted from documd-visuals, Editorial palette.
const ink = '#2b2620', line = '#8a7f6d';
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x, y, value, size = 19, anchor = 'middle') =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" fill="${ink}">${esc(value)}</text>`;
const box = (x, y, w, h, labels, kind = 'neutral') => {
  const colors = { neutral: ['#f5f0e4', line], accent: ['#d8dee0', '#295279'], failure: ['#eed9d3', '#943b37'] };
  const [fill, stroke] = colors[kind];
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}"/>` +
    labels.map((label, i) => text(x + w / 2, y + h / 2 + 6 + (i - (labels.length - 1) / 2) * 24, label)).join('');
};
const arrow = (d, dashed = false) => `<path d="${d}" fill="none" stroke="${line}" stroke-width="1.5" ${dashed ? 'stroke-dasharray="5 5"' : ''} marker-end="url(#arrow)"/>`;
function save(name, title, desc, height, content) {
  if (content.includes('undefined')) throw new Error(`Missing label: ${name}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="${height}" viewBox="0 0 780 ${height}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">${esc(desc)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="${line}"/></marker></defs><rect width="780" height="${height}" fill="#fdfaf3"/>${text(24, 34, title, 22, 'start')}${content}</svg>\n`;
  writeFileSync(fileURLToPath(new URL(`../../public/images/posts/tdd-${name}.svg`, import.meta.url)), svg);
  console.log(`${name}: 780 × ${height}`);
}

save('feedback-loop', 'TDD：一次选择一个具体行为', '从场景清单选一个行为，写测试并确认目标断言失败。环境或测试发现错误先修复验证条件。最小实现使新增与相关旧测试通过，再重构并复查，回到场景清单。', 425,
  box(24, 76, 210, 70, ['场景清单', '选择一个行为']) +
  box(284, 76, 210, 70, ['写测试并执行', '确认失败原因'], 'accent') +
  box(544, 76, 212, 70, ['停止：先修复', '环境 / 测试发现'], 'failure') +
  arrow('M234,111 H284') + arrow('M494,111 H544', true) +
  text(650, 65, '不是目标行为失败', 16) +
  box(284, 211, 210, 70, ['Green：最小实现', '新增与旧测试通过']) +
  arrow('M389,146 V211') + text(410, 180, 'Red：目标断言失败', 17, 'start') +
  box(24, 211, 210, 70, ['Refactor：整理结构', '复查行为仍然通过']) +
  arrow('M284,246 H234') + arrow('M129,211 V146') +
  box(544, 211, 212, 70, ['相关测试仍失败', '继续定位与实现']) +
  arrow('M494,246 H544', true) +
  text(24, 337, '实线：正常循环；虚线：未满足推进条件。', 18, 'start') +
  text(24, 373, '需求有冲突时先确认规则，不改预期去迁就实现。', 18, 'start') +
  text(24, 405, '重构后测试不通过：先定位回归，不推进下一个行为。', 17, 'start'));

save('sdd-loops', '功能层面的 SDD，任务内部的 TDD', '规格确认需求，方案确定边界，任务内用失败测试、实现、重构循环推进，最后整体验收。技术发现返回方案，需求变化返回规格确认。TDD 是建议组合，不是 SDD 的强制步骤。', 414,
  box(24, 77, 210, 70, ['Spec：确认规则', '状态 / 幂等 / 范围'], 'accent') +
  box(284, 77, 210, 70, ['Plan → Tasks', '边界与任务拆分']) +
  box(544, 77, 212, 70, ['Converge：验收', '链路与未覆盖风险']) +
  arrow('M234,112 H284') +
  box(284, 223, 210, 80, ['任务内 TDD', '失败 → 实现 → 重构'], 'accent') +
  arrow('M389,147 V223') + arrow('M494,263 H650 V147') +
  arrow('M284,263 H129 V147', true) +
  text(145, 235, '需求变化先确认', 17, 'start') +
  text(24, 350, '技术发现回写 Plan；业务规则变化回到 Spec。', 18, 'start') +
  text(24, 387, '整体验收不能只用任务内的单元测试结果替代。', 18, 'start'));
