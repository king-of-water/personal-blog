---
title: Redis Big Key 与 Hot Key：发现、影响与治理
description: 分清 Big Key（单个 Key 太大）与 Hot Key（单个 Key 太热）是两个正交问题，拆解它们各自影响的网络、CPU、内存、删除、复制与迁移路径，并用 redis-cli --bigkeys/--memkeys/--hotkeys 和 MEMORY USAGE 做发现，最后给出拆 Key、UNLINK、本地缓存与加盐等治理手段。
category: 后端
subcategory: Redis
articleClass: flagship
seriesOrder: 110
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Redis, Big Key, Hot Key, 热点, 大 Key, 治理, redis-cli, LFU, UNLINK, 内存优化]
---

一个 Redis 实例突然 P99 尖峰，排查发现 `HGETALL` 一个 Hash 要几十毫秒；另一个实例 CPU 单核打满，业务说某几个 Key 每秒被读几万次。两个现象都叫"问题 Key"，但一个是 Key 太大（Big Key），一个是 Key 太热（Hot Key），成因、影响和治理办法完全不同。

把两者混为一谈，会直接导错方向：给一个"又大又热"的 Key 做本地缓存，能缓解热度，却解决不了每次失效时 `HGETALL` 的大回复；给一个"大但不热"的 Key 做加盐拆分，是白费力气。所以这篇先立一个前提：Big Key 和 Hot Key 是两个正交的维度，大说的是容量，热说的是访问频率，四种组合各有各的治法。

本文回答一个问题：Redis 的 Big Key 和 Hot Key 分别怎么发现、各自影响系统的哪些环节、又该怎么治理？站内的[《Redis 为什么快，也为什么会突然变慢》](/posts/redis-fast-and-latency-spikes/)讲过 Big Key 造成的队头阻塞和删除阻塞，[《Redis Cluster》](/posts/redis-cluster-slot-routing-resharding-hotspot/)讲过热点 Key 为何分不开，[《Redis 分片为什么会倾斜》](/posts/redis-key-sharding-skew/)讲过容量倾斜与访问倾斜的区别，本文把这些散点收拢成一套"发现 → 影响 → 治理"的框架，并补上检测工具的具体边界。主要依据是 Redis 官方命令文档与 redis-cli 说明，托管版行为以各自文档为准。

## 一、Big Key 和 Hot Key 是两个正交的问题

Big Key 指单个 Key 的值太大：一个几百 MB 的 String，或者一个有上百万元素的 Hash、List、Set、ZSet。它的问题出在"容量"——一个 Key 就占了可观的内存和网络带宽。

Hot Key 指单个 Key 被访问得特别频繁：每秒几万次读同一个 Key。它的问题出在"频率"——不管这个 Key 多大，访问都压在一台机器的一个核、一条网络路径上。

于是有四种组合：又大又热（最糟）、大而不热、小但热、小且冷。治理前先判断问题 Key 落在哪个象限：

![Big Key 与 Hot Key 是两个正交的维度](/images/posts/redis-big-vs-hot-key.svg)

这张图的价值在于阻止"一刀切"。`HGETALL` 慢，可能是 Key 大（要返回几十万字段），也可能是 Key 热（几十万并发读同一个 Key），也可能两者都是。先定位到象限，再谈手段，否则"拆 Key"治不了热度、"加缓存"治不了大回复。

"多大算大、多热算热"没有放之四海皆准的数字。Big Key 的实用定义是"对这个 Key 的一次典型操作，开始超出延迟预算或内存预算"：一个 String 大到 `GET` 都要几毫秒、一个 Hash 大到 `HGETALL` 拖垮接口、一个 Key 大到让删除卡住几十毫秒，它就是你的 Big Key，哪怕元素数"只有"几万。Hot Key 同理：一个 Key 的 QPS 开始逼近单核单命令的吞吐上限、或让某个节点的 CPU/QPS 明显高于其他节点，它就是热点，哪怕绝对值不高。阈值跟着硬件、数据结构和 SLO 走，不跟着一个固定的"大于 10MB 就算大"走。

## 二、Big Key 影响哪些环节

一个 Key 太大，代价不只在"内存多占一块"，它顺着请求路径一路放大。

![一个大 Key 顺着请求路径放大成本](/images/posts/redis-big-key-impact-path.svg)

这张图把成本按路径摊开：读是"大回复"，删是"阻塞"，复制迁移是"整 Key 传输"，碎片和过期是"隐蔽的慢"。排查 Big Key 引起的故障时，先判断它卡在哪一条路径，再选工具——慢命令看 Slow Log，删除卡顿看 `DEL`/`UNLINK` 的使用，复制慢看全量同步时间，碎片看 `mem_fragmentation_ratio`。

**读取与网络**：读一个百万字段的 Hash，`HGETALL` 要把全部字段编码成回复发出去，占用 CPU 序列化和大量网络带宽，客户端还要接收并反序列化。`redis-cli --bigkeys` 只按元素数找大 Key，真正堵住流量的是"读大 Key 的大回复"，这两者要分开看。

**CPU 与队头阻塞**：对大集合执行 `SUNION`、`SINTER`、`SORT`、全量范围查询，复杂度随元素数增长，一次执行就占住主执行路径，后面的请求全部排队。站内[《Redis 为什么快》](/posts/redis-fast-and-latency-spikes/)把这叫队头阻塞，Big Key 是它的主要来源之一。

**删除**：`DEL` 一个百万元素的 Hash 会同步释放大量对象，主线程卡住几十上百毫秒。`UNLINK` 把 Key 从键空间摘除、实际内存回收交给后台线程，能显著缩短主线程停顿；但后台释放队列、内存下降速度和总资源消耗仍要观察。

**复制与迁移**：主从全量同步要传整个数据集，一个大 Key 会拖慢全量同步；`MIGRATE` 搬槽时，一个大 Key 的序列化传输会让源和目标都停顿。Cluster 下这个问题更明显，因为搬槽按 Key 逐个搬，遇到大 Key 就卡一下。

**过期与淘汰**：一个设了 TTL 的大 Key 到期，惰性过期在访问它时触发，主动过期在抽样清理时触发，删除成本都是 O(N)。大量大 Key 集中过期，会叠成一次明显的停顿。

**内存碎片**：频繁对一个大 String 做小幅 `APPEND`、对大集合反复增删，会产生内存碎片。`INFO memory` 的 `mem_fragmentation_ratio` 偏离 1 越多，碎片越严重。

单独说一句大 String，因为它是几种影响叠加的最糟情况：一个几百 MB 的 String，`GET` 一次就把几百 MB 读进内存再发出去，`DEL` 要同步释放，全量同步要原样传输，`APPEND` 还要反复拷贝。要往 Redis 塞大二进制，先想想是不是该放对象存储、Redis 只存引用——这正是下一节"换"那条治理手段要解决的。

## 三、怎样发现 Big Key

`redis-cli` 提供了几个开箱即用的扫描工具，但它们的边界要先说清。

`--bigkeys` 用 `SCAN` 遍历整个键空间，对每个 Key 按类型统计，报告每种类型里"最大"的那个 Key。对 String 它比较的是字节长度，对 Hash/List/Set/ZSet 比较的是元素个数（`HLEN`/`LLEN`/`SCARD`/`ZCARD`，都是 O(1)）。它的局限是：只按元素数排序，不直接给内存占用；一个元素很大但元素数不多的 Key，可能比"元素最多"的 Key 更该被治理，`--bigkeys` 却不会排在最前。

`--memkeys` 同样遍历，但改用 `MEMORY USAGE` 按实际内存字节排序，更贴近"占了多少内存"这个真问题，代价是更慢——它要对每个 Key 做一次内存估算。

```text
redis-cli --bigkeys     # 按元素数找大 Key，较快
redis-cli --memkeys     # 按内存找大 Key，较慢但更准
```

要精确查单个 Key 的占用，用 `MEMORY USAGE key [SAMPLES n]`；查一个 String 的真实长度而不把它读出来，Redis 7 起可以用 `DEBUG SDSLEN key`（O(1) 拿到 SDS 长度）。`OBJECT ENCODING key` 则告诉你它当前用的是什么内部编码——一个 Hash 从 listpack 转成了 hashtable，通常意味着它已经不小了。

`--bigkeys` 适合"我不知道哪个 Key 大"的首次摸底，但排查一个已知可疑 Key 时，用下面这组 O(1) 命令更直接，也不用扫全库：

```text
# 已知可疑 Key，精确量化
MEMORY USAGE user:42:profile     # 内存字节数
OBJECT ENCODING user:42:profile  # 内部编码（listpack / hashtable / ...）
HLEN user:42:profile             # Hash 字段数，O(1)
STRLEN big:string:key            # String 字节长度，O(1)
DEBUG SDSLEN big:string:key      # Redis 7+：O(1) 拿长度，不把内容读进内存

# 不知道哪个 Key 大，用 SCAN 增量遍历后逐个判断
SCAN 0 MATCH user:* COUNT 1000
```

这套命令的区别在于代价：`HLEN`、`STRLEN`、`DEBUG SDSLEN` 都是 O(1)，`MEMORY USAGE` 对聚合类型要按 `SAMPLES` 采样估算，`SCAN` 是增量遍历、会走遍整个键空间。定位阶段先用 O(1) 的，确认范围后再用 `SCAN` 摸底，顺序不要反。

所有扫描工具都会遍历键空间，生产环境要低峰限速执行，或者用平台已有的离线采样能力。为了找大 Key 而制造新的扫描压力，得不偿失。

## 四、Hot Key 影响什么

Hot Key 的代价集中在"单点"。Redis 单节点的一条主执行路径、一个 CPU 核、一条到客户端或代理的网络路径，都被这个 Key 的访问占满。即使 Key 本身很小，几万 QPS 的读也会把单核打满、把网卡打满。

在 Cluster 里这个单点更刚性：一个 Key 恒映射到一个槽、一个主节点（上一篇 Cluster 讲过），所以热点 Key 的全部访问压在同一台机器上，加多少分片都分不开。热点读和热点写的难度也差很多：读可以靠缓存、CDN、读副本层层吸收，写（比如一个被疯狂 `INCR` 的计数器、一个不断 `LPUSH` 的队列）必须落回同一个主节点，因为单 Key 的写是串行的。热点写几乎无解，只能靠业务层聚合（把多次自增合并成一次）、加盐拆写或改数据模型。

一个容易漏掉的信号是节点间差异。集群总 QPS 看起来健康，但某台机器 CPU 已经 90%、其他机器只有 20%，这往往就是热点 Key 或热点槽。只看集群平均值会把它淹没。

## 五、怎样发现 Hot Key

`redis-cli --hotkeys` 用 LFU（Least Frequently Used）访问计数来识别热点，前提是实例的 `maxmemory-policy` 配成了 `allkeys-lfu` 或 `volatile-lfu`。没开 LFU 时它无法工作——这是最容易踩的坑：工具跑起来报"需要 LFU"，其实是要先改淘汰策略再重启或动态切换。

```text
CONFIG SET maxmemory-policy allkeys-lfu
redis-cli --hotkeys
```

`--hotkeys` 也是 `SCAN` 采样，不是精确的全量统计；它报告的是"LFU 计数很高"的 Key，计数受访问历史和采样窗口影响。它适合做一次性的热点发现，不适合做实时热力图。

LFU 计数本身有衰减：Redis 给每个 Key 维护一个访问频率计数器，长时间不被访问就会衰减。所以 `--hotkeys` 看到的是"最近一段时间访问很多"的 Key，不是"历史上累计访问最多"的 Key——这个语义恰恰是想要的，热点是当下属性，不是历史属性。但这也意味着冷启动、刚上线、刚做过批量预热时，LFU 计数还没长起来，工具可能漏报。

更可靠的实时信号是分节点的 QPS、CPU、网络和命令统计：`INFO commandstats` 看哪类命令的调用量异常，按 Key 维度的采样靠客户端埋点或代理层统计。节点间 CPU/QPS 差异持续放大，通常比"某个 Key 很热"更早、更可靠地暴露问题。没有 LFU 策略、又不想为了一个扫描工具改淘汰策略的，可以用这条路径替代 `--hotkeys`。

客户端埋点做热 Key 统计，本质上是在应用侧维护一个"Key → 访问次数"的近似计数器，定期上报、按窗口衰减。它比 `--hotkeys` 更实时，也能把"热"和业务语义（哪个接口、哪个用户、哪个商品）绑在一起，但代价是埋点本身有性能开销、要采样、要聚合，还要处理多实例去重。代理层（如果用了 twemproxy 或 Codis 一类中间层）也能在转发处统计，比客户端埋点集中，但看不到业务语义。选择哪一层，取决于你能在哪一层拿到"按 Key 的访问频率"，以及这个统计会不会反过来拖慢热路径。

## 六、治理 Big Key：拆、换、异步

前面的发现和分类，最终都指向这张治理地图：

![问题 Key 的发现、分类与治理决策](/images/posts/redis-big-hot-key-governance.svg)

这张图里最重要的是中间那格"分类"：大和热是两个维度，治理手段不能串用。图底部的三个误判，是实践中最常见的坑——用错象限，手段再勤快也白搭。

Big Key 的治理核心是"别让它作为一个整体被操作"。三个方向。

**拆**：把一个百万字段的 Hash 按业务维度拆成多个小 Hash，比如 `user:42:profile` 拆成 `user:42:profile:base`、`user:42:profile:ext`，或按字段前缀拆。拆完单 Key 的读取、删除、迁移都变小，代价是跨 Key 操作和键空间变大。这和[《Redis 分片为什么会倾斜》](/posts/redis-key-sharding-skew/)里"业务分片"是同一件事，只是目的从"分布均匀"换成了"单 Key 可控"。

```text
# 拆之前：一个 Key 装全部字段
HGETALL user:42:profile              # 一次返回几十万字段

# 拆之后：按业务维度拆成多个小 Key
HGETALL user:42:profile:base         # 基础字段
HGETALL user:42:profile:ext          # 扩展字段
```

拆的粒度怎么定，看"单次要读多少"。如果一次请求只需要其中一小部分字段，就按访问边界拆；如果确实要读全部，拆成两个也只是把一次大回复变成两次小回复，收益有限，这时该考虑换数据结构或外置。

**换**：对不需要整读的结构，用 `HSCAN`、`SSCAN`、`ZSCAN` 渐进遍历，代替 `HGETALL`、`SMEMBERS`、`ZRANGE 0 -1`；对超大二进制，把原始数据放对象存储，Redis 只存引用和元数据。命令复杂度是设计出来的，不是 Redis 强加的。

**异步**：删除用 `UNLINK` 代替 `DEL`，配合 `lazyfree-lazy-user-del`、`lazyfree-lazy-expire` 等配置，把实际内存回收从主线程挪到后台线程。异步删除降低的是停顿，不是总量，后台释放队列和内存下降速度仍要监控。

## 七、治理 Hot Key：缓存、分摊、拆写

Hot Key 的治理核心是"别让所有访问压在一个点上"。

**多级缓存**：把热点值前置到 CDN、本地内存或就近缓存，Redis 只承接缓存失效后的回源。代价是一致性窗口和失效策略；对"热点读"通常有效，对"热点写"无效。

**读副本分摊**：允许读旧数据时，把热点读转到副本，多个副本分摊读压力。写热点仍在主节点，而且副本也有自己的上限。

**加盐拆写**：对可合并的计数器类热点，用 `counter:{id}:0` 到 `counter:{id}:15` 多个 Key 分摊写入，读取时求和。上一篇 Cluster 强调过：加盐的 Key 别带同一个 hash tag，否则又会落回同一个槽，白拆一场。加盐适合可交换、可聚合的统计值，不适合需要单值强一致的状态。

```text
# 写入：随机落一个盐，分摊到多个 Key（写的是 counter:id:0..15）
INCRBY counter:id:3 1

# 读取：求和全部 16 个盐（读放大 16 倍）
MGET counter:id:0 counter:id:1 ... counter:id:15
```

加盐本质是用"读放大"换"写分摊"：写从串行压一个 Key 变成分散到多个 Key，读却要聚合全部分片。所以它只适合"写远多于读、且允许读时有短暂不一致"的计数场景；要读一个必须精确的余额或库存，加盐会破坏单值的原子语义，别用。

**请求合并**：同一 Key 的并发读只回源一次，其余等结果。需要一层合并逻辑，但能把回源压力从"N 次"降到"1 次"。

**业务拆分**：把热点对象本身切成多个可独立访问的子对象，让"读同一个逻辑对象"变成"读多个不同 Key"。这是最彻底、也最贵的办法，改的是数据模型。

治理本身也有副作用，要一起算。拆 Key 和加盐都会让 Key 数量变多：键空间变大，`SCAN`、`--bigkeys` 这类遍历更慢，聚合读要发更多次请求。把一个百万字段的大 Hash 拆成一百个小 Hash，如果读取时要 `MGET` 一百个 Key 再拼起来，等于把一次大回复换成一百次网络往返——总量没变，只是形态变了。所以拆之前先问一句：拆完之后，单次业务请求要读几个 Key？如果这个数字涨上去了，拆的收益就要打个折扣。治理的目标是让"单次操作的成本"降下来，不是让"Key 的数量"降下来，这两个目标有时冲突。

## 八、一个又大又热的 Key 从发现到治理

假设一个 Key `feed:hot:global` 是热点信息流的缓存，既大（一个几万条动态的 List，`MEMORY USAGE` 报告几十 MB）又热（首页每次刷新都 `LRANGE 0 -1` 全量读，把它所在节点 CPU 顶到 90% 而其他节点只有 20%）。

第一步用 `--bigkeys` 和 `--memkeys` 确认它的大小，用节点 CPU/QPS 差异确认它的热度，定位到"又大又热"象限。第二步拆大小：`LRANGE 0 -1` 改成 `LRANGE 0 99` 加游标分页——首页只需要前 100 条，全量读是在为不需要的数据付费；如果列表还会无限增长，再按时间窗口拆成 `feed:hot:global:20261005` 这样的分段 Key。第三步拆热度：在 CDN 或应用本地缓存第一页，只有缓存失效才回源 Redis；列表尾部如果还在频繁追加，写入侧用消息流聚合、定时批量 `LPUSH`，而不是每次请求都同步 `LPUSH`。

拆完之后回头验证，别只看"改完了"：`MEMORY USAGE feed:hot:global:*` 的单 Key 体积是否降下来了、热点节点的 CPU 是否回落到和其他节点接近、Slow Log 里还有没有 `LRANGE` 这类大命令、缓存命中率是否顶住了回源压力。治理不是"改了就算"，是"改了之后指标真的变好"，否则只是把问题从一个 Key 挪到了另一个 Key。

## 九、上线前预防，比上线后治理便宜

大部分 Big Key 和 Hot Key 是设计时埋下的，根因通常能归到三种。一是把"会无限增长的结构"塞进一个 Key：用户动态列表、会话、按天累积的日志，天然是往一个 Key 里堆东西，早晚堆大。二是读路径用了全量命令：结构本身不算大，但每次 `HGETALL`、`LRANGE 0 -1` 把整体代价暴露出来。三是业务增长或事件驱动：热点 Key 往往不是设计出来的，而是某个爆款商品、某个明星动态突然把访问量顶上去的，这类热点只能靠监控早发现、靠缓存和拆写应急。

针对前两种可以预防的根因，上线前有几件便宜的事可以做。

第一，对高基数字段的聚合结构，先用真实数据量估算单个 Key 会涨到多大，别等上线后才发现一个 Hash 要装百万字段。第二，读路径禁止"全量读"：`HGETALL`、`SMEMBERS`、`LRANGE 0 -1` 在代码评审里就该拦截，换成 `HSCAN` 或分页。第三，删除统一走 `UNLINK`，并开启 `lazyfree` 相关配置。第四，上线前用 `--bigkeys`/`--memkeys` 扫一遍测试环境的键空间，把最大的几十个 Key 逐个过目。第五，给每个"会增长"的 Key 定一个上限和拆分的触发条件，而不是等它自然涨到出问题。

监控侧至少要区分"大"和"热"两类信号：大 Key 看 `MEMORY USAGE`、最大 Key 大小、`mem_fragmentation_ratio`；热 Key 看分节点 CPU/QPS 差异、`INFO commandstats` 的调用分布、Slow Log 里的大回复。节点间差异比集群平均值更早报警，这一点在[《Redis 分片为什么会倾斜》](/posts/redis-key-sharding-skew/)里已经强调过。

## 十、落到一张决策表

| 现象 | 判断 | 优先手段 | 要避免的坑 |
| --- | --- | --- | --- |
| 单 Key 很大、读很慢 | Big Key | 拆 Key、渐进遍历、外置大对象 | 用 `--bigkeys` 只看元素数 |
| 单 Key 访问极高 | Hot Key | 多级缓存、读副本、请求合并 | 给热点写也硬加缓存 |
| 又大又热 | 两者叠加 | 先拆大小，再拆热度 | 只治其一，另一个复发 |
| 删除大 Key 卡顿 | Big Key 删除 | `UNLINK` + `lazyfree` | 只换命令不配 lazyfree 配置 |
| 集群单节点 CPU 打满 | 热点/热点槽 | 定位热点 Key，分摊或拆分 | 只看集群平均值 |

Big Key 和 Hot Key 都源于同一个习惯：把一个会变大、会变热的对象当成一个不可分割的 Key 来用。Redis 的键模型很灵活，代价是你要自己决定"一个 Key 装多少、被读多狠"。把这个决定做在写 Key 之前，比上线后拿着一堆 `--bigkeys`、`--hotkeys` 的输出去救火，要便宜得多。反过来也不必洁癖：一个"大但几乎从不整读"的 Key，如果只是按字段被访问，不拆也不影响什么。判断的依据始终是访问模式，不是体积数字本身。

## 参考资料

- [Redis 官方文档：redis-cli](https://redis.io/docs/latest/develop/tools/cli/)
- [Redis 官方文档：MEMORY USAGE](https://redis.io/docs/latest/commands/memory-usage/)
- [Redis 官方文档：OBJECT ENCODING](https://redis.io/docs/latest/commands/object-encoding/)
- [Redis 官方文档：UNLINK](https://redis.io/docs/latest/commands/unlink/)
- [Redis 官方文档：SCAN](https://redis.io/docs/latest/commands/scan/)
- [Redis 官方文档：Memory optimization](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
- [Redis 官方文档：Latency](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/)
