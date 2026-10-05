---
title: Redis Cluster：Slot、路由、扩容与热点
description: 从 16384 个固定槽出发，拆解 Redis Cluster 怎样用 CRC16 和 hash tag 把 Key 路由到分片、MOVED 与 ASK 两种重定向、cluster bus 的 gossip 与自动切换，以及扩缩容时搬槽的机制，最后说明热点键为什么无法靠槽解决。
category: 后端
subcategory: Redis
articleClass: flagship
seriesOrder: 90
featured: true
publishedAt: 2026-07-21T21:55:00+08:00
updatedAt: 2026-07-21T21:55:00+08:00
tags: [Redis, Redis Cluster, 分片, Hash Slot, 一致性哈希, 扩容, 热点, MOVED, ASK, 高可用]
---

单机 Redis 内存接近上限，加一台机器做 Sentinel 主从，数据量并没有变小：主从复制给的是同一份数据的副本，副本不会分担容量。真正让数据总量超过单机的办法，是把 Key 空间切成多份，每台机器只负责其中一部分——这正是 Redis Cluster 做的事。

但"切成多份"有很多种切法。Redis Cluster 没有用一致性哈希环，也没有按 Key 对机器数取模，而是固定了 16384 个槽（slot），让 Key 先落到槽、槽再落到节点。这个多出来的一层间接映射，决定了它扩缩容、路由和热点键的全部行为。

本文回答一个问题：Redis Cluster 怎样用固定槽把 Key 路由到正确的分片，节点增减时的槽迁移和热点键分别怎样冲击这条路由？答案可以提前说清：槽是固定的、可搬迁的分片单元，所以扩容搬的是槽而不是重算哈希；但一个 Key 永远只能属于一个槽、一个主节点，所以槽能把"许多 Key"摊匀，却分不开"单个热点 Key"。站内的[《数据超过单机后怎么拆》](/posts/database-sharding-key-routing-resharding/)讲通用分片键、路由与在线迁移，[《Redis 分片为什么会倾斜》](/posts/redis-key-sharding-skew/)讲代理分片的哈希倾斜，[《Redis 主从复制与 Sentinel》](/posts/redis-replication-sentinel-failover-data-loss/)讲主从与故障切换，本文只展开 Redis Cluster 自己这套无代理、服务端分片的实现。主要依据是 Redis 官方 Cluster 教程、[Cluster 规范](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)和 `redis.conf`，托管版产品的行为以各自文档为准。

## 一、Redis Cluster 解决什么、不解决什么

Redis Cluster 的设计目标在规范里按优先级排了三条：高性能与线性扩展（最多约 1000 个节点，无代理、异步复制、不做值合并）、可接受的写安全（尽力保留连接在多数主节点上的客户端的写入）、分区可用性（多数主节点可达、且每个失联主节点至少有一个可达副本时，集群能继续服务）。

它做的是两件事：把数据集自动分到多个主节点；在部分节点故障或失联时继续工作。它不做的也很明确：不提供强一致，不做跨 Key 的任意多 Key 操作（只支持同槽），不支持多数据库（只有 DB 0，`SELECT` 被禁止），不把热点 Key 拆开。

Redis Cluster 和 Sentinel 不是二选一的替代品，它们服务不同的拓扑。Sentinel 为"非 Cluster 的 Redis"提供高可用——一个主加若干副本，数据只有一份。Cluster 是横向扩容方案，它内部已经自带主从和自动切换，因此使用 Cluster 时不再需要 Sentinel；上一篇讲的 Sentinel 的 SDOWN、ODOWN、多数派授权，在 Cluster 里被另一套基于 cluster bus 和配置 epoch 的机制替代，后面会具体对比。

## 二、16384 个槽：固定的分片单元

Redis Cluster 的 Key 空间被切成 16384 个槽，每个主节点负责其中一部分。它明确不用一致性哈希：一致性哈希把 Key 和节点都放到哈希环上、顺时针找归属，节点数变化时只有相邻区间搬动；Redis Cluster 则是"固定槽 + 显式归属"，槽的数量永远不变，变的只是每个槽当前归哪个节点。

这个选择把"Key 属于谁"拆成了两步：

```text
slot = CRC16(key) mod 16384
node = slot_owner[slot]
```

第一步是稳定的：同一个 Key 永远算出同一个槽，与集群里有几台机器无关。第二步是可变映射：槽的归属记录在每个节点里，扩缩容时改的是这张归属表。于是加节点、减节点、调整每台机器的槽比例，本质都是"把一些槽从一台机器搬到另一台"，不触碰 `CRC16 mod 16384` 这个公式。上一篇通用分片里把逻辑桶和物理分片拆成两层，Redis Cluster 的 16384 个槽就是那个固定不变的逻辑层。

槽的数量同时决定了集群规模的硬上限：最多 16384 个主节点（规范建议实际规模控制在约 1000 个以内）。槽也是路由、迁移和故障判断的最小单位：一次故障切换接管的是某个主节点名下的整批槽，一次扩容搬的是一批槽里的数据。

![Key 经 CRC16 取模落到固定槽，槽再按归属表落到主节点](/images/posts/redis-cluster-slot-routing.svg)

这张图要区分两层映射。第一层 `CRC16(key) mod 16384` 是纯函数，客户端和节点各自独立计算，永远得到同一个槽；第二层"槽归哪个节点"是集群的共享状态，会随扩容和切换变化。扩缩容只改第二层，这也是为什么它比"对机器数取模"好运维：直接对物理节点取模时，节点数一变，第一层公式本身就得改，几乎所有 Key 都要换位置。

## 三、Key 怎样落到槽：CRC16 与 hash tag

槽的计算用 CRC16，规范指定了具体参数：XMODEM（也叫 ZMODEM、CRC-16/ACORN），16 位宽，多项式 `0x1021`，初始值 `0000`，对 `"123456789"` 的校验输出是 `0x31C3`。规范还给了 Ruby 和 C 的参考实现，说明为什么是"取 CRC16 的低 14 位再模 16384"——16384 正好是 2 的 14 次方。

这个细节的意义在于：`CRC16(key) mod 16384` 是一个跨客户端必须完全一致的协议，不是一个"大概用 CRC 就行"的约定。不同语言实现 CRC16 时，初始值、输入是否反射、输出是否反射、是否异或常量，任何一项不同都会算出不同的槽。客户端库和 `redis-cli` 必须得到同一个 slot，否则请求会被送到错误的节点。

hash tag 是这套规则里的一个例外，用来把多个 Key 强行塞进同一个槽。如果 Key 里有一个 `{...}`，且 `{` 和第一个 `}` 之间有非空内容，就只对花括号里的内容做哈希，整个 Key 其余部分不参与：

```text
{user1000}.following   -> 只哈希 user1000
{user1000}.followers   -> 只哈希 user1000，因此同槽
```

hash tag 让多 Key 命令、事务和 Lua 脚本成为可能，因为这些操作要求所有涉及的 Key 属于同一个槽，否则返回 `CROSSSLOT` 错误：

```text
MGET user:42:name user:42:email
-CROSSSLOT Keys in request don't hash to the same slot
```

规范对 hash tag 的判定写得很死：只有当 Key 里有 `{`、且它右边有 `}`、且两者之间有非空内容时，才哈希中间那段；否则整个 Key 照常哈希。于是 `foo{}{bar}` 的 `{` 后面紧跟 `}`，中间为空，整个 Key 参与哈希；`foo{{bar}}zap` 哈希的是 `{bar`（第一个 `{` 到第一个 `}` 之间）；`foo{bar}{zap}` 只哈希 `bar`，规则停在第一个 `}`。这些边角情况的意义在于：hash tag 是协议，不是"看着像就行"，Key 里一旦出现花括号，路由就会按这套规则走，与直觉可能相反。

代价也在这里：把大量 Key 压进同一个 tag，等于人工制造了一个"超热槽"。tag 用得越宽，槽分布越可能倾斜，这是后面热点一节要接住的点。

## 四、客户端怎样找到正确的节点：MOVED 与 ASK

Cluster 的节点不做代理转发。客户端把请求发给任意节点，如果 Key 不在这个节点负责的槽里，节点返回重定向错误，让客户端自己去找对的节点。

有两种重定向，语义不同。`MOVED <slot> <ip>:<port>` 是永久性的：返回它的节点知道这个槽现在归谁，客户端应该更新自己缓存的槽映射，之后直接连正确的节点。`ASK <slot> <ip>:<port>` 只在槽迁移期间出现：这个槽正在从源搬到目标，源节点上已经找不到这个 Key，客户端应该带着 `ASKING` 标志把这条命令发到目标节点试一次，但**不要**更新槽映射——迁移还没完成，槽的正式归属仍然是源节点。

```text
# 客户端向错误节点发 SET，收到 MOVED
SET user:42:profile "x"
-MOVED 741 10.0.0.2:6379

# 迁移期间源节点上缺 Key，收到 ASK（只针对这一次）
GET migrating:key
-ASK 1330 10.0.0.3:6379
ASKING
GET migrating:key
```

`redis-cli -c` 的集群支持很基础，它靠这两种重定向逐条跟随；真正的客户端会缓存"槽 → 节点"映射，正常情况下直接连正确节点，只有映射过期（例如切换后）才收到 `MOVED` 并刷新。这也解释了为什么性能能与单机持平：路由只是客户端一次本地查表，不是每请求一次代理转发。

![MOVED 是永久改路，ASK 是迁移期的一次借道](/images/posts/redis-cluster-moved-ask-redirect.svg)

这张图最关键的一句是底部那行：MOVED 要求客户端更新映射，ASK 不要求。因为 ASK 出现时槽还在迁移、正式归属没变，客户端一旦把映射改成目标节点，迁移完成前后续请求就会漏掉仍留在源节点上的其他 Key。

## 五、节点之间怎样彼此认识：cluster bus 与 gossip

每个 Cluster 节点要开两个 TCP 端口。一个是服务客户端的普通端口（如 6379），另一个是 cluster bus 端口，默认是普通端口加 10000（如 16379）。cluster bus 用一套二进制协议，专门用于节点间通信：失败检测、配置更新、切换授权、跨节点 Pub/Sub 转发，都走这里。防火墙必须同时放行两个端口，缺一个集群就会出问题。

Cluster 是全互联拓扑：N 个节点，每个节点和其他 N−1 个节点保持长连接。为了避免全互联带来的消息爆炸，节点用 gossip 协议传播信息，而不是每次都广播全体。新节点加入靠 `CLUSTER MEET`，或者由已经信任的节点 gossip 介绍；一旦形成连通图，节点会自动互相认识。

每个节点有一个 Node ID，是首次启动时生成的 160 位随机数的十六进制表示，写进 `cluster-config-file`（默认 `nodes.conf`），之后终身不变。IP 和端口可以变，Node ID 不变。`nodes.conf` 是节点自动持久化集群状态的文件，会随 gossip 消息频繁改写，规范明确说它不是给人手工编辑的。

失败判断也分两级，类似上一篇 Sentinel 的 SDOWN 与 ODOWN：一个节点在 `cluster-node-timeout`（默认 15 秒）内联系不上另一个节点，就把它标为 PFAIL（probably failed，主观）；当足够多的主节点（多数派）都这么报告，才升级成 FAIL（客观），触发真正的切换。这套判定跑在 cluster bus 上，不依赖任何外置进程。

![每个分片一主多副本，节点之间通过 cluster bus 全互联](/images/posts/redis-cluster-topology.svg)

这张图里实线框是数据路径（主复制给副本），虚线是 cluster bus。要记的运维事实有两个：一是 bus 端口是数据端口加 10000，防火墙漏开它集群不会报错、但切换永远做不了；二是全互联靠 gossip 压消息量，所以"节点失联"不是瞬时的——从单个节点标 PFAIL 到多数主节点确认 FAIL，需要 gossip 把消息传开，切换耗时里有一截花在这里。

## 六、每个分片的主从与自动切换

Cluster 里"一个分片"不是一个节点，而是一个主节点加它的副本。槽归主节点，副本复制主节点的数据；主挂了，某个副本被提升为新主，接管同一批槽。这就是为什么最小可用的 Cluster 至少要有三个主节点，生产推荐六个节点（三个主、三个副本）——只有主没有副本时，任何一个主挂掉都会让它的槽无人接管。

自动切换不用 Sentinel，靠副本之间的一场投票。发现主失联的副本会提高自己的配置 epoch，向其他主节点请求投票；拿到多数主节点的票，才能执行切换。多个副本同时竞争时，主节点更倾向投给复制进度最新（offset 最大）的那个，因为它数据最全。这与上一篇 Sentinel 的 configuration epoch 同源，只是把"哨兵"换成了集群里的主节点自己。

两个配置控制切换的边界。`cluster-replica-validity-factor`（默认 10）限制副本"旧到什么程度还能抢班"：副本与主断开超过 `factor × node-timeout` 就不允许发起切换，避免把一个落后太久的副本提上来。`cluster-replica-no-failover no` 是默认值，表示副本可以自动切换；把某个副本设成 `yes` 就等于只让它复制、永不提升。还有一个 `cluster-migration-barrier` 控制副本迁移：某个主节点一个副本都不剩时，可以从副本富余的主节点那里"借"一个副本过来，让集群在连续故障后仍尽量每个分片都有人兜底。

切换的目标始终是"让每个槽重新有人负责"，而不是"让数据不丢"。被提升的副本不一定包含主节点最后确认的写入，这一点和上一篇主从复制的结论相同。分区时，旧主若仍活着却联系不上多数主节点，会在 `node-timeout` 后停止接受写入，避免和新主同时写同一个槽；等它恢复连接，会被降级成副本、丢弃自己多出来的那部分数据。这就是 Cluster 版本的分区丢写窗口，和 Sentinel 靠 `min-replicas-to-write` 给窗口加界是同一类问题。

## 七、扩容：搬槽而不是重算哈希

因为 Key 到槽的映射是固定的，扩容的完整动作就是：把一批槽从老节点搬到新节点，改掉槽归属，新节点接管。这个过程在线完成、不停止服务，`redis-cli --cluster reshard` 或 `--cluster add-node` 会把它自动化。

一个槽从节点 A 搬到节点 B，协议上有明确的中间状态。先把 A 上的这个槽标成 `MIGRATING`，B 标成 `IMPORTING`，然后用 `MIGRATE` 命令逐个 Key 把数据从 A 搬到 B。迁移期间，A 仍然服务它手上还存在的 Key；某个 Key 已经在 A 上找不到时，A 返回 `ASK` 把客户端指向 B；B 只接受带着 `ASKING` 的查询（也就是被 ASK 转过来的那次）。所有 Key 搬完，再在全体主节点上执行 `CLUSTER SETSLOT <slot> NODE B`，把槽的正式归属改成 B，迁移结束。

这段状态机的价值在于：单 Key 命令在整个迁移期间始终可用，要么命中 A 的旧数据，要么被 ASK 到 B 的新数据；多 Key 命令因为要求同槽、而槽正处于分裂状态，可能短暂不可用。这正是上一节区分 MOVED 和 ASK 的原因——迁移没完成前，槽的归属仍然是 A，客户端不能因为收到一次 ASK 就改写映射。

```text
# 迁移一个槽的大致顺序
CLUSTER SETSLOT 1330 MIGRATING <target-id>   # 源节点 A
CLUSTER SETSLOT 1330 IMPORTING <source-id>   # 目标节点 B
MIGRATE <target> <port> "" 0 5000 KEYS <key> # 逐 Key 搬数据
CLUSTER SETSLOT 1330 NODE <target-id>        # 全部主节点，完成归属切换
```

![槽迁移的标状态、搬数据、改归属三步](/images/posts/redis-cluster-slot-migration.svg)

`MIGRATE` 有几个参数值得单独说明。`KEYS` 后面列出要搬的 Key；传一个空字符串作为 Key 名，则把该槽里当前所有 Key 一次性搬走，适合用 `CLUSTER COUNTKEYSINSLOT` 确认数量后整槽搬迁。`COPY` 只复制不删除源，`REPLACE` 允许覆盖目标上已存在的同名 Key，二者在"先双写再切"这类带校验的迁移里有用。无论用哪种，`MIGRATE` 在单个 Key 层面是原子的，迁移过程中不会出现"源删了、目标没到"的半截状态。

搬槽的数量和节奏要自己控制。一次把大量槽同时迁到新节点，会让新节点在短时间承受全量写入和载入；分批、限速、观察目标节点负载，比一条命令搬完稳妥。`redis-cli --cluster reshard` 会交互式地问"从哪搬、搬多少、搬到哪"，再一格一格执行这套状态机，适合上手；生产里更常见的做法是把迁移做成可暂停、可重试、带进度记录的脚本，而不是一条命令跑到底。

## 八、热点键为什么仍然无解

槽能让"许多不同的 Key"均匀摊到各主节点，却分不开"一个被反复访问的 Key"。一个 Key 通过 `CRC16 mod 16384` 恒等于一个槽，这个槽恒归一个主节点；所以单个热点 Key 的全部读写在集群里仍然压在一台机器上。扩容加更多主节点，不会让它分散。

这里要分清两种热点。热点槽是一个槽里的 Key 太多或访问太集中，往往来自 hash tag 用得过宽、或者 Key 设计撞在同一槽；热点 Key 是单个 Key 极热，和槽分布无关。前者可以通过调整 tag 或 Key 命名缓解，后者只能靠"不在 Redis 里硬扛"。

热点 Key 的常用缓解手段，上一篇通用分片已经展开过一部分，这里只列 Redis Cluster 语境下的取舍：

| 手段 | 怎么做 | 代价 |
| --- | --- | --- |
| 多级缓存 / 本地缓存 | 热点值前置到 CDN 或应用内存 | 一致性窗口、失效策略 |
| 读副本分摊 | 允许读旧数据时把读转到副本 | 旧读，写热点仍在主 |
| 加盐拆分 | `counter:{id}:0..15` 分散到多槽 | 读要聚合多份，破坏原子语义 |
| 请求合并 | 同一 Key 的并发读只回源一次 | 需要额外的合并层 |
| 业务拆分 | 把热点对象切成多个可独立访问的 Key | 需要改数据模型 |

加盐要特别注意：`counter:{id}:0` 到 `counter:{id}:15` 如果还带 hash tag，它们仍可能落回同一个槽，加盐就白做了——去掉 `{id}` 让每个 salt 自己算槽，才能真正散开。这也回到第三节：hash tag 是"故意聚槽"的工具，热点场景里它常常是帮倒忙的那个。

## 九、一致性与可用性边界

Redis Cluster 不保证强一致，这一点和上一篇主从复制的结论完全一致：异步复制意味着主节点返回 `OK` 后、写入到达副本前主挂了，被提升的副本可能没有这条写入。Cluster 规范把写安全描述成"尽力保留连接在多数主节点上的客户端的写入"，并明确区分两种分区场景：连在多数派一侧的客户端，丢失窗口通常很小；连在少数派一侧的客户端（还带着至少一个主节点），窗口会大得多。

少数派丢写的窗口由一个参数封顶：`cluster-node-timeout`。一个主节点在 `node-timeout` 时间内联系不到多数主节点，就会停止接受写入——所以少数派一侧最多再多写 `node-timeout` 这么久，之后自动拒写。分区在 `node-timeout` 之前愈合，数据不丢；拖过这个时间，少数派已经写的部分可能随"last failover wins"被丢弃。

可用性由另一个开关决定：`cluster-require-full-coverage yes`（默认）表示只要有任何一个槽没有被节点覆盖，整个集群停止接受写入。这是为了避免"部分数据不可用却继续收写"造成的更乱状态，代价是一个主节点连同它所有副本一起挂时，集群整体停写，即使其他分片都健康。`cluster-allow-reads-when-down no`（默认）进一步让处于 fail 状态的节点连读都不服务，防止读到不自知的旧数据。这些默认值偏向"一致"和"可解释"，放宽它们换可用性时要清楚自己在买什么。

## 十、一次扩容加迁移热点的端到端复盘

假设一个三主三从的 Cluster，主节点 A、B、C 各管约 5461 个槽。数据增长后决定加第四个主节点 D，并从 A、B、C 各搬一批槽给 D。

第一步用 `redis-cli --cluster add-node` 把 D 加入集群，再 `--cluster reshard` 指定要搬多少个槽：

```text
redis-cli --cluster add-node 10.0.0.4:6379 10.0.0.1:6379
redis-cli --cluster reshard 10.0.0.1:6379
# 交互：How many slots? 4096
#       What is the receiving node ID? <D>
#       Source node? all
```

工具会把 4096 个槽切成一格一格，逐格执行第七节的迁移状态机：标 MIGRATING/IMPORTING、`MIGRATE` 搬 Key、`SETSLOT` 改归属。迁移前后用 `CLUSTER NODES` 对一下槽范围，能看到 D 从 0 个槽变成持有 4096 个槽，A/B/C 各自让出一段。迁移过程中，落在这些槽上的请求会经历 ASK 重定向；客户端映射更新前，也会先收到若干次 MOVED。

假设其中某个槽里有一个热点 Key `hot:page:home`，访问量是其他 Key 的上百倍。迁移这个槽时，这个 Key 的每条请求都要在 A 和 D 之间被 ASK 或 MOVED 指来指去，直到 `SETSLOT` 完成、客户端映射刷新。迁移本身还会把这个热点 Key 的读放大成"源节点查不到 + 目标节点再查"，短时间内延迟上升。更根本的问题是：搬完之后，这个热点 Key 只是从 A 挪到了 D，D 成为新的热点，集群的总吞吐没有因此提升。要解决的是热点本身，而不是它的位置。

复盘这一步的价值在于把两个问题分开：扩容解决的是"槽和数据量装不下"，热点解决的是"一个 Key 的访问量压垮单机"。前者靠搬槽，后者靠缓存、加盐或改模型，二者可以同时发生，却各有各的答案。

## 十一、上线前要验证什么、平时监控什么

Cluster 的故障很少是"全挂了"，更多是某个槽迁移到一半、某个分片延迟升高、某个热点 Key 让单节点先到瓶颈。监控要从 `CLUSTER INFO` 和 `CLUSTER NODES` 入手。

`CLUSTER INFO` 里的 `cluster_state`（ok/fail）、`cluster_slots_ok`、`cluster_known_nodes`、`cluster_size` 描述整体健康：

```text
cluster_state:ok
cluster_slots_assigned:16384
cluster_slots_ok:16384
cluster_known_nodes:8
cluster_size:4
```

`cluster_slots_assigned` 与 `cluster_slots_ok` 的差，直接暴露"有多少槽没有被正常覆盖"；`cluster_state` 从 ok 变 fail，通常意味着某个分片的全部节点都不可达，或者有槽无人负责。`CLUSTER NODES` 逐节点列出角色、状态和槽范围；`CLUSTER SLOTS` 直接给"槽 → 节点"的映射，适合校验分布。迁移期间还要看 `MIGRATE` 的进度和每批耗时，别让一次大批量搬迁把网络打满。

热点检测可以用 `redis-cli --hotkeys`（需要 `maxmemory-policy` 配了 LFU）或 `--bigkeys`，但这两个工具会扫描 Keyspace，要在低峰限速执行。更实际的是看每个节点的 QPS、CPU 和网络，节点间差异持续放大通常比"某个 Key 很热"更早暴露问题——这也呼应了[《Redis 分片为什么会倾斜》](/posts/redis-key-sharding-skew/)里"节点间差异比平均值更早报警"的结论。

故障演练至少覆盖四组：杀一个主节点，看副本切换耗时和 `cluster_state` 何时恢复 ok；制造分区，确认少数派一侧在 `node-timeout` 后拒写、多数派一侧切换；在迁移一个槽时反复读写该槽的 Key，确认 ASK/MOVED 行为符合预期；删掉一个槽的覆盖（停掉某分片全部节点），确认 `cluster-require-full-coverage` 按配置停写或继续。

## 十二、什么时候该上 Cluster

| 场景 | 建议 | 理由 |
| --- | --- | --- |
| 单机内存和 QPS 都远未到顶 | 保持单机 | Cluster 带来多 Key 限制、多端口和迁移运维成本 |
| 数据量超单机，但读多写少 | Cluster，或单机 + 多副本读 | 先把读扩展用副本解决，再决定是否分片 |
| 写入吞吐超单机、Key 彼此独立 | Cluster | 线性扩展，无代理，多 Key 需求少 |
| 大量跨 Key 事务 / 复杂多 Key 命令 | 谨慎，尽量用 hash tag 聚槽 | CROSSSLOT 限制会改变数据模型 |
| 需要强一致或已确认写绝不丢 | 换具备同步复制与共识的存储 | Cluster 是最终一致、last failover wins |
| 已有代理分片（twemproxy/Codis）且稳定 | 不急着迁 | 迁移本身是成本，先评估收益 |

Cluster 不是"数据大了就上"的默认答案。它的核心收益是无代理的线性扩展和内置高可用，核心代价是 16384 槽带来的多 Key 限制、两端口拓扑和迁移运维。判断是否上，先问三个问题：单机瓶颈是不是真的来自容量或写入吞吐、业务能不能接受"多 Key 必须同槽"、能不能接受最终一致下的少量丢写。把这三个问题答清楚，再决定是搬槽扩容，还是换一条路。

## 参考资料

- [Redis 官方文档：Scale with Redis Cluster](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/)
- [Redis 官方文档：Redis cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- [Redis 官方文档：CLUSTER NODES](https://redis.io/docs/latest/commands/cluster-nodes/)
- [Redis 官方文档：CLUSTER INFO](https://redis.io/docs/latest/commands/cluster-info/)
- [Redis 官方文档：CLUSTER SLOTS](https://redis.io/docs/latest/commands/cluster-slots/)
- [Redis 官方文档：CLUSTER SETSLOT](https://redis.io/docs/latest/commands/cluster-setslot/)
- [Redis 官方文档：MIGRATE](https://redis.io/docs/latest/commands/migrate/)
- [Redis 官方配置示例：redis.conf](https://github.com/redis/redis/blob/unstable/redis.conf)
