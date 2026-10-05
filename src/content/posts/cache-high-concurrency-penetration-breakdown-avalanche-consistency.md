---
title: 缓存怎样扛住高并发：穿透、击穿、雪崩与一致性
description: 从 Cache Aside 的完整读写路径出发，讲清缓存穿透、热点击穿、批量雪崩和写后陈旧为何发生，并用请求合并、逻辑过期、版本栅栏、CDC 与多级缓存构建可验证的治理方案。
category: 后端
subcategory: 系统设计与高并发
articleClass: flagship
seriesOrder: 40
publishedAt: 2026-08-06T09:35:00+08:00
tags: [缓存, Redis, Cache Aside, 缓存穿透, 缓存击穿, 缓存雪崩, 缓存一致性, 高并发]
---

缓存命中时，一次读取从数据库的数十毫秒变成内存或网络中的几毫秒。麻烦出现在缓存失效的那一刻。不存在的 ID 会让每次请求都访问数据库；一个热点 key 过期，几千个请求会同时重建；大量 key 一起失效，原本被缓存挡住的流量会整体落到源站；数据更新后，缓存里还可能保留旧版本。

这四种现象经常被放在一页“Redis 面试题”里背诵，实际却属于同一条读写链路。缓存未命中以后谁能回源、其他请求等什么、旧值能否继续使用、写操作怎样使副本失效，这些选择共同决定系统在高并发下的行为。

本文回答的问题是：缓存怎样吸收大部分读取，又把未命中、过期、故障和写入带来的源站放大与陈旧时间限制在业务可接受范围内？案例继续使用活动报名系统。活动名称、规则、展示状态适合缓存；报名名额扣减和最终资格不能只依赖一个可能丢失或陈旧的普通缓存值。先划清这条边界，后面的技术选择才有依据。

## 一、缓存保存副本，权威数据仍要有归属

缓存是用空间和陈旧风险换取更低延迟、更少源站工作。它适合重复读取、计算昂贵且能接受一定陈旧的数据。缓存副本可能因过期、淘汰、节点故障和运维操作随时消失，因此每类数据都要先说明权威来源在哪里。

活动详情的权威来源可以是 MySQL，Redis 和应用本地 Caffeine 保存派生副本。缓存丢失后能够从 MySQL 重建。库存若采用数据库条件更新，则数据库事务是权威；若专门设计 Redis 扣减、持久化和对账协议，Redis 才承担了状态机的一部分，不能再按“丢了就回源”的普通缓存对待。

[Azure 的缓存设计指南](https://learn.microsoft.com/en-us/azure/architecture/best-practices/caching)也建议不要把缓存作为关键信息的唯一权威存储，并提醒缓存不可用时直接回退源站可能将源站压垮。能回源与允许无限回源是两件事，降级路径同样需要容量边界。

### 先给每类数据定义新鲜度契约

“缓存要一致”无法直接验收。更可执行的契约包括：

| 数据 | 可接受陈旧 | 写后读要求 | 缓存故障时 |
| --- | --- | --- | --- |
| 活动标题与说明 | 30 秒 | 运营后台可读主库确认 | 可返回旧值 |
| 活动开始时间 | 1 秒 | 修改者必须立即看到新值 | 回源或暂停入口 |
| 剩余名额展示 | 允许近似 | 不作为报名结果依据 | 隐藏数字 |
| 用户报名资格 | 不接受旧权限 | 读取权威状态 | 明确失败或处理中 |
| 风控与封禁状态 | 按安全策略确定 | 通常要求强校验 | fail closed |

最大陈旧时间、read-your-writes、单调读和故障行为是不同保证。普通 Cache Aside 通常只能给最终一致，并通过 TTL 限制最坏陈旧时间。若一个字段要求提交成功后所有读立即看到新值，要么绕过缓存，要么采用更强的协调方案，不能只把 TTL 调短后宣称强一致。

## 二、从最小 Cache Aside 读写路径开始

Cache Aside 由应用管理缓存。读取时先查缓存，未命中再查数据库并回填；更新时先提交数据库，再使缓存副本失效。微软的 [Cache-Aside 模式说明](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)也采用这条基本路径，同时明确它不保证缓存与数据库始终一致。

![Cache Aside 的权威数据边界与读写路径](/images/posts/cache-aside-read-write-path.svg)

一个最小读取可以写成：

```java
ActivityDetail get(long activityId) {
    String key = "activity:detail:v3:" + activityId;
    byte[] cached = redis.get(key);
    if (cached != null) {
        return decode(cached);
    }

    ActivityDetail value = repository.find(activityId);
    if (value != null) {
        redis.set(key, encode(value), ttlWithJitter());
    }
    return value;
}
```

对应写路径是：

```java
void update(ActivityDetail detail) {
    transaction(() -> repository.update(detail));
    redis.delete("activity:detail:v3:" + detail.id());
}
```

删除而非直接更新缓存，减少了应用同时维护两套数据写入语义的负担。下一次读会从权威来源加载完整新值。不过，这段代码还没有解决并发回源、删除失败、读写竞态、外部写库和 Redis 故障。它只是后续设计的骨架。

### 命中率要换算成源站放大

缓存价值不能只看“命中率 95%”。入口读取 100,000 QPS 时，95% 命中意味着 5,000 QPS 回源；命中率降到 80%，回源变成 20,000 QPS，是原来的四倍。

```text
origin_qps = read_qps × (1 - hit_ratio) × loads_per_miss
```

`loads_per_miss` 在没有请求合并时可能大于 1。一个热点 key 同时有 2,000 个未命中请求，它们都查询数据库，逻辑上只是一次 miss，物理上却产生 2,000 次 load。监控应把 cache lookup、unique miss、实际 load 和被合并请求分开统计。

整体命中率也会掩盖问题。一个占 60% 流量的热点活动命中率从 100% 降到 0%，其余数百万冷 key 表现正常，平均指标可能来不及揭示数据库洪峰。命中率至少要按接口、key 类型和热点集合拆分。

## 三、四类故障分别破坏了哪条假设

穿透、击穿、雪崩和一致性问题的表象都是回源或旧值，触发条件并不相同。

![缓存穿透、击穿、雪崩与一致性的触发链](/images/posts/cache-four-failure-modes.svg)

| 问题 | 被破坏的假设 | 典型现象 | 首要控制点 |
| --- | --- | --- | --- |
| 穿透 | 请求的 key 大多真实存在 | 同一批不存在 key 反复查库 | 入口校验、负缓存、成员过滤 |
| 击穿 | 单个 miss 的回源量很小 | 一个热点 key 失效后并发重建 | 请求合并、逻辑过期 |
| 雪崩 | 失效时间和故障相互独立 | 大量 key 或整个缓存同时失效 | TTL 打散、预热、限流降级 |
| 一致性 | 副本会及时跟随权威数据 | 写成功后读到旧值或旧值回填 | 失效协议、版本与重放能力 |

同一事故可以叠加多种模式。例如 Redis 节点故障导致大量 key 丢失属于雪崩，其中最热的活动详情又会发生击穿；应用回源到只读副本时，复制延迟还可能把旧值重新写回缓存，形成一致性问题。诊断时应沿完整因果链处理，不能看到“数据库被打满”就统一归类为缓存雪崩。

## 四、缓存穿透：不存在的数据也需要缓存策略

攻击者不断请求随机活动 ID，或者客户端因 bug 生成无效 ID。Redis 中没有这些 key，数据库也查不到，每次请求都会完整回源。输入空间足够大时，缓存永远无法形成命中，这就是缓存穿透。

第一层防线应尽量靠近入口：校验 ID 格式、租户范围、权限和签名，对异常来源限速。缓存机制不应代替访问控制。能在协议层判断 `activityId <= 0` 无效，就没有必要让请求到达 Redis。

### 负缓存适合真实但不存在的 key

数据库确认活动不存在后，可以缓存一个明确的空值标记，并设置较短 TTL：

```java
if (value == null) {
    redis.set(key, NOT_FOUND, Duration.ofSeconds(30));
    return null;
}
```

空值和缓存连接失败必须是不同状态。若 `redis.get` 返回 `null` 同时代表 key 不存在和 Redis 超时，应用可能把基础设施故障误当成业务不存在。客户端接口应区分 HIT、MISS、NEGATIVE_HIT 和 ERROR。

负缓存有两个边界。其一，恶意随机 key 会占用大量内存，因此 TTL、key 长度、每租户基数和准入速率都要受限。其二，数据随后被创建时要删除负缓存，否则新活动会在负 TTL 内仍显示不存在。创建路径和更新路径一样需要发出失效事件。

### Bloom Filter 适合巨大集合的成员预判

Bloom Filter 用位数组和多个哈希函数判断一个元素是否可能存在。它可能把不存在元素判断为“可能存在”，即 false positive；在元素已正确加入且过滤器没有损坏的前提下，不会把成员判断为不存在。原始定义来自 Burton H. Bloom 1970 年的论文 [Space/Time Trade-offs in Hash Coding with Allowable Errors](https://courses.cs.washington.edu/courses/csep521/21wi/readings/bloom_cacm.pdf)。

读取路径可以先问过滤器：明确不存在则直接拒绝，可能存在才查缓存和数据库。false positive 只会多一次回源，不会返回错误数据。工程风险来自同步过程：新活动已经提交数据库、过滤器却还没加入，此时“明确不存在”会误伤真实数据。可以让创建事务通过 Outbox 发出过滤器增量事件，或者在过滤器重建切换期间对新版本尚未覆盖的范围绕过检查。

删除同样需要设计。普通 Bloom Filter 不支持直接清除某个元素，因为多个元素可能共享 bit。很多业务允许已删除 ID 继续显示“可能存在”并回源确认；若必须高频删除，可评估 Counting Bloom Filter、Cuckoo Filter 或定期重建。过滤器是减少无效 I/O 的概率结构，不是数据存在性的权威证据。

## 五、缓存击穿：热点 key 失效后只允许少量回源

活动开放前，详情 key 每秒有 50,000 次读取。它在某一毫秒过期后，几十个应用实例同时观察到 miss。每个实例的数百个请求都去数据库重建，原本只需一次的回源由此变成一阵数据库尖峰。这类针对单个或少量热点 key 的并发 miss 常被称为击穿或 thundering herd。

### 请求合并先减少同一进程内的重复工作

同一进程可以按 key 合并并发加载。Go 的 [`singleflight`](https://pkg.go.dev/golang.org/x/sync/singleflight)保证同一个 key 同一时间只有一个函数执行，其他调用共享结果。Java 的 LoadingCache 也能合并同 key 的加载。

```text
第一个 miss：成为 loader，查询数据库并回填
后续 miss：等待同一个 future，不再重复查询
loader 完成：所有等待者共享结果
```

请求合并只覆盖当前进程。100 个实例会保留最多约 100 次并发回源，已经比 50,000 次好很多，但对昂贵查询仍可能过高。可以再加入跨实例短租约或分布式锁，让一个实例重建。锁持有者获得许可后必须重新检查缓存，避免它排队期间已有其他实例完成回填。

缓存重建锁主要保护性能，不适合作为业务正确性的唯一边界。租约过期后可能出现两个 loader，进程暂停也可能让旧 loader 晚于新 loader 写回。允许重复查询时，应让回填带数据版本并拒绝旧版本覆盖；完全不能重复执行的业务动作则应使用业务幂等和事务，而不是复用缓存锁。分布式锁的协议边界已在[分布式锁文章](/posts/distributed-locks-redis-zookeeper-fencing-token/)中展开。

### 逻辑过期允许读请求继续拿旧值

另一条路径是 stale-while-revalidate：缓存对象保留数据和逻辑过期时间。逻辑过期后，第一个请求异步刷新，其他请求仍收到旧值。Caffeine 的 [`refreshAfterWrite`](https://github.com/ben-manes/caffeine/wiki/Refresh)也采用类似语义：条目达到刷新条件后，由一次查询触发异步刷新，刷新期间继续返回旧值；eviction 会移除条目，使后续读取等待重新加载。

```json
{
  "version": 42,
  "refreshAfter": "2026-10-04T12:00:00Z",
  "hardExpireAt": "2026-10-04T12:05:00Z",
  "payload": { "title": "秋招分享会", "status": "OPEN" }
}
```

逻辑过期需要业务允许短暂陈旧。活动介绍可以继续返回，封禁状态和支付结果通常不行。还应保留 hard TTL，避免刷新任务长期失败后旧值永久存在。刷新失败次数、当前陈旧年龄和 hard expiry 前剩余时间都要进入监控。

### 提前刷新适合可预测的超级热点

活动详情、直播间信息等 key 在正式流量到来前已知，可以定时预热或在 TTL 剩余较少时概率性提前刷新。刷新时间加入抖动，避免所有实例按照同一个 cron 同时更新。预热任务也要限速，因为一次加载几十万 key 本身就可能形成雪崩。

这些方案不必全上。普通 key 用 Cache Aside 与 TTL；中等热点增加进程内合并；极热且允许陈旧的 key 使用逻辑过期；极热且要求新鲜的 key 才值得引入跨实例租约与版本控制。机制应跟随 key 的热度和新鲜度要求分层。

## 六、缓存雪崩：失效相关性比失效数量更危险

一百万个 key 均匀分布在一天内过期，平均每秒约 11.6 个回源；它们在同一秒过期，则可能同时制造一百万次加载。总数量相同，时间相关性完全不同。

一致 TTL 只是雪崩的一种触发源。缓存集群故障、主从切换丢失部分热数据、扩容迁移、批量删除前缀、应用发布后本地缓存清空、淘汰策略突然驱逐大量 key，也会让原本分散的回源集中发生。

### TTL 抖动只能处理计划内的同时过期

假设基础 TTL 为 30 分钟，可以给每个 key 增加独立随机量：

```text
ttl = 30 minutes + random(0, 10 minutes)
```

随机量要按 key 独立生成。若整个批次共享同一个随机值，过期时间仍然同步。TTL 还要服从数据的新鲜度上限，不能为了打散而让本应一分钟更新的数据保存四十分钟。

Redis 的 [`EXPIRE`](https://redis.io/docs/latest/commands/expire/)以绝对时间戳保存过期信息，RDB 在时钟差异很大的机器间移动可能导致大量 key 加载后立即过期。因此基础设施时钟和迁移流程也属于雪崩边界。

### 冷启动与故障恢复必须限速

新集群、扩容实例和灾备切流都可能面对空缓存。预热应按热点优先级分批，控制回源并发，并在数据库压力升高时暂停。完整 keyspace 预热通常成本过高，先加载覆盖大部分流量的热点集合更有效。

缓存故障后直接让全部请求查数据库，会把缓存故障转换成数据库故障。恢复路径需要：入口限流、按 key 请求合并、数据库并发上限、可接受时返回旧副本，以及对非核心页面降级。上一篇[过载治理](/posts/rate-limit-circuit-breaker-bulkhead-degradation-backpressure/)讨论的并发控制和熔断，在缓存失效路径同样适用。

多副本和 Redis Cluster 提高缓存服务可用性，却不能替代回源保护。主从切换可能仍有数据丢失或延迟，客户端重连期间也会出现 miss。系统要假设某个时刻命中率可以显著下降，并在该条件下压测源站保护。

## 七、缓存一致性先从四种写入顺序判断

数据库和缓存是两个独立系统，没有本地事务能原子提交两边。常见写法都有窗口：

| 写法 | 主要问题 |
| --- | --- |
| 先更新缓存，再更新数据库 | 数据库失败后缓存提前出现未提交值 |
| 先删缓存，再更新数据库 | 并发读可能读旧数据库并把旧值回填 |
| 先更新数据库，再更新缓存 | 并发写的缓存更新可能乱序，旧写覆盖新写 |
| 先更新数据库，再删除缓存 | 窗口较小、实现简单，但仍是最终一致 |

普通 Cache Aside 更常采用“数据库提交后删除缓存”。数据库是权威来源，缓存删除失败也可以重试；缓存值不需要复刻数据库的合并和事务逻辑。它依然存在一个不直观的 stale set 竞态。

### 数据库提交后删除缓存仍有旧值回填窗口

![Cache Aside 中旧值回填的竞态与版本栅栏](/images/posts/cache-consistency-stale-set-race.svg)

时序如下：

```text
R1 读缓存 miss
R1 从数据库读到 version=41，但暂未回填
W  更新数据库为 version=42，提交成功
W  删除缓存
R1 恢复执行，把 version=41 写进已经被删除的缓存
```

后续请求会一直读到 41，直到 TTL 到期或再次删除。Meta 的论文 [Scaling Memcache at Facebook](https://pdos.csail.mit.edu/6.824/papers/memcache-fb.pdf)把这种并发回填旧数据称为 stale set，并使用与 key 绑定的 lease token 同时处理 stale set 和 thundering herd：缓存只接受仍有效租约持有者的回填，写入失效会撤销旧租约。

并非每个系统都需要实现 lease。若竞态窗口很小、数据变化少、TTL 短且业务允许几秒陈旧，数据库提交后删缓存已经足够。方案复杂度应由新鲜度 SLO 和事故成本决定。

## 八、延迟双删、版本栅栏与 CDC 分别解决什么

### 延迟双删是概率性缩小窗口

一种常见做法是在数据库更新后立即删一次，再等待一段时间删第二次。第二次删除有机会清掉并发读晚到的旧回填。问题在于延迟很难选：必须覆盖数据库读取和回填的长尾，又不能让任务队列失控；进程崩溃会丢失第二次删除；更慢的旧读仍可能越过它。

因此延迟双删可以作为低成本缓解，不能提供确定一致性承诺。第二次删除至少应进入可靠延迟任务或消息，而不是在请求线程里 `sleep`。监控还要记录待执行量、最老任务年龄和最终失败。

### 版本栅栏拒绝过时回填

为数据库记录维护单调递增 `version`，缓存值携带相同版本。更新提交后，失效消费者先把某个 key 的最低可接受版本推进到 42，再删除旧缓存。加载者尝试写回 version 41 时，由 Lua 脚本或缓存服务原语比较版本并拒绝。

```text
cache value: activity:detail:123 -> { version: 42, payload: ... }
fence key:   activity:fence:123  -> 42

accept(candidate) only if candidate.version >= fenceVersion
```

版本栅栏能处理乱序回填，代价是多一份元数据和原子比较逻辑。fence key 不能比可能到达的旧读更早过期；删除、重建和版本回绕也要定义。数据量巨大时，不应默认给每个对象永久保存一个栅栏 key，可让 lease token、分区版本或数据库校验承担相同职责。

### CDC 或 Outbox 让失效事件可以重放

应用写数据库后直接删缓存，删除失败时需要可靠重试；其他应用、脚本和后台任务绕过该代码路径写库时，还会漏发删除。Change Data Capture 可以从数据库变更日志生成失效事件，Outbox 则把业务更新与事件记录放入同一个本地事务。

[Debezium Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)通过连接器捕获 Outbox 表记录并转为消息，使数据库状态与待发送事件不会出现“一个提交、一个丢失”的双写缺口。消费者根据实体 ID 删除或刷新 Redis、本地缓存和搜索索引。

消息至少可能重复，跨分区时还可能乱序。只做 `DEL` 通常天然幂等；若事件携带完整值并直接覆盖缓存，则必须比较业务版本。CDC 自身也有延迟，所以一致性 SLO应写成“提交后 99.9% 在 2 秒内失效，最坏由 5 分钟 TTL 收敛”，而不是“用了 MQ 所以一致”。

## 九、多级缓存把一次失效扩散到更多副本

应用本地缓存省去 Redis 网络往返，适合小而热、读多写少的数据。常见路径是 L1 Caffeine、L2 Redis、L3 数据库：

```text
read:  L1 → L2 → DB
write: DB commit → invalidate L2 → broadcast / track → invalidate every L1
```

层数增加后，延迟下降，副本数和失效复杂度同时增加。L1 只能服务当前实例，进程内请求合并也只能覆盖当前实例。每台机器各保存一份旧值时，只删 Redis 不能让 L1 自动消失。

Redis 的[服务端辅助客户端缓存](https://redis.io/docs/latest/develop/clients/client-side-caching/)会跟踪客户端读过的 key，在 key 被修改、过期或淘汰时推送 invalidation。连接丢失后客户端应清空本地缓存，避免错过消息后无限提供旧值。它比无差别广播更精细，也需要客户端库、连接模型和 Redis 版本支持。

自行使用 Redis Pub/Sub 广播失效时，要接受它的 at-most-once 语义。Redis 的 [Pub/Sub 文档](https://redis.io/docs/latest/develop/use-cases/pub-sub/)明确指出离线订阅者会永久错过消息。短 TTL 可以作为收敛后盾；要求重放时，应使用带持久化与消费位置的消息系统，而不是假设广播可靠。

Caffeine 本身也要配置 `maximumSize` 或 `maximumWeight`，避免本地缓存占满堆。其[淘汰文档](https://github.com/ben-manes/caffeine/wiki/Eviction)区分按大小、时间和引用的淘汰。条目大小差异很大时，按条目数量限制会低估大对象成本，可以按序列化字节或近似内存配置 weight。

## 十、Redis 内存满与 key 过期不是同一种行为

TTL 到期是业务配置的生命周期；eviction 是缓存内存达到上限后的容量行为。一个仍有很长 TTL 的热点 key 也可能被淘汰。排查命中率下降时，应区分 expired_keys 和 evicted_keys。

Redis 的 [key eviction 文档](https://redis.io/docs/latest/develop/reference/eviction/)说明，实例超过 `maxmemory` 后会按照 `maxmemory-policy` 淘汰 key。`allkeys-lru`、`allkeys-lfu`、随机和只处理带 TTL 的 volatile 策略适合不同工作负载；Redis 的 LRU 是采样近似，不是维护完整精确链表。

选择策略前要明确实例是否纯缓存。混放不可丢状态与可淘汰缓存时，`allkeys-*` 可能删除业务状态；`noeviction` 又会让新增缓存写失败。更清楚的做法是把持久状态和缓存拆到不同实例或集群，分别配置容量、持久化和淘汰策略。

内存预算还要包含 key、对象头、分配器碎片、复制和 AOF 缓冲、客户端输出缓冲。`maxmemory` 不能直接等于机器全部内存。上一篇[Redis 读请求触发 key 淘汰的排障](/posts/redis-read-trigger-key-eviction/)展示过另一条容易忽略的路径：大批量读产生客户端输出缓冲，进程内存越线后触发数据淘汰。

大 key 既占内存，也会让网络、序列化、删除和迁移出现长尾。缓存对象应按访问单元拆分，限制单值字节数；压缩可以减少网络和内存，却增加 CPU，适合通过真实对象分布压测确定阈值。

## 十一、缓存故障时，回源、旧值和拒绝都要有上限

缓存连接超时后，应用通常有三种选择：直接回源、返回旧值、拒绝或降级。选择取决于数据语义和数据库余量。

活动说明可以从 L1 返回 30 秒旧值；权限校验需要访问权威存储，权威存储也不可用时宁可拒绝；非核心推荐模块可以直接隐藏。缓存错误不能统一转换成 miss，否则每个网络抖动都会触发数据库洪峰。

回源路径应有独立信号量，例如整个实例最多 50 个并发数据库加载，单个 key 只能有一个 loader，等待超过 30 ms 后执行降级。Redis 熔断打开时，不要让所有请求绕过保护直接查库。熔断只停止访问失效缓存，数据库 bulkhead 决定还有多少回源许可。

旧值也要携带年龄。`stale=true`、`dataVersion` 和 `generatedAt` 可以进入内部响应与日志，前端是否展示由产品决定。超过 hard TTL 后继续返回的风险需要单独审批，不能因“缓存里还有值”就无限延期。

## 十二、完整案例：活动详情怎样在开场流量下保持有界

假设活动详情接口峰值 100,000 QPS，其中最热活动占 60%。MySQL 能为该接口稳定提供 3,000 QPS，业务允许标题和规则陈旧 30 秒，活动状态最多陈旧 1 秒。报名资格和库存不使用这份详情缓存做最终判断。

缓存结构如下：

```text
L1 key: activity:detail:v3:{id}
L2 key: activity:detail:v3:{id}
value:
  dataVersion    数据库行版本
  refreshAfter   进入异步刷新窗口的时间
  hardExpireAt   绝对不可继续提供的时间
  payload        可缓存展示字段
```

读取过程：

1. 校验 ID、租户和访问权限，异常请求在入口限流；
2. 命中 L1 且未到 `refreshAfter`，直接返回；
3. L1 miss 后读取 Redis，命中则写入 L1；
4. 达到逻辑刷新时间时返回旧值，并由当前实例的 singleflight 发起刷新；
5. L2 miss 时，各实例先做本地合并，再竞争短租约；拿不到租约的请求短等后重读 L2；
6. 数据库不存在则写 20 秒负缓存；存在则按版本栅栏回填；
7. 所有加载都受数据库并发许可约束，超过许可时按字段新鲜度返回旧值或降级。

运营更新活动时，MySQL 事务同时递增 `dataVersion` 并写 Outbox。CDC 把 `{activityId, version}` 发送到失效主题。消费者推进版本栅栏、删除 L2，并通知各实例删除 L1。消息重复不会造成问题；旧版本事件不能降低栅栏版本。

活动开场前，预热任务只加载预计最热的 1,000 个活动，速率限制为数据库可用余量的一部分。TTL 使用基础值加独立 jitter，实例滚动发布，避免 L1 同时清空。Redis 故障演练时，L1 旧值继续服务展示字段，数据库回源由 3,000 QPS 以下的许可保护，剩余请求隐藏非关键字段或返回稍后重试。

这套方案没有让缓存与数据库时刻相同。它给差异规定了上限：正常写入由失效事件在目标窗口内收敛，消息中断由 hard TTL 收敛，乱序旧回填由版本栅栏拒绝，缓存故障由旧值窗口和回源许可保护。

## 十三、怎样验证方案确实能扛住异常

正常命中压测只能证明 Redis 很快。缓存方案需要主动制造以下场景：

- 热点 key 在峰值流量中到期，确认实际 load 数量而非逻辑 miss 数量；
- 一批 key 使用相同 TTL 到期，观察数据库 QPS、连接等待和拒绝；
- Redis 延迟、断连、主从切换或部分 key 丢失，验证回源许可；
- 数据库更新与并发 miss 交错，检查旧版本能否晚到覆盖；
- 失效消息重复、乱序、暂停和恢复，检查最终缓存版本；
- L1 订阅连接断开，确认本地缓存被清空或由 TTL 收敛；
- Bloom Filter 切换版本期间创建新对象，确认不会误判不存在；
- 预热与应用发布同时发生，确认没有把数据库打到拐点之外。

一致性测试不能只比较测试结束时的最终值。旧值可能在中途被读到，随后又被新值覆盖，终态检查会漏掉违约。测试应记录每次读的 key、返回版本、读取开始与结束时间、对应写提交时间，再按新鲜度契约判断。

### 监控要覆盖命中之后的代价

| 层次 | 关键指标 |
| --- | --- |
| 业务 | 按数据类型的新鲜度违约、降级率、错误结果 |
| L1 | hit、miss、load、合并等待、淘汰、当前 weight |
| L2 | hit、miss、negative hit、延迟、错误、连接池等待 |
| Redis | ops、网络字节、内存、expired、evicted、热点 key、主从状态 |
| 回源 | DB load QPS、合并比例、锁等待、许可拒绝、查询 p99 |
| 失效链路 | Outbox backlog、CDC lag、消费延迟、失败与重放 |

`cache_hit_ratio` 下降是起点，不是根因。需要知道 miss 来自正常冷 key、过期、淘汰、显式删除还是缓存错误；也要知道一个 miss 最终产生了多少数据库 load。以 `origin_loads / unique_misses` 衡量合并效果，以 `origin_loads / total_reads` 观察源站放大，会比单一命中率更接近容量风险。

## 十四、方案选择可以从三个问题开始

方案选择取决于数据能陈旧多久、key 有多热，以及失效事件是否必须可靠。组合通常可以逐步升级：

| 场景 | 读取策略 | 写入与失效 | 保护重点 |
| --- | --- | --- | --- |
| 普通读多写少 | Cache Aside + TTL | DB 后删缓存 | 简单、可恢复 |
| 不存在查询很多 | 负缓存或 Bloom Filter | 创建时同步成员关系 | 防穿透与内存攻击 |
| 单个超级热点 | 合并加载 + 逻辑过期 | 版本化刷新 | 防击穿与旧回填 |
| 大批 key 同时生成 | TTL jitter + 分批预热 | 批次限速 | 降低失效相关性 |
| 多级本地缓存 | L1 + L2 + DB | 可重放失效或 Tracking | 断连后的陈旧边界 |
| 新鲜度要求严格 | 绕过缓存或版本协议 | write-through / lease / fence | 明确一致性保证 |

缓存收益也有下限。命中率很低、数据每次读取都不同、值比源站查询还贵、权限语义难以隔离时，增加缓存只会多一次网络访问和一套失效协议。先通过容量模型证明重复计算值得消除，再选择缓存层级。

## 十五、上线前检查清单

```text
1. 为每类数据声明权威来源、最大陈旧时间和故障行为
2. 记录 HIT、MISS、NEGATIVE_HIT、ERROR，避免把错误当 miss
3. 用真实 key 分布计算回源 QPS 和热点放大
4. 对无效输入先校验和限流，再考虑负缓存或 Bloom Filter
5. 为热点 miss 配置请求合并、回源并发和等待上限
6. TTL 加独立 jitter，预热、发布和灾备恢复都要限速
7. 写路径在数据库提交后失效缓存，并有失败重试或 CDC
8. 对乱序回填按需要加入 lease、数据版本或版本栅栏
9. 多级缓存定义失效传播、断连清空与 TTL 后盾
10. 分离可淘汰缓存和不可丢状态，设置 maxmemory 与淘汰策略
11. 演练热点过期、批量失效、Redis 故障和消息积压
12. 同时验收延迟、源站放大、陈旧违约、降级和恢复时间
```

缓存能承受高并发，靠的是一条有边界的链路：哪些请求允许进入，谁能在 miss 后加载，其他请求等待还是读取旧值，批量失效怎样打散，数据库更新如何撤销各层副本，任何一步失败后由什么机制收敛。穿透、击穿、雪崩和一致性，是这条链路在不同位置失去约束后的名字。

## 参考资料

- [Microsoft Azure Architecture Center：Caching guidance](https://learn.microsoft.com/en-us/azure/architecture/best-practices/caching)
- [Microsoft Azure Architecture Center：Cache-Aside pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)
- [Nishtala et al.：Scaling Memcache at Facebook](https://pdos.csail.mit.edu/6.824/papers/memcache-fb.pdf)
- [B. H. Bloom：Space/Time Trade-offs in Hash Coding with Allowable Errors](https://courses.cs.washington.edu/courses/csep521/21wi/readings/bloom_cacm.pdf)
- [Go x/sync：singleflight](https://pkg.go.dev/golang.org/x/sync/singleflight)
- [Caffeine：Refresh](https://github.com/ben-manes/caffeine/wiki/Refresh)
- [Caffeine：Eviction](https://github.com/ben-manes/caffeine/wiki/Eviction)
- [Redis：Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)
- [Redis：EXPIRE](https://redis.io/docs/latest/commands/expire/)
- [Redis：Client-side caching](https://redis.io/docs/latest/develop/clients/client-side-caching/)
- [Redis：Pub/Sub messaging](https://redis.io/docs/latest/develop/use-cases/pub-sub/)
- [Debezium：Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
