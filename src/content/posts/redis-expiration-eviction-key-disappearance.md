---
title: Redis 过期与淘汰：Key 到底为什么消失
description: 区分 TTL 到期、内存淘汰、业务删除或覆盖、故障切换与恢复差异，拆解惰性过期、主动过期、八种经典淘汰策略和现场取证方法。
category: 后端
subcategory: Redis
articleClass: flagship
seriesOrder: 60
featured: true
publishedAt: 2026-07-01T22:18:00+08:00
updatedAt: 2026-07-01T22:18:00+08:00
tags: [Redis, TTL, 过期, 淘汰, LRU, LFU, maxmemory, 故障排查, Keyspace Notification]
---

`TTL cache:product:42` 返回 `-2`，只能证明查询这一刻 Key 不存在。它没有说明 Key 曾经有没有 TTL，也没有说明是谁删的，更无法区分自然过期、内存淘汰、业务命令、故障切换和数据恢复。

线上排查最容易从这里走偏。看到 `-2` 便去翻 TTL 配置，实际可能是 `allkeys-lru` 在内存峰值期间淘汰了 Key；看到 Key 在主从切换后消失，实际可能是写入尚未复制到新主库；发现 Key 重新出现，也可能是旧 RDB 恢复了删除之前的快照。几种现象在客户端都表现为 Miss，删除机制和治理方式却完全不同。

本文回答一个问题：当一个 Redis Key 消失时，怎样从运行机制和现场证据判断它经历了什么？讨论范围是 Redis Open Source 的 Key 级过期与淘汰。Redis 7.4 起支持 Hash Field Expiration，字段过期与整 Key 消失不是同一层语义，本文只在容易混淆处说明它。

## 一、先把 Key 消失分成四类

调查开始前，先把候选原因放进四个互斥程度较高的篮子：

1. TTL 到期。Key 带有绝对过期时间，到点后由访问路径或主动过期循环删除；
2. 内存淘汰。实例超过 `maxmemory`，Redis 按 `maxmemory-policy` 选出牺牲对象；
3. 业务删除或覆盖。`DEL`、`UNLINK`、`SET`、`RENAME`、集合删空、刷新脚本等命令改变了 Key；
4. 切换或恢复差异。客户端连到了不同数据集，或者新主库、RDB、AOF 没有包含原节点上的那次写入。

![Redis Key 消失的四类原因与可观测证据](/images/posts/redis-key-disappearance-causes.svg)

图里故意把“客户端读不到”放在最左边。它只是一种观察结果，不能代表某个 Redis 内部事件。排查要继续确认实例、DB、时间窗和计数器，才能走到右侧的具体原因。

还有一些“看似消失”的情况不属于删除。例如客户端连错环境或 DB，Cluster 重定向处理错误，读副本落后，Key 名拼接规则变化，序列化层把 Nil 当成空对象。它们也会制造缓存 Miss，所以取证第一步应先证明正在观察同一个 Key 和同一份数据集。

## 二、`TTL = -2` 只是一张当前状态快照

`TTL` 以秒返回剩余生存时间，`PTTL` 以毫秒返回。两条命令有两个特殊结果：

```text
TTL cache:product:42
# 正数：Key 存在，并且还有相应秒数后到期
# -1：Key 存在，但没有设置过期时间
# -2：Key 不存在
```

`-2` 没有携带删除原因。一个从未创建过的 Key、刚被 `DEL` 的 Key、被 LRU 淘汰的 Key、已经到期并清理的 Key，结果完全一样。事后只执行一次 `TTL`，相当于事故结束后拍了一张空房间照片，无法判断谁在什么时间搬走了东西。

`TTL` 还会改变观察。假设 Key 的截止时间已经过去，但主动过期循环还没有回收它。客户端访问这个 Key 时会触发惰性过期，Redis 删除它并返回不存在。此时 `TTL` 既是读取，也是促成物理删除的访问。客户端仍然只能看到 `-2`。

正确的记录至少包含：查询时间、Redis 地址、端口、逻辑 DB、Cluster Slot、节点角色、`run_id` 或实例标识、Key 的完整字节形式，以及当时的 `PTTL` 和业务返回值。只记录“TTL 异常”会把最有用的上下文丢掉。

### TTL 保存的是截止时间

Redis 为 Key 保存的是绝对 Unix 毫秒时间戳，而非只在进程运行时递减的计数器。服务器停机期间，墙上时间仍然前进。一个剩余 30 分钟的 Key 随 RDB 一起停机 2 小时，恢复时不会重新获得 30 分钟寿命。

这个设计让持久化和复制可以传递同一个截止点，也带来两个工程要求：

- 操作系统时间必须稳定。时钟突然向未来跳，可能让一批 Key 立即被判断为过期；
- 恢复旧备份时要同时考虑快照时间和每个 Key 的绝对过期时间。备份中存在，不代表加载后还能访问。

`EXPIRE key 60` 看起来是相对时间，Redis 会把它换算为截止时刻。`EXPIREAT`、`PEXPIREAT` 直接接受绝对时间；Redis 7.0 起还可以用 `EXPIRETIME` 和 `PEXPIRETIME` 查询绝对截止点。跨服务排查时，记录绝对时间比抄一条不断减少的 TTL 更容易对齐日志。

### 哪些写操作保留 TTL，哪些会清掉

修改 Value 内部内容的命令通常保留原 TTL，例如 `INCR`、`LPUSH` 和 `HSET`。替换整个 Value 的命令通常清除 TTL，例如普通 `SET`、`GETSET` 和若干 `*STORE` 命令。`PERSIST` 会显式移除截止时间，`SET ... KEEPTTL` 则允许覆盖 Value 时保留原 TTL。

```text
SET session:7 v1 EX 300
HSET profile:7 city Beijing   # 另一个 Key，与 session:7 无关

SET session:7 v2
TTL session:7
# -1，普通 SET 覆盖 Value 后旧 TTL 已被清除

SET session:7 v3 EX 60
SET session:7 v4 KEEPTTL
TTL session:7
# 仍保留前一步设置的 TTL
```

`RENAME source target` 会把 Source 的 TTL 一起转移到 Target。若 Target 已存在，它的 Value 和 TTL 都会被覆盖。`EXPIRE key 0` 或给出过去的绝对时间会直接删除 Key，Keyspace Notification 发出的是 `del`，不是 `expired`。这些语义会让“TTL 配置没问题”成为一句不完整的结论，因为后续命令仍可能重写或取消它。

## 三、惰性过期：访问时才发现已经到点

如果 Redis 每毫秒扫描所有带 TTL 的 Key，过期会非常及时，扫描成本也会随 Key 数量持续增长。Redis 采用的第一条路径更直接：命令访问 Key 时检查截止时间，若当前时间已经越过截止点，就把 Key 删除并按不存在处理。这通常叫惰性过期，也叫被动过期或访问时过期。

```text
T0  SET coupon:1001 data PX 5000
T1  五秒过去，逻辑 TTL 已经到零
T2  GET coupon:1001
    Redis 检查截止时间，删除 Key，返回 nil
```

“逻辑到期”和“内存已经释放”之间可能有短暂间隔。客户端不会因为过期 Key 仍占着字典条目就读到旧 Value，访问路径会先做过期判断。无人访问的过期 Key 才需要额外处理：它们不再提供有效数据，却可能继续占用内存。

惰性过期还有成本集中问题。若第一次访问碰到一个很大的过期 Key，删除字典条目之外还要释放复杂 Value。开启 Lazy Free 相关配置后，Redis 可以把部分真实内存释放交给后台线程，但从 Keyspace 中摘除对象、安排异步回收仍然需要工作。大量 Big Key 同时过期，既可能造成内存回收滞后，也可能抬高访问延迟。

## 四、主动过期：用有限 CPU 清理无人访问的 Key

为清理冷 Key，Redis 周期性检查带过期时间的 Key。当前实现会运行 Slow 和 Fast 两类主动过期循环：Slow Cycle 主要按 `hz` 频率执行，Fast Cycle 在事件循环中以更短预算补充工作。算法会观察样本中过期 Key 的比例，积压明显时继续投入更多工作，同时受时间预算约束，避免一次清理长时间占住主执行路径。

![Redis Key 从 TTL 到期到惰性或主动删除的两条路径](/images/posts/redis-expiration-two-paths.svg)

图中的两条路径对应两个不同时间点：Key 到点后客户端已经把它当作不存在，`expired` 事件和内存下降却未必精确发生在 TTL 归零的那一毫秒。Keyspace Notification 在 Redis 真正删除 Key 时发布 `expired`，而不是在理论截止点发布。

`active-expire-effort` 控制主动过期愿意投入多少 CPU，默认取较保守的值，可调范围为 1 到 10。提高它通常会更积极地回收过期 Key，代价是主路径能留给业务命令的 CPU 变少。`hz` 也会影响周期任务频率。两项配置都不适合作为“过期不及时”的第一反应，先确认 TTL 分布、过期积压、CPU 余量和版本，再做压测。

`INFO stats` 提供了比猜配置更直接的信号：

```text
INFO stats

expired_keys:918273
expired_stale_perc:0.42
expired_time_cap_reached_count:37
expire_cycle_cpu_milliseconds:128944
```

`expired_keys` 是实例启动以来的累计过期数量。`expired_time_cap_reached_count` 增长，说明主动过期循环多次因为时间预算提前停止；`expired_stale_perc` 是对已逻辑到期但尚未回收比例的估计；`expire_cycle_cpu_milliseconds` 是主动过期循环消耗的累计 CPU 时间。调查某个十分钟窗口时必须计算增量，不能只拿累计总数下结论。

集中 TTL 会把平滑成本变成尖峰。例如每天 00:00 批量写入一千万个 Key，并统一设置次日 00:00 过期，下一次零点会同时产生清理、缓存 Miss 和回源请求。给 TTL 加合理抖动只能分散允许近似过期的缓存，不适合订单关闭、Token 失效这类有精确业务截止语义的数据。

## 五、过期和淘汰解决的是两件事

过期回答“这个 Key 在业务上还能活多久”。淘汰回答“内存不够时先牺牲谁”。一个还有三小时 TTL 的 Key 可以在下一秒被淘汰，一个永不过期的 Key 也可能在 `allkeys-*` 策略下消失。

当 Redis 判断受 `maxmemory` 约束的内存使用超过限制，执行需要更多内存的命令前后会尝试释放空间。若策略允许淘汰，Redis 选择候选 Key 并删除，直到回到可继续执行的状态或发现没有合适候选。若策略是 `noeviction`，或者 `volatile-*` 策略下根本没有带 TTL 的 Key，需要分配更多内存的命令会得到 OOM 错误，已有数据不会为了这条写入被删除。

淘汰不等于操作系统 OOM Kill。前者是 Redis 在进程仍然运行时按策略删除数据，`evicted_keys` 会增加；后者是进程被内核或容器终止，后续数据状态取决于持久化和恢复。两者都可能发生在“内存满了”附近，却需要完全不同的证据。

Redis 的内存不只有 Key 和 Value。复制缓冲区、客户端输出缓冲区、Lua、模块、碎片和分配器都会影响 RSS 或进程压力，其中一些项目在 `maxmemory` 计算中有特殊处理。排查应同时保存 `INFO memory`、`MEMORY STATS`、容器或宿主机指标，以及当时的连接与复制状态。只看当前 `used_memory` 很容易错过已经通过淘汰降下来的峰值。

## 六、八种经典淘汰策略怎样选择 Key

Redis 长期以来有八种经典 `maxmemory-policy`。可以先按两个维度理解：候选集合是所有 Key，还是只有带 TTL 的 Key；候选集合内按 LRU、LFU、随机或最短 TTL 选择，或者完全不淘汰。

| 策略 | 候选集合 | 选择依据 | 适合的前提 | 主要风险 |
| --- | --- | --- | --- | --- |
| `noeviction` | 无 | 不删除，写入需要更多内存时返回错误 | 数据不能被 Redis 自行丢弃 | 业务若不处理 OOM，写链路直接失败 |
| `allkeys-lru` | 所有 Key | 近似淘汰最久未访问者 | 通用缓存，近期访问能代表近期价值 | 周期扫描会污染“最近使用” |
| `volatile-lru` | 仅带 TTL 的 Key | 近似淘汰最久未访问者 | 持久 Key 与缓存 Key 混在同一实例 | TTL Key 用尽后退化为无法淘汰 |
| `allkeys-lfu` | 所有 Key | 近似淘汰低频访问者 | 访问热度长期有差异 | 热点切换速度受计数衰减参数影响 |
| `volatile-lfu` | 仅带 TTL 的 Key | 近似淘汰低频访问者 | 只允许牺牲带 TTL 的缓存 | 无 TTL Key 会挤压可淘汰空间 |
| `allkeys-random` | 所有 Key | 随机 | Key 价值和访问分布接近，选择成本要低 | 可能随机删掉热点 |
| `volatile-random` | 仅带 TTL 的 Key | 随机 | 所有 TTL Key 价值相近 | 候选不足时无法腾出空间 |
| `volatile-ttl` | 仅带 TTL 的 Key | 优先剩余 TTL 更短者 | 越接近过期，业务价值通常越低 | 短 TTL 可能恰好承载高价值热点 |

`volatile` 在 Redis 术语里指“设置了过期时间”，与内容是否经常变化无关。选择 `volatile-*` 等于相信所有没有 TTL 的 Key 都应该受到保护。若业务漏设 TTL，保护范围会不断扩大，最后只剩少量候选被反复淘汰，甚至直接返回 OOM。

### LRU 和 LFU 都是近似算法

精确 LRU 需要维护全局访问顺序，每次读写都调整链表，会增加内存和更新成本。Redis 从 Key 中随机采样，用对象元数据和候选池近似选择较久未访问的 Key。`maxmemory-samples` 越大，通常越接近理想选择，同时消耗更多 CPU。`OBJECT IDLETIME key` 可以观察对象距上次访问的大致秒数，但在 LFU 策略下不可用。

LFU 也不保存精确访问次数。Redis 用概率计数器压缩访问频率，并让历史热度随时间衰减。`lfu-log-factor` 影响计数增长速度，`lfu-decay-time` 控制衰减周期。`OBJECT FREQ key` 返回的是这个对数型计数值，不能当作业务请求次数。

因此，配置 LRU 不能保证全局最冷的 Key 一定先走。可以验证的是采样近似在目标访问分布下能否获得足够命中率。策略评估应使用真实或可代表真实分布的压测，比较命中率、回源 QPS、尾延迟和淘汰速率。

### Redis 8.6 新增了两种 LRM 策略

Redis 8.6 加入 `allkeys-lrm` 和 `volatile-lrm`，当前新版本因此有十种可选策略。LRM 是 Least Recently Modified，按照最近一次修改而非最近一次读取做近似选择。一个长期只读的热门配置可能在 LRM 下显得很久没有修改，这与 LRU 的结果不同。

“八种淘汰策略”仍然适用于 Redis 8.6 之前的经典模型和大量现有部署。新建或升级实例时，应先执行 `INFO server` 与 `CONFIG GET maxmemory-policy` 确认版本和实际能力，再按目标版本文档选择。不要把网上某张八策略表直接当成所有 Redis 8.x 的完整清单。

## 七、业务删除与覆盖往往更难留证据

显式 `DEL key` 很容易理解，生产代码却常通过更间接的方式让 Key 消失：

- `UNLINK` 先从 Keyspace 移除 Key，再异步回收 Value。客户端会立即读不到；
- `RENAME source target` 覆盖已经存在的 Target；
- `RESTORE key ... REPLACE`、`MIGRATE ... REPLACE` 或同步工具覆盖目标数据；
- `HDEL` 删除 Hash 最后一个 Field、`SREM` 删除 Set 最后一个 Member、`LPOP` 取走 List 最后一个元素，使整个 Key 一并移除；
- `FLUSHDB`、`FLUSHALL`、环境清理脚本或按 Pattern 扫描删除一批 Key；
- Cache Aside 更新先删缓存，随后回填失败或被并发请求再次删除；
- 普通 `SET` 清掉原 TTL，稍后另一段逻辑又设置了更短 TTL，事故现场只剩最终结果。

覆盖还会制造“同名 Key 仍在，数据却没了”的变体。业务只检查 `EXISTS` 可能认为 Key 没有消失，实际 Type、Value、版本号和 TTL 已经全部换过。取证时应把 Key 生命周期看成 `create → mutate → overwrite/delete → recreate`，不要只记录存在与否。

需要追责到调用方时，Redis 自带累计指标不够。应用应为高价值删除记录操作者、请求 ID、Key 前缀、旧版本、删除原因和发生时间。日志里可以对 Key 做可关联的哈希，避免直接暴露敏感标识。缓存批量失效任务还应记录计划删除数、实际删除数、扫描游标范围和重试批次。

`MONITOR` 能实时显示 Redis 收到的命令，适合隔离环境或短时间定向诊断，但它会增加明显开销，也无法充当持久审计系统。事故发生前没有采集，事后无法用 `MONITOR` 回放过去。代理层、客户端埋点或受控的命令审计通常更适合长期追踪业务删除。

## 八、故障切换和恢复会改变你看到的数据集

Key 在旧主库上存在，在新主库上不存在，客户端仍会得到 `-2`。这类事件没有任何一个 Key 被过期或淘汰，变化来自观察对象换了。

### 异步复制留下丢写窗口

Redis 主从复制默认是异步的。主库向客户端确认写入时，副本可能尚未处理这条命令。若主库在这个窗口故障，一个落后的副本被提升，新主库就不包含已确认但尚未复制的写入。旧主库稍后以副本身份加入时会同步新主库的数据集，不会自动把那条孤立写入合并回来。

`WAIT` 和 `min-replicas-to-write` 可以缩小特定条件下的风险窗口，但不能把 Redis 复制变成跨故障场景的强一致提交协议。事故分析要保存 `master_repl_offset`、各副本 Offset 与 Lag、Failover 时间，以及写请求确认时间。

过期在复制链路上也有特殊处理。主库真正让 Key 过期或淘汰时，会向 AOF 和副本传播删除操作。副本通常等待主库的删除命令，不独立执行同样的过期删除；读路径又会把已经逻辑到期的 Key 当作不存在，避免返回过期数据。副本晋升为主库后，才开始自行处理过期。因此，副本内存里可能还有对象，客户端却已经读不到它。

### RDB 和 AOF 恢复的是不同时间点

RDB 是某个时间点的数据快照。快照完成后新写入的 Key 可能在恢复后消失，快照后才删除的 Key 也可能重新出现，只要它在加载时还没有越过绝对过期时间。AOF 记录写命令并在启动时重放，通常能恢复到比 RDB 更新的位置，实际丢失窗口取决于 `appendfsync` 策略、文件是否完整和故障方式。

同时开启 AOF 与 RDB 时，Redis 重启会优先使用更完整的 AOF 重建数据集。运维如果手工换文件、从备份拉起新实例或关闭了持久化，这个默认路径可能不再成立。恢复记录应写清文件来源、生成时间、校验值、加载日志和生效配置。

TTL 截止时间也保存在持久化数据中。恢复耗时很长，或备份来自时钟有偏差的机器，加载完成时一批 Key 可能已经过期。这种缺失来自截止时间在恢复期间继续前进，不能归为恢复程序漏数据。

## 九、Keyspace Notification 能区分事件，但不是审计日志

Redis 可以通过 `notify-keyspace-events` 发布 Keyspace Notification。若只关注 Keyevent 形式的删除原因，可以按部署需求启用通用命令、过期和淘汰等类别，并分别订阅：

```text
PSUBSCRIBE __keyevent@0__:expired
PSUBSCRIBE __keyevent@0__:evicted
PSUBSCRIBE __keyevent@0__:del
```

这里有两个容易混淆的词：

- `expire` 事件表示某条命令给 Key 设置了过期时间；
- `expired` 事件表示 Redis 因 TTL 到期真正删除了 Key。

`evicted` 明确表示因 `maxmemory` 淘汰，`del` 则可能来自 `DEL`、过期时间被设置为非正数、集合删空等多种路径。Redis 8 的通知类别还可以报告 `new`、`overwritten` 和 `type-changed`，但 `AKE` 这个常用组合并不自动包含 `new`、`overwritten`、`type-changed` 与 `keymiss`，配置时要按目标版本核对字符集合。

Notification 的边界同样重要：

- 它基于 Pub/Sub，消费者断线期间的消息不会补发；
- 必须在事件发生前启用，无法查询历史；
- `expired` 在物理删除时产生，可能晚于 TTL 理论归零；
- Cluster 中每个节点只发布自己负责 Keyspace 的事件，订阅一个节点看不到全局；
- 开启大量通知会增加额外 CPU 和网络开销。

若删除历史是合规或资金安全证据，应该让业务写入耐久审计介质。Keyspace Notification 可以作为实时探针，由订阅服务转存到日志或消息系统，但不应单独承担“不丢事件”的承诺。

## 十、现场取证要先保存时间窗，再检查单个 Key

一个 Key 已经消失后，可从实例级增量、配置、事件记录和拓扑变化反推原因。以下命令适合作为只读快照，具体字段要按版本和托管平台调整：

```text
INFO server
INFO replication
INFO stats
INFO memory
INFO keyspace

CONFIG GET maxmemory
CONFIG GET maxmemory-policy
CONFIG GET maxmemory-samples
CONFIG GET active-expire-effort
CONFIG GET hz
CONFIG GET lazyfree-lazy-expire
CONFIG GET lazyfree-lazy-eviction

LATENCY LATEST
SLOWLOG GET 32
```

部分生产环境会通过 ACL 禁止 `CONFIG GET`。这时应从配置中心、部署清单或托管平台获取同一时间点的配置，不要为了排障临时放开高权限。

| 证据 | 能回答什么 | 回答不了什么 |
| --- | --- | --- |
| `expired_keys` 的窗口增量 | 该实例是否发生了 TTL 过期删除 | 具体哪个 Key 过期 |
| `evicted_keys` 的窗口增量 | 是否因 `maxmemory` 淘汰 Key | 某个 Key 是否就是被淘汰者 |
| `total/current_eviction_exceeded_time` | 内存超过淘汰阈值持续了多久 | 业务 Value 为什么增长 |
| Keyspace Notification | 订阅在线期间的事件类型和 Key | 断线前历史、可靠不丢的审计 |
| 应用或代理命令日志 | 谁发了删除、覆盖、刷新命令 | Redis 内部主动过期的全部细节 |
| `INFO replication` 与 Failover 日志 | 是否切换、复制是否落后 | 未记录的单次业务写内容 |
| RDB/AOF 文件与加载日志 | 恢复来源和可恢复时间点 | 进程运行期间的调用方意图 |
| `SLOWLOG`、Latency Monitor | 删除或过期清理是否伴随延迟 | Key 消失的唯一原因 |

任何累计计数器都要转成时间序列增量。假设 10:00 的 `evicted_keys` 是 8,000，10:10 变成 8,500，这十分钟发生了 500 次淘汰；单独看到 8,500 无法判断事故窗口是否有变化。实例重启又会重置部分累计值，所以监控还要记录 `run_id`、启动时间和重启事件。

## 十一、一次 `TTL = -2` 事故怎样走完证据链

假设商品详情缓存 `cache:product:42` 设计 TTL 为 30 分钟。14:07，大量请求回源数据库，值班同学执行 `TTL` 得到 `-2`，应用日志里没有明显的删除报错。

![Redis Key 消失事故的现场取证时间线](/images/posts/redis-key-disappearance-forensics.svg)

### 第一步：确认读的是同一个数据集

记录客户端实际连接地址、DB、Cluster Slot 和节点角色，再从同一网络路径复查。14:05 若刚发生 Sentinel 或 Cluster Failover，优先比较新旧主库复制 Offset；若只有一个应用实例 Miss，先查它的路由、连接池和 Key 拼接。

本例所有应用都连接同一主节点，`run_id` 未变化，事故窗口没有切换。拓扑差异暂时排除。

### 第二步：比较过期与淘汰计数器增量

监控显示 14:00 至 14:10：

```text
expired_keys  +12,840
evicted_keys  +286,103
used_memory   一度越过 maxmemory，随后回落
```

两类删除都发生了，淘汰增量远高于平时。这个结果仍不能证明目标 Key 被淘汰，只能把“内存淘汰”提升为强候选。继续检查 `maxmemory-policy` 为 `allkeys-lru`，目标 Key 即使还有 TTL，也属于候选集合。

### 第三步：把内存峰值与业务事件对齐

14:02 开始执行缓存预热，多个应用实例用大 Pipeline 读取数据。服务端为回复维护的输出缓冲区和同时到达的回填写入推高内存。14:03 至 14:08，`evicted_keys`、数据库回源 QPS 和缓存 Miss 同时上升。站内[《只读请求为什么也会触发 Redis Key 淘汰》](/posts/redis-read-trigger-key-eviction/)对这条输出缓冲区链路有完整复盘。

此时结论可以写成：“目标 Key 在淘汰窗口内消失，策略允许选择它，时间线与淘汰峰值一致；由于当时没有逐 Key 事件记录，无法严格证明该 Key 对应哪一次 `evicted`。”证据不足时保留这句限制，比把相关性写成确定因果更可靠。

### 第四步：补齐下一次能够定案的证据

修复动作包括限制预热批次和并发，给实例保留内存余量，为 `evicted_keys` 增量与超过 `maxmemory` 的持续时间设置报警。若需要确认具体 Key，再按容量评估开启 `evicted`、`expired`、`del` 事件订阅并转存，同时给缓存失效入口增加请求 ID 和原因日志。

若计数器显示 `evicted_keys` 没变、`expired_keys` 增长，也不能立刻断言目标 Key 自然过期。还要核对它是否曾设置 TTL、绝对截止时间、设置 TTL 的命令，以及事件窗口。实例级相关性只能缩小范围，逐 Key 生命周期记录才能定案。

## 十二、设计阶段怎样减少“无证失踪”

缓存允许丢失，不等于可以不知道为什么丢。至少要提前定义以下运行条件。

第一，明确每类 Key 的数据等级。可从数据库重建的普通缓存可以使用 `allkeys-lru` 或 `allkeys-lfu`；幂等结果、限流状态、分布式锁和任务进度不能因为带了 Redis Key 形式就默认允许淘汰。若同一实例混放不同等级的数据，策略语义会变得很难验证，最好拆分实例或明确容量隔离。

第二，把 TTL 写进数据契约。记录是谁设置、预期范围、是否允许刷新、覆盖时保留还是重置。用 `EXPIRE NX/XX/GT/LT` 可以让部分更新条件更明确，写入 Value 与设置 TTL 若要求原子一致，应使用带过期选项的单条命令、事务或经过审查的脚本，避免两条命令之间失败留下永不过期 Key。

第三，为容量留出峰值余量。`maxmemory` 不能等于机器或容器的全部内存。复制、Fork、Copy-on-Write、输出缓冲区、碎片和后台任务都需要空间。持续发生淘汰通常说明实例已经把“容量不足”转换成“命中率下降和回源压力”，它不应被当作免费的垃圾回收。

第四，保留能够回答原因的时间序列。最低集合包括 `expired_keys`、`evicted_keys`、`used_memory`、`maxmemory`、Key 数与带 TTL Key 数、命中率、回源 QPS、重启与 Failover 事件。高价值 Key 再增加业务审计或事件转存。监控维度要带实例标识，集群汇总值会掩盖单节点淘汰。

第五，定期演练四种失败。让测试 Key 自然到期，压低 `maxmemory` 触发可控淘汰，执行覆盖和删除命令，再模拟落后副本切换或从旧快照恢复。验证应用返回、报警、事件记录和恢复手册是否能区分原因。没有演练过的“我们应该能从日志看出来”，通常会在事故时变成缺失字段。

## 十三、用一张检查表结束排查

看到 `TTL = -2` 时，按这个顺序收集证据：

1. 我查的是哪个地址、端口、DB、Slot、角色和 `run_id`？
2. Key 的完整名称与编码是否和写入端一致？是否刚发生重启、切换、扩缩容或恢复？
3. 事故窗口内 `expired_keys`、`evicted_keys` 各增加多少？实例是否超过 `maxmemory`？
4. 实际 `maxmemory-policy` 是什么？目标 Key 是否在它的候选集合中？
5. 应用、代理、任务平台是否执行过 `DEL`、`UNLINK`、覆盖、集合删空或批量清理？
6. 目标 Key 最近一次写入时设置了什么绝对过期时间？后续 `SET`、`PERSIST`、`RENAME` 是否改变了 TTL？
7. Keyspace Notification 或审计日志是否捕获 `expired`、`evicted`、`del`、`overwritten`？采集是否在事件期间持续在线？
8. 若发生 Failover，新主库当时的复制 Offset 是否已经包含这次写入？若发生恢复，加载的是哪份 RDB/AOF？

Redis 不会在 `TTL` 的返回值里保存 Key 的死亡证明。TTL 到期、容量淘汰、业务命令和数据集切换最终都会收敛成“不存在”。能够区分它们的，是提前保存的时间线：过期与淘汰计数器、内存峰值、命令审计、事件订阅、复制 Offset 和恢复来源。

把 `-2` 当作调查起点，先确认观察对象，再用实例级增量缩小范围，最后用逐 Key 事件或业务日志定案。证据只能支持到相关性时，就把结论停在相关性，不要用“自然过期”填补日志里缺失的那一段。

## 参考资料

- [Redis 官方文档：EXPIRE](https://redis.io/docs/latest/commands/expire/)
- [Redis 官方文档：TTL](https://redis.io/docs/latest/commands/ttl/)
- [Redis 官方文档：Keys and values](https://redis.io/docs/latest/develop/using-commands/keyspace/)
- [Redis 官方文档：Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)
- [Redis 官方文档：Keyspace notifications](https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/)
- [Redis 官方文档：INFO](https://redis.io/docs/latest/commands/info/)
- [Redis 官方文档：Replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
- [Redis 官方文档：Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis 官方文档：Redis 8.6 新增 LRM 淘汰策略](https://redis.io/docs/latest/develop/whats-new/8-6/)
- [Redis 源码：expire.c](https://github.com/redis/redis/blob/unstable/src/expire.c)
- [Redis 源码：evict.c](https://github.com/redis/redis/blob/unstable/src/evict.c)
- [Redis 官方配置示例：redis.conf](https://github.com/redis/redis/blob/unstable/redis.conf)
