---
title: 秒杀系统设计：库存、排队、限流与防超卖
description: 从库存不变量和数据库条件更新出发，设计秒杀流量漏斗、Redis 原子预占、可靠排队、订单状态机、超时释放、热点拆分、反作弊、故障降级与库存对账。
category: 后端
subcategory: 系统设计与高并发
articleClass: flagship
seriesOrder: 100
publishedAt: 2026-09-30T20:33:00+08:00
tags: [秒杀, 系统设计, 库存, Redis, 消息队列, 限流, 幂等, 防超卖, 高并发]
---

一万件限量商品在整点开售，一百万个客户端同时点击。库存只有一万，系统没有理由让一百万个请求都进入订单数据库；但若入口过早拒绝、Redis 预扣丢失、消息队列重复投递或支付超时与关单同时发生，系统又会出现少卖、超卖、重复订单和长期冻结库存。

秒杀设计要回答的问题是：怎样让海量竞争逐层收敛为有限个可执行订单，并证明任意故障和重试下，确认售出的数量都不会超过可售库存？库存、排队、限流和订单状态机必须围绕同一份业务语义配合。Redis 原子脚本只能保证 Redis 内的一次操作，消息队列只能搬运已接受的请求，数据库条件更新才是最终库存边界之一。

本文沿用前面关于[容量评估](/posts/capacity-planning-qps-concurrency-latency-resource-budget/)、[消息削峰](/posts/message-queue-peak-shaving-backlog-consumer-capacity/)、[热点治理](/posts/hot-data-and-hot-accounts/)、[限流与背压](/posts/rate-limit-circuit-breaker-bulkhead-degradation-backpressure/)以及[幂等与结果未知](/posts/timeouts-retries-idempotency-exactly-once/)的结论，重点走完一次秒杀请求从入场到成单、支付或释放库存的全过程。

## 一、先定义什么算成功，什么算超卖

秒杀页面常出现“抢购成功”“排队中”“下单成功”和“支付成功”，它们对应不同承诺：

| 用户看到的状态 | 系统已经证明什么 | 尚未证明什么 |
| --- | --- | --- |
| 获得入场资格 | 请求通过前置流量控制 | 库存是否存在 |
| 排队中 | 请求已被可靠接收，后续可查询 | 一定能获得库存 |
| 预占成功 | 一份库存已绑定给该请求至过期时间 | 用户最终会付款 |
| 待支付 | 订单与库存预占已持久化 | 支付渠道成功 |
| 购买成功 | 支付确认，订单进入终态 | 后续履约是否完成 |

[RFC 9110 对 `202 Accepted` 的定义](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.3)正适合“已经接受、尚未完成”的异步语义：响应应告诉客户端当前状态，并提供状态查询地址。它不能被展示成购买成功，因为后续处理仍可能拒绝请求。

超卖也要用可检查的式子定义。假设活动可售量为 `sale_limit`：

```text
confirmed_paid + valid_reserved <= sale_limit
confirmed_paid <= physical_allocatable_stock
同一 (campaign_id, user_id) 最多有一个有效购买结果
```

第一条约束控制活动库存，第二条防止活动配置超过仓库实际可分配量，第三条表达一人一单。系统还要接受另一类损失：少卖。Redis 令牌丢失、预占未释放、某个分桶提前耗尽，都可能让还有实物的活动显示售罄。防超卖不能只盯住负库存，也要监控“库存去哪了”。

### 库存不是一个数字

生产系统至少会区分：

```text
physical_on_hand   仓库实物或可履约数量
sale_limit         本次活动允许售卖的上限
available          仍可预占
reserved           已预占、等待订单或支付
confirmed          已确认售出
released           超时、取消后归还
```

一个常用守恒关系是：

```text
sale_limit = available + reserved + confirmed
```

`released` 是累计流量，不在当前状态等式中；释放发生时 `reserved - 1`、`available + 1`。退款是否回到秒杀库存取决于活动规则，很多限时活动退款后不会重新放量。若业务没有先定义这条规则，技术系统无法自行决定把库存归还给谁。

## 二、百万请求先经过一条容量漏斗

假设活动库存 10,000，整点一秒到达 1,000,000 个请求，订单消费者稳定处理 5,000 条/s，用户可接受的排队时间最多 3 秒。入口允许的有效排队量不应超过：

```text
consumer_rate × max_queue_wait = 5,000 × 3 = 15,000
```

库存只有一万，考虑失败重试和少量无效请求后，系统可以把 admission 上限设在一万出头，而不是把剩余九十多万请求全部写入消息队列。排队长度必须同时受库存和等待时间约束。

![百万秒杀请求怎样收敛为有限订单](/images/posts/flash-sale-traffic-funnel.svg)

一条典型流量漏斗包含：

1. CDN 缓存活动页和静态资源，查看详情不进入交易集群。
2. 网关校验活动时间、登录态、签名、账号资格与粗粒度限流。
3. 每用户和设备去重，重复点击只查询原请求状态。
4. admission 层根据剩余库存、队列年龄和消费能力发放有限许可。
5. 获准请求进入库存预占与可靠排队，其他请求立即得到售罄或繁忙结果。

每层都应该减少后续工作。验证码、风控和资格服务若全部同步放在最深处，九十万个注定失败的请求仍会占用线程和连接。反过来，把最终库存只放在 CDN 或网关本地，又无法跨实例维持总量约束。

### 活动开始时间由服务端判定

前端倒计时用于体验，不能决定是否开售。客户端可以修改本地时钟，也可能提前构造接口。网关根据服务端活动配置判断时间窗口；配置提前预热到本地并带版本，避免整点时所有实例查询配置中心。

页面在开始前可以领取短期签名 permit，其中包含 `campaign_id`、用户、过期时间和随机 nonce。permit 减少无效请求，不能单独代表库存。服务端仍要校验签名、使用次数和活动状态，泄露或重放 permit 时也不能产生第二份订单。

## 三、先用数据库写出最小正确方案

流量尚未超过单行更新能力时，MySQL 条件更新是很好的起点：

```sql
UPDATE campaign_inventory
SET available = available - 1,
    reserved = reserved + 1,
    version = version + 1
WHERE campaign_id = :campaignId
  AND sku_id = :skuId
  AND available > 0;
```

受影响行数为 1 表示预占成功，为 0 表示没有可用库存。条件判断和扣减由一条 SQL 完成，不会出现两个事务都先读到 `available=1`，随后各自写成 0 的 check-then-act 竞态。

同一事务还要插入预占记录与订单：

```sql
BEGIN;

UPDATE campaign_inventory
SET available = available - 1,
    reserved = reserved + 1,
    version = version + 1
WHERE campaign_id = :campaignId
  AND sku_id = :skuId
  AND available > 0;

INSERT INTO inventory_reservation(
    reservation_id, campaign_id, sku_id, user_id,
    request_id, state, expire_at, created_at
) VALUES (
    :reservationId, :campaignId, :skuId, :userId,
    :requestId, 'RESERVED', :expireAt, NOW(3)
);

INSERT INTO orders(order_id, reservation_id, user_id, state, created_at)
VALUES (:orderId, :reservationId, :userId, 'PENDING_PAYMENT', NOW(3));

COMMIT;
```

`UNIQUE(campaign_id, user_id)` 防止一人多单，`UNIQUE(request_id)` 处理同一次请求重放。两个并发事务中，唯一约束和库存条件都处在同一事务内，任何一步失败都会回滚库存扣减。MySQL 的[锁定读文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)说明，`FOR UPDATE` 会锁住读到的索引记录；这里直接使用条件 `UPDATE`，减少一次读取和应用层计算。

该方案的瓶颈也很清楚：同一个活动 SKU 的更新落到同一行，请求在行锁上串行等待。数据库连接被等待者占满后，其他业务也会受影响。正确的下一步是先在入口砍掉无效流量，再判断是否需要 Redis 预占；不能因为“秒杀必须上 Redis”就跳过可验证的数据库基线。

## 四、Redis 预占解决吞吐，数据库保留最终护栏

极端活动中，可以把一份活动库存镜像预热到 Redis。请求到达后，Redis 原子逻辑同时完成四件事：检查请求是否处理过、检查用户是否已有资格、判断库存、扣减并记录预占。网络往返之间不能夹着应用层判断。

[Redis 可编程接口文档](https://redis.io/docs/latest/develop/programmability/)说明，脚本和函数在服务端原子执行，执行期间会阻塞其他活动。因此脚本应只做少量定长操作，不能在里面扫描大集合、访问网络或执行长循环。

```lua
-- KEYS use the same Redis Cluster hash tag: {campaignId:skuId}
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing then
  return {'DUPLICATE', existing}
end

if redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 1 then
  return {'ALREADY_RESERVED'}
end

local stock = tonumber(redis.call('GET', KEYS[3]) or '-1')
if stock <= 0 then
  return {'SOLD_OUT'}
end

redis.call('DECR', KEYS[3])
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('XADD', KEYS[4], '*',
  'requestId', ARGV[1], 'userId', ARGV[2],
  'reservationId', ARGV[3], 'expireAt', ARGV[4])
return {'ACCEPTED', ARGV[3]}
```

示例把请求结果 Hash、已预占用户 Set、库存计数和 admission Stream 放进同一 hash tag，使 Redis Cluster 将它们放在同一 slot。脚本原子地扣库存并写入后续命令，避免“库存已减、应用在发消息前崩溃”的本地窗口。代价是同一 SKU 的这些状态都集中到一个 Redis 主分片，这正是热点上限所在。

### Redis 原子不等于业务库存已经持久化

Redis 默认使用异步复制。官方[复制文档](https://redis.io/docs/latest/manual/replication/)指出，`WAIT` 可以等待副本确认，却不会把 Redis 变成具备强一致性的 CP 系统，故障切换和持久化配置仍可能导致已确认写丢失。Lua 原子性只覆盖一次脚本在当前主节点上的执行，也不包含 MySQL、Kafka 或支付系统。

因此 Redis 返回 `ACCEPTED` 时，接口最多承诺“进入预占处理”，不能直接展示购买成功。消费者仍需在数据库事务中执行条件扣减、插入唯一预占和订单。Redis 计数错误可能导致少放或多放候选请求，MySQL 条件更新阻止最终超卖。

如果业务承诺“返回排队中后请求绝不能丢”，需要把 admission 命令写入满足该持久性要求的日志后再响应。Redis Stream 可以与扣减处于同一 Redis 原子边界，但它的耐久性仍由 Redis 复制和 AOF 配置决定；转发 Kafka 又会产生跨系统双写。系统要么接受并量化该风险，要么增加持久 admission 记录，不能用“用了 Stream”替代承诺说明。

### 计数模式和库存令牌模式

计数模式只保存 `available=10000`，每次原子减一，内存开销小。令牌模式预先放入一万个唯一 token，成功请求原子取走一个，预占记录保存 token ID。令牌更容易追踪“哪一份库存被谁占用”，也便于对账和精确释放；初始化、存储和批量迁移更复杂。

无论使用哪一种，释放操作都要先把 reservation 从 `RESERVED` 条件推进到 `RELEASED`，再把计数或 token 归还。重复超时消息不能重复加库存。Redis 与数据库各有一份计数时，定期对账必须以持久预占和订单事实为依据，而不是简单选择数值较大的一边。

## 五、消息队列只接收有希望完成的请求

Redis 预占成功后，请求进入订单队列。队列的作用是把瞬间到达量变成消费者可以持续处理的速率，同时保存等待中的命令。它没有增加库存，也没有提高数据库的稳定吞吐。

队列上限可以写成：

```text
admission_limit = min(
  remaining_sale_stock + retry_margin,
  consumer_rate × maximum_acceptable_wait,
  downstream_capacity_during_failure
)
```

消费者每秒能确认 5,000 个订单，最大等待 3 秒，就不该让几十万条请求排队几十秒。用户的 permit、价格快照或活动时间窗可能在等待中失效，长队列还会占用 broker 存储并放大恢复时间。达到上限后入口立即返回售罄或繁忙，比给所有人展示虚假的“排队中”更诚实。

### 分区顺序不等于全局公平

Kafka 可以按 `sku_id` 把同一 SKU 发到同一 partition，获得分区内顺序。[Kafka 设计文档](https://kafka.apache.org/41/design/design/)说明，客户端可按业务 key 选择 partition，同一传统消费组中一个 partition 同时由一个消费者处理。这样易于串行库存，却把爆款 SKU 限制在单 partition 与单消费者。

库存最终由原子条件更新保护时，请求之间未必需要严格顺序。可以把一个 SKU 分散到多个子分区并并行消费，数据库唯一约束和库存条件决定胜者。broker 中先出现的消息，也不代表用户先点击：网络距离、网关排队和重试都会改变到达顺序。若产品要求抽签、公平轮次或会员优先级，应显式设计 waiting room 与分配算法，不能拿消息 offset 充当公平证明。

消息通常至少一次投递。消费者用 `request_id`、`reservation_id` 和用户活动唯一键幂等，数据库事务提交后再确认 offset。若事务成功、ack 之前进程崩溃，重投消息只读取已有订单并返回同一结果。Kafka 自身的 exactly-once 能覆盖 Kafka 内的输入、输出和 offset；写外部 MySQL 时仍需目标数据库配合，这一点也在官方设计文档中明确说明。

### admission 与消息投递之间需要恢复协议

如果 Redis 脚本只扣库存，应用随后单独发送 Kafka，进程可能死在两步之间。可选方案包括：

- 在同一 Redis 脚本中写 Stream，由 relay 至少一次转发到 Kafka；
- 预占记录进入可扫描状态，发布成功后标记 `ENQUEUED`；
- 请求直接写持久 admission 表与 Outbox，再由 publisher 发消息；
- 允许短暂 token 泄漏，并由超时扫描可靠释放。

不存在一个同时跨 Redis 与 Kafka 的普通本地事务。实践中常用稳定 event ID、至少一次投递、消费者幂等和扫描补偿闭合窗口。扫描器要能区分“尚未发布”“发布结果未知”和“已经消费但状态未回写”，不能看到旧记录就一律归还库存。

## 六、订单与库存预占必须共享一张状态图

一次请求会经历 admission、持久预占、订单创建、等待支付、确认或释放。只在多个表中保存布尔字段，很容易出现订单说已取消、库存仍预占，或者库存已释放、支付回调又把订单改成成功。

![秒杀订单与库存预占状态机](/images/posts/flash-sale-order-reservation-state-machine.svg)

可以把状态定义为：

```text
ADMITTED          已通过流量层，未承诺库存
RESERVED          持久库存已预占
PENDING_PAYMENT   订单已创建，等待支付
PAID              支付已确认，库存转为 confirmed
CLOSED            超时或主动取消，库存已释放
REJECTED          无库存、资格失败或最终业务拒绝
UNKNOWN           外部结果无法确认，暂停自动重放并对账
```

订单状态与 reservation 状态可以分表保存，但每次本地转换要处于同一数据库事务，并使用版本或明确前置状态。例如支付成功只允许从 `PENDING_PAYMENT` 推进到 `PAID`；关单只允许从 `PENDING_PAYMENT` 推进到 `CLOSED`。重复消息看到终态后返回已有结果。

```sql
UPDATE orders
SET state = 'PAID', version = version + 1, paid_at = :paidAt
WHERE order_id = :orderId
  AND state = 'PENDING_PAYMENT'
  AND version = :expectedVersion;
```

受影响行数为 0 时，处理器要读取当前状态：已经 PAID 表示重复回调；已经 CLOSED 表示支付与关单发生竞态，需要查询渠道事实并按业务规则退款或人工处理；版本更高则说明另一个处理器已经推进。不能把所有 0 行更新都当成成功。

### 预占时间不是定时消息的准确执行时间

订单规定 15 分钟未支付自动关闭。延迟队列消息可能晚到，也可能重复，不能收到消息就直接释放。关单处理器读取数据库 `expire_at` 与当前状态，只有到期且仍处于 `PENDING_PAYMENT` 才执行 CAS 关闭和库存释放。

支付回调与超时任务可能同时运行。数据库条件更新让一方先取得状态转换权；失败的一方根据最新状态处理。若支付渠道已经成功而本地关单先赢，系统不能把订单重新打开并假装没有问题，应进入退款或补偿流程。下一篇支付链路会深入这类结果未知和对账，这里只保留状态接口。

释放库存也要通过 reservation ID 幂等。数据库事务把 reservation 从 RESERVED 改为 RELEASED，同时调整 `available + 1, reserved - 1` 并写 Outbox；缓存消费者再把 Redis 令牌归还。先改 Redis、后改数据库会让崩溃窗口中库存被重复出售。

## 七、缓存商品信息，不缓存一个可直接相信的库存数

活动页、商品标题、图片、规则和开始时间适合 CDN 与本地缓存。精确库存变化太快，缓存中展示“还剩 137 件”既会产生失效风暴，也会在用户点击时迅速过时。页面更适合显示未开始、可抢、排队、暂时售罄和已结束等粗粒度状态。

缓存库存只能用于早期拒绝或体验提示，不能作为最终售卖证据。缓存比数据库大时会多放请求，最终条件更新拒绝它们；缓存比数据库小时会少卖，因此要依赖释放事件和对账修正。对防超卖而言，宁可在最终护栏拒绝一部分候选，也不能为了缓存命中而删除数据库条件。

活动配置需要预热。整点再让所有实例从配置中心和数据库加载活动，会把第一次流量全部变成 miss。发布流程应提前下发活动版本、价格快照、资格规则和限流参数，并通过影子请求验证每个 Region 已经加载；到点只切换状态。

“售罄”也不总是永久状态。存在未支付超时释放时，库存可能再次出现。入口可以将 `TEMP_SOLD_OUT` 缓存几百毫秒或几秒，减少无效重试；活动明确不再回补或所有 reservation 均终态后，才发布 `FINAL_SOLD_OUT`，让 CDN 使用更长 TTL。

## 八、单个爆款 SKU 的串行点怎样拆

一个 SKU 的库存不变量天然需要某种协调。把 Redis 扩成十个节点，不会自动把一个 `{campaign:sku}` key 的原子脚本拆开；把 MySQL 分成十个库，也不会让同一库存行同时安全扣减。扩展方法是把总库存预先切成互不重叠的配额。

假设总量 10,000，四个 Cell 各获得 2,400 个本地配额，保留 400 个中央应急池：

```text
2,400 × 4 + 400 = 10,000
```

每个 Cell 在本地 Redis 和数据库分片内处理自己的配额，任何时刻各 Cell 可确认量之和不超过已分配总量。一个 Cell 故障最多暂时冻结它的剩余配额，不会让其他 Cell 超卖。活动后半程可以从应急池追加配额，追加操作要有 allocation ID、版本与唯一 owner，避免同一批配额分给两个 Cell。

这与简单分桶不同。随机把用户哈希到 64 个库存桶，某个桶提前为空时，该用户可能被拒绝，而其他桶仍有库存；允许它继续探测其他桶会增加请求和去重复杂度。Cell 配额通常按入口地域或稳定流量域分配，并保留再平衡协议，适合控制爆炸半径。

### 配额拆分用少卖风险换吞吐与隔离

Cell 断网后仍可能持有未用配额，其他区域不能在没有证据时直接拿走，否则旧 Cell 恢复后会双重出售。回收需要租约过期、fencing version 或停止旧 Cell 写入，再把确认未使用的配额重新分配。活动窗口很短时，宁可少卖几十件，也可能比引入复杂的在线回收协议更合适。

热点拆分还要覆盖队列和数据库。每个 Cell 使用独立 topic partition、消费者组配额和连接池，避免一个区域的机器人流量耗尽全部资源。全局管理面只发布活动和配额，不进入每次请求同步路径。

## 九、幂等、防刷与公平是三个问题

幂等阻止一次用户意图因超时重放而产生两张订单。接口要求客户端携带稳定 `request_id`，服务端对 `(campaign_id, user_id)` 和 `request_id` 建唯一约束；同键同参数返回原状态，同键不同参数拒绝。客户端超时后查询原请求，不能换新 ID 反复创建。

防刷限制一个主体可以制造多少竞争。维度可以包含账号、设备、IP、支付账户、收货地址和行为特征，入口使用分层速率与并发配额。IP 不能单独代表用户，大型 NAT 会共享出口，攻击者也能使用代理池。风控信号要服务于风险判断，不应无条件把所有共享 IP 用户封死。

公平决定有限库存怎样在合格用户之间分配。网络先到先得会偏向离机房更近、设备更快和自动化程度更高的请求；FIFO 消息队列只保证进入同一分区后的顺序。产品若要求更强公平，可以设置短 waiting room，在一个时间窗内收集合格请求后抽签，或按会员等级发放分层配额。代价是结果更晚，系统还要保存抽签证据。

[OWASP Bot Management 指南](https://cheatsheetseries.owasp.org/cheatsheets/Bot_Management_and_Anti-Automation_Cheat_Sheet.html)将 scalping 和 denial of inventory 列为自动化滥用：机器人可能占住限量库存却不完成购买。对此只做 CAPTCHA 不够，还要限制未支付 reservation 数量、缩短高风险账户支付窗口，并把设备与支付结果反馈给风控。

隐藏接口、动态 path 和前端按钮置灰只能增加少量逆向成本。资格、时间、签名、幂等和库存判定都要在服务端执行。错误响应也不应泄露某个账号、券码或内部库存桶是否存在。

## 十、故障时不能绕过库存护栏

秒杀最危险的降级是“Redis 挂了，临时直接打数据库”或者“队列慢了，改成同步下单”。原本只承受几千 QPS 的依赖会突然接收几十万请求，保护层在最需要时消失。

| 故障 | 安全动作 | 不能做的事 |
| --- | --- | --- |
| Redis admission 不可用 | 暂停新抢购，或以极低本地配额进入 DB 基线 | 全量绕过 Redis |
| 消息队列不可用 | 停止发放新许可，保留可恢复预占 | 接收请求后只写内存队列 |
| 订单数据库变慢 | admission 按最老消息年龄收紧，最终关闭 | 继续把队列填满 |
| 消费者崩溃 | 其他消费者重放，依靠幂等恢复 | 先提交 offset 再创建订单 |
| Redis 主从切换丢预占 | 以数据库预占与订单对账重建 | 直接把 Redis 大值覆盖数据库 |
| 延迟关单积压 | 消费时重新检查 expire_at 与状态 | 看到超时消息就加库存 |
| 支付结果未知 | 保持 UNKNOWN 并查询渠道 | 自动重扣或直接释放 |

入口状态也要有层级：`OPEN` 正常放行，`THROTTLED` 收紧许可，`QUEUE_FULL` 停止新 admission，`FINAL_SOLD_OUT` 长期拒绝，`PAUSED` 因依赖故障暂停。售罄和系统故障要返回不同状态，否则客户端会在故障时持续刷新，或者把仍可恢复的活动误认为结束。

Redis 故障期间是否保留已经发出的 permit，要看 permit 的语义。若它只代表入口资格，可以重新排队；若接口宣称已经预占库存，系统必须能从持久事实恢复。把两类 token 都叫“秒杀 token”，事故时就无法判断应不应该补发。

### 背压看最老消息年龄，而不只看条数

队列有一万条消息时，消费者 20,000/s 与 500/s 的风险完全不同。admission 控制器应观察消费速率、最老消息年龄、失败重试率、数据库锁等待和剩余支付窗口，动态收紧入口。消息年龄接近用户最大等待时间时，即使库存还有，也应暂停接收。

消费者恢复后逐步放量。数据库刚恢复时，连接池、Buffer Pool 和缓存都可能是冷的；一次性释放入口积压会再次把它压垮。过载治理的组合方式见[限流、熔断、隔离、降级与背压](/posts/rate-limit-circuit-breaker-bulkhead-degradation-backpressure/)。

## 十一、用一万件商品走完一次秒杀

活动开始前 30 分钟，系统把 10,000 件活动库存与版本写入数据库，生成 Redis admission 镜像，并向四个 Cell 各分配 2,400 配额，中央保留 400。活动页、资格规则和签名密钥已预热。压测证明每个 Cell 的订单消费者稳定处理 1,500/s，最大允许排队两秒。

12:00:00 一百万个请求到达。CDN 只处理页面资源，API 网关过滤过期 permit、未登录账号和重复 nonce；用户级限流把连续点击折叠为同一个 `request_id`。每个 Cell 最多接受本地库存与 `1,500 × 2` 队列预算中的较小值，超出请求立即返回售罄或繁忙。

用户 42 的请求进入 Redis Function。脚本发现该用户未预占、库存仍有，原子扣减并写 admission Stream，返回 reservation `r-42`。relay 将稳定 event ID `reserve-r-42` 至少一次投递到订单队列；接口在满足约定的接收确认后返回 202 和 `/requests/r-42`。

订单消费者可能收到两次 `reserve-r-42`。第一次在 MySQL 事务中执行库存条件更新，插入 reservation、订单与 Outbox，订单进入 `PENDING_PAYMENT`；第二次命中 request 唯一键，读取并返回同一个订单。页面轮询后看到待支付，而不是把 202 当成成功订单。

用户在 15 分钟内支付。支付回调用订单版本从 `PENDING_PAYMENT` 推进到 `PAID`，同一事务把 reservation 改为 `CONFIRMED`，库存计数从 reserved 移到 confirmed，并写出业务事件。重复支付回调看到 PAID 后返回原结果。

另一个用户没有支付。延迟关单消息晚到 20 秒，处理器仍以数据库 `expire_at` 为准，将订单 CAS 到 CLOSED，reservation 进入 RELEASED，数据库 `available + 1`。Outbox 消费者随后把一个 admission token 归还 Redis。若活动仍开放，这一件可以再次被抢；活动已结束则进入未售或后续场次池。

活动中途一个 Redis 主分片切换，少量已接受镜像状态丢失。系统立即暂停对应 Cell 的新 admission，订单库继续完成队列内请求。对账任务按 allocation、reservation 和订单终态计算应有库存，重建 Redis 镜像后以小流量恢复。它没有根据某个孤立计数器猜测库存，也没有让请求全量绕过保护层。

## 十二、三份账怎样对齐

高峰方案通常存在三类记录：Redis admission 账、消息处理进度和数据库库存/订单账。它们无法靠一次跨系统事务永远同步，需要稳定 ID、状态机和对账任务定期收敛。

![Redis admission、消息与数据库库存怎样对账](/images/posts/flash-sale-three-ledgers-reconciliation.svg)

数据库可以从事实表计算：

```sql
SELECT
  SUM(state = 'RESERVED')  AS reserved_count,
  SUM(state = 'CONFIRMED') AS confirmed_count,
  SUM(state = 'RELEASED')  AS released_count
FROM inventory_reservation
WHERE campaign_id = :campaignId AND sku_id = :skuId;
```

再验证：

```text
db.available + active_reservations + confirmed_orders = sale_limit
Redis 剩余许可 ≈ DB available - 已 admission 未落库数量
每个 admission event 最终对应订单、明确拒绝或释放记录
```

第二个式子允许短暂差值，因为消息正在路上。对账任务按 request ID 列出具体差异：Redis 已扣但没有事件、事件存在但没有 DB 预占、DB reservation 长期没有订单、订单关闭但 token 未归还。总数相等不能证明没有一条多扣、一条漏扣。

修复动作也必须幂等。补发事件沿用原 event ID，释放沿用 reservation ID，调整配额生成独立 adjustment ID 并记录原因。直接执行 `SET stock = 173` 虽然能让数值看起来一致，却会覆盖正在发生的并发预占。

## 十三、怎样验证系统真的不会超卖

单元测试脚本返回 `SOLD_OUT` 远远不够。验证应覆盖三个层次。

第一层是性质测试。随机生成预占、支付、取消、重复消息和超时顺序，每一步都检查 `available >= 0`、`reserved >= 0`、`confirmed <= sale_limit`，同一用户最多一个有效终态。状态机拒绝非法倒退，重复事件不改变计数。

第二层是并发与容量测试。让几十万请求集中竞争一个 SKU，混入相同 request ID、同一用户不同 request ID 和多个用户。检查数据库实际确认数、Redis 剩余数、唯一冲突、行锁等待、队列最老年龄和端到端 P99。压测数据必须包含极端热点，均匀分散到一万个 SKU 得出的吞吐没有意义。

第三层是故障注入：

1. Redis 脚本成功后杀死应用，确认 Stream 或扫描器能恢复命令。
2. Kafka 发布成功但确认丢失，重复消息只能创建一个订单。
3. MySQL commit 后杀死消费者，重放读取原订单。
4. 支付回调与超时关单并发，只允许一个状态转换获胜。
5. Redis failover 丢失最近写入，系统暂停 admission 并从事实账恢复。
6. 消费速度降到入口以下，admission 在队列年龄越界前停止。
7. 一个 Cell 与管理面断网，不能重复领取中央配额。
8. 失效和恢复同时发生时，入口按批次放量，不产生第二次洪峰。

上线时至少观察：入口请求量与各层淘汰率、每用户重复比例、admission 成功数、Redis 脚本耗时、每 SKU 热度、队列最老消息年龄、订单创建速率、DB 条件更新失败原因、锁等待、reservation 各状态数量、释放延迟、支付/关单冲突、三账差异和最终少卖量。

### 上线前检查清单

- “入场、排队、预占、下单、支付成功”的响应文案是否对应真实提交点？
- `sale_limit = available + reserved + confirmed` 是否能从事实表重算？
- 数据库是否保留 `available > 0` 的最终条件更新？
- Redis 脚本涉及的 key 是否同 slot，执行时间是否有上限？
- Redis 丢最近写入时，用户承诺和恢复来源是什么？
- admission 数量是否同时受库存、消费速率和最大等待时间限制？
- 消息重复、乱序和确认丢失是否由稳定 ID 与状态机处理？
- 202 响应是否提供查询地址，并避免展示成购买成功？
- 支付回调与关单任务并发时，哪个 CAS 决定胜者？
- 库存释放是否先改变持久事实，再异步更新 Redis？
- 爆款 SKU 在 Redis、Kafka、MySQL 的串行点分别在哪里？
- Cell 配额之和是否永远不超过总量，失联配额怎样 fence 后回收？
- 防刷是否限制库存占用，而不只是限制页面访问？
- Redis、队列、数据库任一故障时，入口会停止还是绕过保护？
- 对账能否定位到 request、reservation、event 和 order，而非只比总数？

## 结语

秒杀系统先把多数请求挡在廉价层，再让少量候选进入库存协议。数据库条件更新提供最小正确基线；Redis 原子预占提高 admission 吞吐；有界队列按消费能力削峰；订单与 reservation 状态机处理支付、关单和重试；分 Cell 配额把单个热点拆成多个互不重叠的库存域。

这些组件的职责不能互换。限流没有证明库存存在，Redis 扣减没有证明订单持久化，消息入队没有证明用户购买成功，缓存售罄也不一定是最终状态。每一层只返回它已经拥有的证据，再用幂等、条件状态转换和对账连接跨系统窗口，防超卖才是一条可以测试和恢复的协议。

## 参考资料

- [Redis programmability](https://redis.io/docs/latest/develop/programmability/)
- [Redis replication](https://redis.io/docs/latest/manual/replication/)
- [Apache Kafka: Design](https://kafka.apache.org/41/design/design/)
- [MySQL 8.4: InnoDB Locking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)
- [RFC 9110: 202 Accepted](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.3)
- [OWASP Bot Management and Anti-Automation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Bot_Management_and_Anti-Automation_Cheat_Sheet.html)
