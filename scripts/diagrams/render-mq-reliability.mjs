import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Native SVG connector overlay, adapted from documd-visuals request paths.
const ink = '#2b2620', line = '#8a7f6d';
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x, y, s, size = 19, anchor = 'middle') => `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${ink}">${esc(s)}</text>`;
const box = (x, y, w, h, labels, kind = 'neutral') => {
  const [fill, stroke] = { neutral: ['#f5f0e4', line], accent: ['#d8dee0', '#295279'], failure: ['#eed9d3', '#943b37'], success: ['#dee3d6', '#466b48'] }[kind];
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}"/>` + labels.map((s, i) => text(x+w/2, y+h/2+6+(i-(labels.length-1)/2)*25, s)).join('');
};
const arrow = (d, dashed = false) => `<path d="${d}" fill="none" stroke="${line}" stroke-width="1.5" ${dashed ? 'stroke-dasharray="5 5"' : ''} marker-end="url(#arrow)"/>`;
function save(name, title, desc, height, content) {
  if(content.includes('undefined')) throw new Error(name);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="${height}" viewBox="0 0 780 ${height}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">${esc(desc)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="${line}"/></marker></defs><rect width="780" height="${height}" fill="#fdfaf3"/>${text(24,34,title,22,'start')}${content}</svg>\n`;
  writeFileSync(fileURLToPath(new URL(`../../public/images/posts/${name}.svg`, import.meta.url)), svg);
  console.log(name);
}

save('mq-reliability-responsibility', '确认交接责任，业务记录保留恢复依据', '支付和 Outbox 同事务提交，发送器等待 Broker 确认后标记已发布。消费者先提交发券结果再确认。发送确认不等于发券完成。', 425,
  box(24,80,210,80,['支付 + Outbox','同一事务提交'],'accent') + box(284,80,210,80,['发送器','等待发送确认']) + box(544,80,212,80,['Broker 接收','耐久依配置而定']) + arrow('M234,120 H284') + arrow('M494,120 H544') +
  arrow('M650,160 V208 H389 V160',true) + text(389,198,'收到确认才标记已发布',17) +
  box(544,256,212,80,['消费者','收到支付事件']) + box(284,256,210,80,['券数据库','发券结果已提交'],'success') + box(24,256,210,80,['消费确认','宣告处理完成']) + arrow('M650,160 V256') + arrow('M544,296 H494') + arrow('M284,296 H234') +
  text(24,385,'发送未知：Outbox 重发；消费确认未知：重投后查幂等结果。',18,'start'));

save('mq-reliability-consume-confirm', '业务先提交，重复由持久结果收敛', '收到事件后提交发券事务，随后确认。提交前崩溃则重试；提交后确认前崩溃则重投并读取已有结果。先确认再执行业务会留下遗漏窗口。', 405,
  box(24,80,210,75,['收到事件','业务尚未完成']) + box(284,80,210,75,['发券数据库事务','提交成功'],'success') + box(544,80,212,75,['发送 ACK','或提交消费进度']) + arrow('M234,117 H284') + arrow('M494,117 H544') +
  box(24,243,210,80,['提交前崩溃','回滚后重试'],'failure') + box(284,243,210,80,['提交后、ACK 前崩溃','重投后查已有结果'],'accent') + box(544,243,212,80,['错误：先 ACK','再执行发券'],'failure') + arrow('M129,155 V243',true) + arrow('M389,155 V243',true) +
  text(24,373,'异步线程入队不等于持久完成，不能据此提前返回成功。',18,'start'));

save('mq-reliability-recovery', '同一订单的三次恢复，始终使用原业务键', '支付后未发送由 Outbox 恢复；发送确认丢失重发同一事件；消费确认丢失重投并读取发券结果。对账核对业务应发与实发。', 480,
  box(24,80,265,80,['支付已提交，尚未发送','Outbox = PENDING']) + box(395,80,361,80,['扫描发送原事件','等待符合契约的发送确认'],'accent') + arrow('M289,120 H395') +
  box(24,205,265,80,['Broker 已接收，确认未知','Outbox 仍待发送']) + box(395,205,361,80,['重发同一事件','重复由业务唯一约束处理'],'accent') + arrow('M289,245 H395') +
  box(24,330,265,80,['券已提交，消费确认未知','存在成功发放结果']) + box(395,330,361,80,['重投后读取成功结果','不再发券，完成消费确认'],'success') + arrow('M289,370 H395') +
  text(24,450,'业务对账：核对应发与实发，发现已确认但业务遗漏的情况。',18,'start'));

save('mq-selection-positioning', '先比较消费模型，再比较实现与配置', 'Kafka 以日志和消费位点组织数据，RocketMQ 提供日志存储及业务消息语义，RabbitMQ 提供交换机路由与多种队列模型。RabbitMQ Streams 支持日志回放，不能一概称为消费即删。', 325,
  box(24,80,230,155,['Kafka','分区日志与位点','保留期内重读','流处理与事件数据'],'accent') + box(275,80,230,155,['RocketMQ','日志存储 + 消息语义','事务 / 顺序 / 延迟','按版本与部署核对']) + box(526,80,230,155,['RabbitMQ','交换机与绑定路由','Queue / Quorum / Streams','模型不同，能力不同']) +
  text(24,280,'模型决定接口与恢复方式；吞吐需在相同耐久条件下衡量。',18,'start') + text(24,310,'确认、历史回放和业务完成是三个不同问题。',18,'start'));

save('mq-selection-decision', '从业务约束收敛候选，不用固定吞吐排名', '先判断路由、回放、事务、顺序和延迟要求，再确定确认与恢复契约，最后用同一消息大小、副本和负载条件评估容量与运维成本。', 420,
  box(24,80,732,70,['业务模型：任务路由 / 日志回放 / 顺序 / 延迟 / 事务']) + arrow('M390,150 V190') + box(24,190,732,70,['可靠性契约：确认边界 / 复制 / 保留 / 重试 / 幂等'],'accent') + arrow('M390,260 V300') + box(24,300,732,70,['容量与维护：消息大小 / 峰值 / 消费能力 / 存储 / 团队经验']) + text(24,404,'同一产品有多种部署和队列模型；候选需要按实际版本验证。',18,'start'));

save('rocketmq-transactional-message-flow', '4.x 事务消息：已知结果放行，未知结果继续回查', '半消息先被 Broker 按配置接收，随后执行本地事务。持久化提交结果使消息可见，明确回滚不投递，未知结果等待回查。回查次数和扫描受配置约束。', 490,
  box(24,80,210,75,['发送半消息','消费者不可见']) + box(284,80,210,75,['Broker 确认','耐久依存储配置']) + box(544,80,212,75,['执行本地事务','持久保存事务结果'],'accent') + arrow('M234,117 H284') + arrow('M494,117 H544') +
  box(24,250,210,80,['COMMIT','发布到业务 Topic'],'success') + box(284,250,210,80,['ROLLBACK','不投递给消费者'],'failure') + box(544,250,212,80,['UNKNOW / 确认丢失','查询持久事务结果'],'accent') + arrow('M650,155 V210 H129 V250') + arrow('M389,210 V250') + arrow('M650,210 V250') +
  text(24,386,'回查仍未知：在策略允许范围内继续等待，不把查无记录当回滚。',18,'start') + text(24,425,'超限按对应版本处理；4.9.8 默认监听器尝试转存专用 Topic。',18,'start') + text(24,462,'事务消息协调发布侧，不替代消费端的幂等、重试和业务对账。',18,'start'));

save('rocketmq-push-pull-long-polling', '4.x Remoting：长轮询在消息可读时响应', '消费者发出拉取请求，没有匹配消息时 Broker 挂起请求，消息可读或等待期限结束后再次检查并返回。可读不等于完成物理刷盘，5.x 消费模型另行区分。', 385,
  box(24,80,210,80,['客户端发起 PULL','带位点与等待参数']) + box(284,80,210,80,['Broker 检查','是否有匹配消息']) + box(544,80,212,80,['有消息','响应拉取请求'],'success') + arrow('M234,120 H284') + arrow('M494,120 H544') +
  box(284,242,210,80,['无消息：挂起请求','不阻塞专属业务线程'],'accent') + arrow('M389,160 V242') + arrow('M494,282 H650 V160',true) + text(650,225,'可读 / 等待到期',17) +
  text(24,366,'长轮询降低空查询；背压还需要 SDK 阈值与业务并发限制。',18,'start'));
