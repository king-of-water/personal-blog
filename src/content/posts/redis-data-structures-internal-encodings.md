---
title: Redis 数据结构与内部编码：从 String、Hash 到 ZSet
description: 区分 Redis 逻辑数据类型与内部编码，拆解 String、List、Hash、Set、ZSet 的存储结构，并说明 Bitmap、HyperLogLog 与 Stream 的适用场景。
category: 后端
subcategory: Redis
articleClass: flagship
seriesOrder: 40
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Redis, 数据结构, SDS, Listpack, Quicklist, Hashtable, Skiplist, Bitmap, HyperLogLog, Stream]
---

Redis 对外暴露的是 String、List、Hash、Set、Sorted Set 等数据类型，实际存储时却不会给每种类型固定一种数据结构。一个 Hash 很小时可能紧凑地挤在一段 Listpack 中；字段和值变多以后，它又会转换成 Hashtable。同样的 `HGET`，背后可能是顺序扫描，也可能是哈希查找。

这种设计在两类成本之间取平衡。指针丰富的通用结构查询快、更新灵活，却会给每个小元素附加指针、分配器和哈希桶开销；连续内存结构很省空间、缓存局部性也好，但查找和中间修改需要移动或扫描更多字节。Redis 根据元素类型、数量、长度和配置选择编码，让小对象优先节省内存，大对象再切换到更适合查询与更新的结构。

本文基于当前 Redis 8.x 文档与开源实现讲解常见路径。内部编码不是稳定的网络协议，版本升级会改变实现，例如 Redis 7.0 用 Listpack 取代多处 Ziplist，Redis 7.2 又为小 Set 增加了 Listpack。线上判断应以目标版本、配置和 `OBJECT ENCODING` 的实际结果为准，不能把某个历史版本的默认阈值当成业务契约。

## 一、先区分数据类型、编码和底层结构

执行下面几条命令时，`TYPE` 只能告诉我们逻辑类型：

```text
SET user:1 "Alice"
HSET profile:1 name Alice age 26
ZADD rank 1200 alice 980 bob

TYPE user:1
# string
TYPE profile:1
# hash
TYPE rank
# zset
```

继续执行 `OBJECT ENCODING`，才能看到当前对象采用的内部表示：

```text
OBJECT ENCODING user:1
# embstr
OBJECT ENCODING profile:1
# listpack
OBJECT ENCODING rank
# listpack
```

Redis 中的值通常由一个对象头描述。对象头记录逻辑类型、内部编码、引用与淘汰相关元数据，并通过指针或内嵌区域找到真实数据。命令先按逻辑类型检查能否执行，再根据编码进入不同实现分支。`HGET` 对外语义不变，Listpack 与 Hashtable 版本的查找过程却不同。

![Redis 逻辑数据类型、对象编码与底层结构的关系](/images/posts/redis-object-type-encoding.svg)

图中的三层要分开理解：

- **逻辑类型**决定命令与业务语义，例如 Hash 支持字段读写，ZSet 支持排名和分数范围；
- **编码**告诉 Redis 当前对象选择了哪种紧凑或通用表示；
- **底层结构**负责实际存放字节、指针、哈希桶或有序节点。

官方的 [`OBJECT ENCODING` 文档](https://redis.io/docs/latest/commands/object-encoding/)列出了现代 Redis 的主要编码，也保留了 Ziplist、Linkedlist 等历史名称。看到旧文章写“Hash 底层是 Ziplist + Hashtable”时，应先确认它讨论的是哪个版本。现代版本的常见紧凑结构是 Listpack。

编码阈值通常可以通过 `redis.conf` 或 `CONFIG GET` 查看。例如 Hash、Set 与 ZSet 分别有 Listpack 的条目数量和元素长度限制。调整阈值是在内存与 CPU 之间换成本，不宜为了让 `OBJECT ENCODING` 看起来统一而随意修改。

## 二、String：字节序列外面为什么还要套 SDS

Redis String 是二进制安全的字节序列，可以保存文本、数字、JSON、图片片段或序列化结果。官方的 [String 文档](https://redis.io/docs/latest/develop/data-types/strings/)把它定义为 sequence of bytes；Redis 不需要用 `\0` 判断内容在哪里结束，因此 Value 中可以包含任意二进制字节。

### int、embstr 和 raw

String 常见三种编码：

- `int`：能够表示为有符号 64 位整数的值，可直接以整数形式保存；
- `embstr`：较短字符串把对象头与 SDS 放在一块连续内存中；
- `raw`：较长字符串的对象头与 SDS 分开分配，指针指向真实内容。

当前官方文档给出的 Embstr 硬编码长度上限是 44 字节。这个数字来自对象布局与分配策略，不是 Redis String 的业务长度限制。对 Embstr 做需要扩展或修改内容的操作时，Redis 通常会转为 Raw，避免在内嵌对象中完成复杂的原地调整。

![Redis String 的 int、embstr、raw 编码与 SDS 布局](/images/posts/redis-string-encodings-sds.svg)

SDS（Simple Dynamic String）在内容前保存长度与已分配容量等元数据。于是 `STRLEN` 不需要从头扫描到结尾，追加时也能根据容量决定是否扩容。SDS 仍在内容末尾保留 `\0`，方便复用部分 C 字符串函数，但长度判断不依赖这个终止符。

String 适合缓存完整对象、计数器、Token、幂等结果与简单状态。它的问题也来自“整块字节”：只修改 JSON 中一个字段，通常仍要读取、解析并重写整个 Value；Value 很大时，网络传输、复制、持久化和删除成本都会被放大。

```text
SET order:1001 '{"status":"PAID","amount":9900}'
INCR page:view:2026-10-05
SET idempotency:pay:abc SUCCESS EX 86400
```

不要因为 `GET` 的算法复杂度写成 O(1)，就认为返回 50 MB Value 与返回 50 字节一样便宜。复杂度表通常不把回复字节的网络与复制成本完整表达出来。

## 三、List：小对象用 Listpack，增长后由 Quicklist 分段

Redis List 是按插入顺序保存的字符串序列，适合从两端 Push、Pop。现代实现不等于“一个元素一个链表节点”。小 List 可以直接使用一段 Listpack；对象继续增长时，则使用 Quicklist 把多个 Listpack 节点串起来。

Listpack 是一段连续内存。每条记录保存自身编码、内容以及支持反向定位的长度信息。它省去了每个元素单独分配内存和保存多个指针的成本，遍历时也有更好的缓存局部性。代价是从中间插入、删除或寻找第 N 个元素需要扫描，修改还可能搬移后续字节。

Quicklist 在外层使用双向链表，每个节点内部放一段 Listpack。它没有在“纯链表”和“整块连续数组”之间二选一，而是把列表分成多个紧凑块：两端操作可以快速定位头尾节点，单个 Listpack 不会无限增长，中间节点还可以根据配置压缩。

![Redis List 从单个 Listpack 到 Quicklist 分段存储](/images/posts/redis-list-listpack-quicklist.svg)

这张图也解释了 List 命令的性能差异：

- `LPUSH`、`RPUSH`、`LPOP`、`RPOP` 直接处理头尾，适合队列、栈和有界时间线；
- `LINDEX`、`LSET` 需要定位下标，越靠中间通常扫描越多；
- `LINSERT`、`LREM` 要搜索元素并修改块，不适合高频随机更新；
- `LRANGE 0 -1` 会返回全部元素，List 很大时依然是大请求。

```text
LPUSH task:ready task-1001
RPUSH timeline:user:7 post-9001
LTRIM timeline:user:7 0 199
```

用 List 做简单工作队列时，`BLPOP` 等阻塞命令可以避免轮询，但 List 没有消费确认、Pending 列表和消费者组。任务被客户端 Pop 后，如果消费者在处理完成前崩溃，应用必须自己设计恢复。需要可确认消费时，Stream 往往更贴近问题。

## 四、Hash：小对象紧凑排列，大对象按字段哈希

Hash 把一个 Redis Key 映射为多组 field-value，适合保存可以独立修改字段的对象：用户资料、商品属性、配置项和计数集合。与把整个对象序列化进 String 相比，`HSET` 可以只更新一个字段，`HMGET` 也可以只读取需要的字段。

### Listpack 为什么适合小 Hash

小 Hash 的字段和值可以交替写入一段 Listpack：

```text
[field1][value1][field2][value2][field3][value3]
```

它不需要为每个字段准备独立哈希桶和指针，所以几十个短字段往往很紧凑。`HGET field3` 需要顺序比较字段，理论上是 O(N)，但 N 很小时，连续内存扫描可能比构建 Hashtable 更省空间，也不一定更慢。

当字段数量或某个字段/值长度超过配置边界，Redis 会把对象转换为 Hashtable。此后按字段查询通常是平均 O(1)，代价是桶数组、Entry、指针和 SDS 分配带来更多内存。

![Redis Hash 在 Listpack 与 Hashtable 之间的取舍](/images/posts/redis-hash-listpack-hashtable.svg)

Redis Hashtable 为扩缩容维护哈希表状态，并采用渐进式 Rehash，避免一次把所有 Entry 搬到新表造成长时间阻塞。迁移期间查找要考虑新旧表，后续操作逐步推进搬迁。渐进式不等于没有成本：大 Hash 的扩容仍会增加 CPU、内存峰值和 Copy-on-Write 压力。

新版本 Redis 支持 Hash Field Expiration，并可能为字段过期信息使用额外元数据或新的内部编码。本文图示聚焦最常见的 Listpack 与 Hashtable 路径。版本升级后，应通过 `OBJECT ENCODING`、`MEMORY USAGE` 和目标版本源代码确认实际布局。

### 一个大 Hash 还是许多 String Key

把用户所有属性放在 `user:7` 这个 Hash 中，Key 元数据只保存一次，字段可以独立读写；拆成 `user:7:name`、`user:7:city` 等多个 String，则可以分别设置 Key TTL、分散更新和迁移。选择取决于生命周期是否一致：

- 字段通常一起创建、一起过期，Hash 更自然；
- 每个字段需要独立 TTL、权限或分片，多个 Key 更清楚；
- 单个 Hash 包含数百万字段，会形成 Big Key，删除、迁移和热点都集中在一个 Slot；
- `HGETALL` 的成本与字段总量相关，不能因为 Hash 支持单字段访问就随意全量读取。

## 五、Set：Intset、Listpack 与 Hashtable 处理三类集合

Set 保存不重复成员，不维护业务顺序。它适合标签、关系集合、去重集合，以及交集、并集、差集计算。

现代 Redis 的 Set 常见三种编码：

1. 所有成员都能表示为整数且规模较小时使用 Intset；
2. 小型普通字符串集合可以使用 Listpack，Redis 7.2 起支持这条路径；
3. 元素继续增加或变长后，使用 Hashtable。

Intset 把整数按从小到大连续保存，并根据当前值域选择 16、32 或 64 位宽度。插入更大的整数可能触发整体升级，旧元素也要按新宽度重排。成员查询可以二分，但插入中间位置仍可能移动内存。

Listpack Set 同样依赖连续扫描判断成员是否已存在，适合短小集合。Hashtable 用成员作为 Key，成员存在性查询通常为平均 O(1)，更适合大型集合和频繁成员操作。

![Redis Set 的 Intset、Listpack 与 Hashtable 编码选择](/images/posts/redis-set-intset-listpack-hashtable.svg)

```text
SADD article:42:tags redis backend cache
SISMEMBER article:42:tags redis
SINTER user:7:follows user:8:follows
```

Set 运算的风险在结果规模。两个百万成员 Set 做 `SINTER`，即使单次成员判断很快，也要遍历大量数据；若把结果返回客户端或写入新 Key，还会产生网络和内存成本。集合运算应关注参与集合大小、结果基数和是否阻塞实例，不能只看单成员操作复杂度。

## 六、ZSet：为什么同时使用 Dict 和 Skiplist

Sorted Set 为每个唯一 member 关联一个 double 类型 score，并按 `(score, member)` 排序。排行榜只是最常见用法；延迟任务、滑动窗口、按时间索引的数据也经常用 ZSet。

小 ZSet 使用 Listpack，把 member 和 score 成对、按顺序保存在连续内存中。它省空间，但按 member 查找和插入位置都需要扫描，更适合元素少、member 短的集合。

达到配置边界后，ZSet 转为 Dict + Skiplist 的组合：

- Dict 建立 member 到 score 或节点的映射，`ZSCORE member` 能快速按名字定位；
- Skiplist 按 score 排序，相同 score 再按 member 排序，负责范围、排名和顺序遍历；
- Skiplist 的节点还维护 Span，用于计算 Rank，而不是从表头逐个数节点。

![Redis ZSet 使用 Dict 定位成员、Skiplist 维护分数顺序](/images/posts/redis-zset-dict-skiplist.svg)

### 一次 ZADD 怎样同时维护两份结构

添加新 member 时，Redis 先在 Dict 中判断是否已存在，再为 Skiplist 寻找插入位置，最后让两份结构指向同一份成员信息。修改已有 member 的 score 时，若排序位置发生变化，需要从 Skiplist 原位置删除并重新插入，同时更新 Dict 对应的 score/节点信息。

这种冗余是主动支付的内存成本。只用 Hashtable 可以快速按 member 查 score，却无法高效执行 `ZRANGE` 和 `ZRANK`；只用 Skiplist 可以维护顺序，但按 member 查找要沿着以 score 为序的结构搜索，无法得到平均 O(1) 的直接定位。

### 为什么不是红黑树

红黑树同样能保证 O(log N) 插入和范围起点查找，Redis 选择 Skiplist 并不表示红黑树“做不到”。Skiplist 用随机层高维持期望平衡，插入删除只调整沿途前向指针，范围扫描从起点沿最底层顺序前进，实现和调试相对直接。加入 Span 后还能支持排名。

红黑树提供确定性的高度上界，节点旋转与平衡规则更复杂。两者都是合理的有序结构选择；Redis 的结论是 Skiplist 与 Dict 的组合更符合它需要的 member 定位、score 排序、范围遍历和 Rank。面试回答如果只说“Skiplist 实现简单”，仍然漏掉了为什么旁边还必须有 Dict。

ZSet 的 score 是 double。若用整数编码时间或业务序号，需要留意双精度浮点数能精确表示的整数范围；同时要为相同 score 设计稳定的 member 排序语义。把时间戳和随机数随意拼成超大 score，可能产生精度与顺序问题。

## 七、Bitmap：用一个 Bit 表示一个布尔状态

Bitmap 并不是独立 Redis Object 类型，它建立在 String 的字节数组上。`SETBIT key offset 1` 把指定偏移位置为 1，`GETBIT` 读取单点，`BITCOUNT` 统计 1 的数量，`BITOP` 可以对多个 Bitmap 做与、或、异或。

![Redis Bitmap 怎样把用户编号映射为连续 Bit](/images/posts/redis-bitmap-user-flags.svg)

假设用用户 ID 作为 offset，记录 10 月 5 日是否登录：

```text
SETBIT login:2026-10-05 7 1
SETBIT login:2026-10-05 42 1
GETBIT login:2026-10-05 7
BITCOUNT login:2026-10-05
BITOP AND login:both login:2026-10-05 login:2026-10-06
```

Bitmap 对稠密、边界可控的整数 ID 很省空间：一亿个状态的理论 Bit 区域约 12 MB。真正占用取决于最高 offset，而不是置 1 的数量。若只写入用户 7 和用户 10 亿，String 仍要扩展到能够覆盖最高位置，中间空间不会因为都是 0 就自动消失。

它只表达布尔状态。需要保存“登录次数”“来源渠道”或精确用户列表之外的属性时，应使用 Counter、Hash、Set 或其他结构。跨天 Bitmap 的 Key 也要设置生命周期，否则每天一张位图仍会持续累积。

## 八、HyperLogLog：只回答大约有多少个不同元素

HyperLogLog 用很小且有上界的内存估算基数，例如页面独立访客数、搜索词去重数或设备数。它不保存一份可以枚举的用户集合，也不能回答“用户 7 是否访问过”。

使用接口很少：`PFADD` 加入观察值，`PFCOUNT` 返回估算基数，`PFMERGE` 合并多个统计窗口。

```text
PFADD uv:2026-10-05 user:7 user:42 user:7
PFCOUNT uv:2026-10-05
PFMERGE uv:week uv:2026-10-05 uv:2026-10-06
```

Redis 对输入做哈希，用一部分位选择 Register，用剩余位中前导零的长度更新该 Register 的最大值。大量样本的 Register 分布可以反推出基数。单个值被哈希后，原值不会作为 Set 成员保留下来。

![Redis HyperLogLog 从哈希分桶到基数估算](/images/posts/redis-hyperloglog-cardinality.svg)

Redis 官方 [HyperLogLog 文档](https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/)给出的标准误差约为 0.81%，稠密表示最多使用约 12 KB；较小时还会使用更紧凑的稀疏表示。这个误差是统计性质，不代表每次结果都恰好落在某个固定差值内。

需要计费、结算或权限判断时不能用近似值。若业务还要取回具体成员，Set 或离线明细仍然需要保留。HyperLogLog 的优势恰恰来自放弃成员枚举和绝对精确。

## 九、Stream：带 ID、消费进度与确认状态的追加日志

Stream 保存按 ID 排序的 Entry，每个 Entry 包含一组 field-value。`XADD` 追加记录，`XRANGE` 或 `XREAD` 按 ID 读取。ID 通常由毫秒时间与同毫秒序号组成，例如 `1710000000000-0`，既保持顺序，也允许同一毫秒出现多条记录。

```text
XADD order-events * orderId 1001 status PAID
XGROUP CREATE order-events billing 0 MKSTREAM
XREADGROUP GROUP billing worker-1 COUNT 10 STREAMS order-events >
XACK order-events billing 1710000000000-0
```

消费者组把“Entry 已存在”和“某个消费者处理完成”分开。消费者通过 `XREADGROUP` 领取消息后，未确认消息进入 Pending Entries List（PEL）；处理完成再 `XACK`。消费者崩溃时，其他消费者可以检查并认领长时间未处理的 Pending 消息。

![Redis Stream 的 Entry、消费者组、PEL 与 XACK](/images/posts/redis-stream-consumer-group.svg)

Stream 因此比 List 更适合需要确认和恢复的任务流，但它提供的通常是至少一次处理语义：消息可能因为超时认领、消费者重试而重复，业务处理仍要幂等。`XACK` 只更新消费状态，不会自动删除 Stream Entry；保留长度要通过 `MAXLEN`、`MINID` 或显式删除管理。

内部实现使用 Radix Tree 组织 ID 范围，并在叶子区域用 Listpack 紧凑保存多条 Entry。理解使用方式时不必先掌握这套编码，真正需要设计的是 Retention、消费者组、PEL 积压、重试和幂等。Stream 适合实例内的轻量事件流，不应只看命令相似就默认替代具备独立存储、分区扩展和完整消费治理的消息队列。

## 十、业务选型：先问需要哪种操作

选 Redis 类型时，从业务必须高效完成的操作出发。不要先决定“全都存 String”，再让应用自己实现集合和排序。

| 需求 | 优先考虑 | 原因与边界 |
| --- | --- | --- |
| 缓存整个结果、计数、状态值 | String | 简单直接；局部字段更新会重写整块 Value |
| 一个对象的字段独立读写 | Hash | 字段访问自然；避免无限增长成大 Hash |
| 从两端进出、保留最近 N 条 | List | 头尾操作便宜；不适合高频随机访问和可靠确认 |
| 唯一成员、关系与集合运算 | Set | 成员判断和交并差；结果规模可能很大 |
| 排名、时间范围、优先队列 | ZSet | 同时支持 member 定位与 score 顺序；内存高于普通 Set |
| 稠密整数 ID 的布尔标志 | Bitmap | 每个状态约一 Bit；最高 offset 决定空间 |
| 只需要近似去重数量 | HyperLogLog | 内存固定且小；不能枚举成员，结果不绝对精确 |
| 追加事件、消费组和确认 | Stream | 支持 PEL 与恢复；仍需幂等和保留策略 |

### List、ZSet 与 Stream 怎么选

只要求 FIFO/LIFO，并且任务取出后的恢复由业务自己负责，List 足够。需要按优先级、时间分数或排名取数据时使用 ZSet。需要多个消费者组、Pending 状态和消息确认时选择 Stream。三者都能“放一串元素”，但它们优化的是不同操作。

### Set、Bitmap 与 HyperLogLog 怎么选

需要取回成员、判断某个字符串是否存在或计算精确交集，用 Set。成员可以映射为稠密且有上界的整数，只关心布尔标志时用 Bitmap。只关心大集合的近似基数时用 HyperLogLog。它们的内存差异来自丢弃的信息不同，不能只按“哪个更省”选择。

### Hash 与 String 怎么选

对象总是整体读写、序列化格式由应用掌控，String 最简单。字段需要独立更新或读取，Hash 更合适。若对象需要嵌套数组、路径查询与索引，则要评估 Redis JSON 等能力，不应把复杂文档强行展开成成百上千个 Hash Field。

## 十一、常见误区：内部结构不会替业务兜底

### 误区一：记住默认阈值就等于理解编码

阈值会随 Redis 版本和配置改变，数据长度也会影响判断。更有用的理解是：紧凑编码减少对象和指针开销，通用编码为大型对象换取查询与更新效率。排查时直接查看：

```text
TYPE mykey
OBJECT ENCODING mykey
MEMORY USAGE mykey SAMPLES 5
```

再结合目标实例的配置与版本解释结果。不要用本地默认配置推断线上托管 Redis。

### 误区二：编码转换没有成本

当一个小 Hash、Set 或 ZSet 跨过边界，Redis 需要分配新结构并搬迁元素。转换发生在执行命令的线程路径上，可能造成一次延迟尖峰，也可能在 Fork 期间增加 Copy-on-Write。若对象会一次灌入大量数据，应该在压测中观察转换点附近的 P99 和内存峰值。

### 误区三：时间复杂度是完整性能结论

`SISMEMBER` 平均 O(1)，不代表一个拥有千万成员的 Set 没有内存、迁移和故障恢复成本；`GET` O(1)，也不代表返回超大 Value 便宜；`ZRANGE` 的复杂度还包含返回元素数量 M。网络字节、序列化、复制、持久化与主线程占用都属于真实成本。

### 误区四：把所有元素塞进一个 Key 更省内存

少保存一些 Key 元数据确实可能节省空间，但单个 Big Key 会集中在一个 Cluster Slot 和一个节点。访问热点、删除、过期、迁移、RDB/AOF 与主从同步都会围绕它放大。数据结构选型与 Key 拆分要一起设计。

### 误区五：有消费确认就等于 Exactly-once

Stream 的 PEL 与 `XACK` 能记录消费进度，无法让外部数据库更新与 Ack 自动成为同一个原子事务。消费者处理成功、Ack 前崩溃时，消息会再次交付。业务幂等、去重和对账仍然需要独立设计。

## 十二、把结构选择还原成三个问题

设计一个 Redis Key 时，可以依次问：

1. 必须高效完成的操作是什么：点查、头尾操作、成员判断、排序、近似计数还是可靠消费？
2. 数据会增长到多大，命令需要返回多少内容，是否会形成 Big Key 或 Hot Key？
3. 需要保留哪些信息：具体成员、精确数量、顺序、字段、消费进度，还是只要近似统计？

Redis 的内部编码在内存与 CPU 之间做了一层自适应，但它只能优化给定对象，无法修正错误的业务模型。Hash 用 Listpack 还是 Hashtable，不会改变一个千万字段 Hash 难以迁移的事实；ZSet 使用 Skiplist，也不会让一次返回百万成员的范围查询变便宜。

先用业务操作选择逻辑类型，再用规模与版本理解内部编码，最后通过 `OBJECT ENCODING`、`MEMORY USAGE` 和真实命令延迟验证。这样数据结构不再是几组需要背诵的名词，而是一套能解释内存、延迟与扩展边界的设计工具。

## 参考资料

- [Redis 官方文档：Data types](https://redis.io/docs/latest/develop/data-types/)
- [Redis 官方文档：Compare data types](https://redis.io/docs/latest/develop/data-types/compare-data-types/)
- [Redis 官方文档：OBJECT ENCODING](https://redis.io/docs/latest/commands/object-encoding/)
- [Redis 官方文档：Strings](https://redis.io/docs/latest/develop/data-types/strings/)
- [Redis 官方文档：Hashes](https://redis.io/docs/latest/develop/data-types/hashes/)
- [Redis 官方文档：Sets](https://redis.io/docs/latest/develop/data-types/sets/)
- [Redis 官方文档：Sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- [Redis 官方文档：Bitmaps](https://redis.io/docs/latest/develop/data-types/bitmaps/)
- [Redis 官方文档：HyperLogLog](https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/)
- [Redis 官方文档：Streams](https://redis.io/docs/latest/develop/data-types/streams/)
- [Redis 源码：object.c](https://github.com/redis/redis/blob/unstable/src/object.c)
- [Redis 源码：t_list.c](https://github.com/redis/redis/blob/unstable/src/t_list.c)
- [Redis 源码：t_hash.c](https://github.com/redis/redis/blob/unstable/src/t_hash.c)
- [Redis 源码：t_set.c](https://github.com/redis/redis/blob/unstable/src/t_set.c)
- [Redis 源码：t_zset.c](https://github.com/redis/redis/blob/unstable/src/t_zset.c)
