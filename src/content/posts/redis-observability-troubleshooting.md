---
title: Redis 线上排障与可观测性
description: 把 Redis 的可观测性信号分成指标、事件、命令级统计三层，逐段解读 INFO 各字段回答什么问题，建立"从现象到根因"的排障决策树，覆盖慢命令、内存、CPU、复制与持久化的交叉定位，并给出告警设计和排障工具的成本边界。
category: 后端
subcategory: Redis
articleClass: flagship
seriesOrder: 120
featured: true
publishedAt: 2026-07-25T14:44:00+08:00
updatedAt: 2026-07-25T14:44:00+08:00
tags: [Redis, 可观测性, 排障, INFO, SLOWLOG, Latency Monitor, 监控, 告警, 指标, 故障排查]
---

凌晨三点，Redis 的 P99 突然从 2 毫秒涨到 200 毫秒。值班的人打开监控，看到一堆曲线都在动，不知道该先看哪条。这时候"会查 INFO"和"知道按什么顺序查"是两回事：Redis 的 `INFO` 有十几个段、几百个字段，`SLOWLOG`、`LATENCY`、`MONITOR` 各有各的边界，不建立一套信号模型，就只能每条曲线都点开、每个字段都猜一遍。

Redis 排障最大的特点，是它没有像微服务那样的分布式 Trace 可以把一次请求串起来。你能拿到的是一堆**聚合指标**（`INFO`）、一批**事件记录**（Slow Log、Latency Monitor）、一些**命令级统计**（`commandstats`、`latencystats`），以及代价很高的**原始流量**（`MONITOR`、抓包）。排障的本质，是从"现象"出发，在正确的层级上取到正确的信号，再交叉到根因。

本文回答一个问题：Redis 线上出问题时，怎样用指标、事件和命令级统计，从现象定位到根因？这是 Redis 系列的收官，它不重新讲慢命令、Big Key、Fork、复制这些具体机制——那些分别在[《为什么快，也为什么突然变慢》](/posts/redis-fast-and-latency-spikes/)、[《Big Key 与 Hot Key》](/posts/redis-big-key-hot-key-discovery-impact-governance/)、[《主从复制与 Sentinel》](/posts/redis-replication-sentinel-failover-data-loss/)、[《持久化》](/posts/redis-persistence-rdb-aof-data-loss-boundaries/)里讲过。这里做的事是把这些机制的监控点，收拢成一套"先看什么、后看什么、怎么交叉"的排障框架。主要依据是 Redis 官方命令文档和运维文档，托管版行为以各自文档为准。

## 一、先给信号分层：指标、事件、命令、原始

Redis 能拿到的可观测性信号，按"粒度从粗到细、代价从低到高"可以分成四层。

**指标（metric）**是聚合后的数值：`INFO` 里的 `used_memory`、`instantaneous_ops_per_sec`、`connected_clients`、`master_repl_offset`，以及你在监控系统里按时间存下来的那些曲线。指标便宜、适合自动告警和看趋势，但它只告诉你"哪个数值偏离了"，不告诉你"为什么"。

**事件（event）**是 Redis 主动记录的异常片段：`SLOWLOG` 记慢命令，Latency Monitor 记 `fork`、`expire`、`command` 等延迟事件。事件比指标贵一点，但保留了"哪条命令、什么时候、花了多久"这类指标丢失的细节。

**命令级统计（command stats）**是 `INFO commandstats` 和 `INFO latencystats`：按命令聚合的调用数、总耗时、失败数，以及按命令的 P50/P99/P999。它把"整体慢"拆到"哪类命令慢"。

**原始流量（raw）**是 `MONITOR`、抓包、`--stat` 这类：能看到每一条命令。代价最高，`MONITOR` 会显著增加 CPU，生产环境基本不该长开。

![Redis 可观测性信号的四个层级](/images/posts/redis-observability-signal-layers.svg)

这张金字塔是排障的总纲：**从指标发现问题，用事件和命令统计定位，只在必要时才动原始流量**。反过来做——一上来就 `MONITOR`、抓包——既贵又容易被噪音淹没。大多数 Redis 排障在"指标 + 事件 + 命令统计"三层就能收敛，原始层是兜底。

排障还要注意观察的三种时间尺度。瞬时快照是 `INFO` 的当前值，只能回答"现在是什么样"；趋势是存下来的时间序列，能回答"是不是在恶化"；历史回放是 `SLOWLOG`、`LATENCY` 里带时间戳的事件，能回答"五分钟前那一刻发生了什么"。事故排查最常犯的错，是用"现在的瞬时快照"去解释"五分钟前的尖峰"——尖峰过去了，当前值一切正常，你就什么都看不到。所以关键信号必须存成时间序列、事件必须带时间戳，二者缺一，事故就查不回去。

## 二、INFO 各段分别回答什么问题

`INFO` 是排障的入口，但它有十几个段，每个段回答一类问题。把它当成"分科门诊"，先知道该挂哪一科。

| INFO 段 | 回答的问题 | 关键字段 |
| --- | --- | --- |
| server | 实例的版本、运行时长、配置态 | redis_version, uptime_in_seconds |
| clients | 有多少连接、是否积压 | connected_clients, blocked_clients, client_recent_max_input/output_buffer |
| memory | 内存用在哪、是否碎片、是否淘汰 | used_memory, mem_fragmentation_ratio, maxmemory, evicted_keys |
| persistence | RDB/AOF 是否健康 | rdb_last_bgsave_status, aof_last_write_status, aof_rewrite_in_progress |
| stats | 请求量、命中率、拒绝、键空间变化 | instantaneous_ops_per_sec, keyspace_hits/misses, rejected_connections, expired_keys |
| replication | 主从角色与复制进度 | role, connected_replicas, master_repl_offset, master_link_status |
| cpu | CPU 用在哪 | used_cpu_sys, used_cpu_user |
| commandstats | 哪类命令消耗最多 | calls, usec, usec_per_call, rejected_calls |
| latencystats | 哪类命令的尾延迟高 | 各命令的 P50/P99/P999 |
| keyspace | 各库有多少 Key、平均 TTL | keys, expires, avg_ttl |

这张表的价值是"现象 → 段"的快速映射：延迟高先看 `stats` 和 `latencystats`，内存告警看 `memory`，写不动看 `persistence` 和 `stats` 的 `rejected_connections`，副本落后看 `replication`。先定位到段，再深入字段，比从 `INFO` 第一行读到末尾快得多。

`commandstats` 和 `latencystats` 尤其要一起看。`commandstats` 的 `usec_per_call` 是累计平均值，尖峰容易被平均掉；`latencystats`（Redis 7 起默认提供）给出 P50/P99/P999，能暴露平均看不出的尾延迟。一条命令 `usec_per_call` 正常但 P999 很高，说明它平时快、偶尔被什么拖住——这通常是 Fork、过期、系统调度在作祟，而不是命令本身慢。

读 `memory` 段也要这样拆着看，而不是只看 `used_memory` 一个数：

```text
used_memory:3000000000
maxmemory:4000000000
mem_fragmentation_ratio:1.80
client_recent_max_output_buffer:209715200
```

假设 `used_memory` 3GB、`maxmemory` 4GB，看起来还有余量。但 `mem_fragmentation_ratio` 是 1.8，实际申请的物理内存接近 5.4GB，碎片吃掉了近一半；再往下 `client_recent_max_output_buffer` 显示某个连接的输出缓冲区到过 200MB。这三行连起来，根因不是"数据太多"，而是"一个慢消费者撑大了输出缓冲区 + 碎片累积"。只看 `used_memory` 一个数字，就会得出"该加内存"的错误结论。

## 三、从现象出发的排障决策树

排障不要从"我要查什么指标"开始，要从"用户看到了什么现象"开始。下面这张决策树把常见现象接到第一层该看的信号。

![从现象到根因的 Redis 排障决策树](/images/posts/redis-troubleshooting-decision-tree.svg)

**延迟高**：先分清延迟发生在 Redis 内还是 Redis 外。应用端延迟高、同位置 `redis-cli --latency` 也高、Slow Log 平静，优先查网络、系统调度、Fork；只有 Slow Log 也有记录，才往"慢命令"查。这层区分在[《为什么快》](/posts/redis-fast-and-latency-spikes/)里展开过，是排障最容易走错的岔路。

**内存高**：看 `memory` 段的构成——是 Key 数据真的大（`used_memory` 涨），还是碎片（`mem_fragmentation_ratio` 高），还是客户端输出缓冲区（`client_recent_max_output_buffer`）。三者治理方向完全不同。

**CPU 高**：看 `cpu` 段是 sys 还是 user 占得多，再对照 `commandstats` 找是哪类命令在烧 CPU。单核 CPU 高而总 CPU 低，是单主执行路径被某类命令占满，不是"机器不够"。

**错误率**：看 `stats` 的 `rejected_connections`（连接被打满）、`evicted_keys`（内存不够在淘汰）、`keyspace_misses` 异常（缓存穿透）。错误类型会直接指向根因域。

**副本落后**：看 `replication` 段的 offset 差，再决定是传输慢还是回放慢——这在前面的复制文章里拆过。

CPU 高和错误率这两支尤其容易判错，值得各补一句。CPU 高时，`cpu` 段的 `used_cpu_sys` 和 `used_cpu_user` 都是累计秒数，要看它们各自的**增长速率**；`used_cpu_sys` 涨得快往往指向系统调用、Fork、`fsync` 这类内核侧开销，`used_cpu_user` 涨得快指向命令本身在烧 CPU。再对照 `commandstats` 找是哪类命令，才能确定是"该优化命令"还是"该调持久化"。错误率则先分清错误的种类：`rejected_connections` 是连接数被打满（和 `maxclients`、连接池相关），`evicted_keys` 是内存不够在淘汰，`keyspace_misses` 异常是缓存命中率掉了——三种错误指向三个完全不同的根因域，混在一起看"错误率上升"就失去了定位力。

## 四、慢命令的完整排查链

慢命令是最常见的排障入口，但它不是"看到 Slow Log 就完事"。一条完整的排查链是：

```text
1. SLOWLOG GET 20            # 有哪些命令超过了阈值
2. INFO commandstats          # 哪类命令累计耗时最多
3. INFO latencystats          # 哪类命令尾延迟高
4. LATENCY LATEST            # Redis 内部事件（fork/expire/aof）是否尖峰
5. 交叉：命令慢 + 事件平静 -> 命令本身慢；命令平静 + fork 尖峰 -> 后台任务
```

`SLOWLOG` 只记"执行时间超过 `slowlog-log-slower-than` 的命令"，不记网络、不记等待、不记 Fork。所以 Slow Log 为空不能证明 Redis 没问题——它只证明"没有单条命令执行超过阈值"。阈值设得比故障窗口还高、或 `slowlog-max-len` 太小把现场冲掉，都是"查了等于没查"的坑。

读一条 `SLOWLOG` 记录，要看的不是"哪条命令"，而是它的三个附加字段：执行耗时、命令参数、以及**它发生的时间戳**。时间戳决定了这条慢命令能不能和监控曲线、`LATENCY` 事件对齐；只看到"`KEYS *` 慢"，不把它钉到具体时间点，就无法判断它是不是那五分钟 P99 尖峰的元凶。`SLOWLOG` 的真正价值不是"列出慢命令"，而是"给慢命令打上时间戳，让你能去别的信号里对账"。

`LATENCY LATEST` 记的是 Redis 主动检测到的事件延迟，事件类型包括 `command`、`fork`、`expire-cycle`、`aof-fsync-always` 等。它和 Slow Log 的边界不同：Slow Log 看"哪条命令慢"，Latency Monitor 看"哪个内部阶段慢"。一个 `fork` 尖峰和业务命令的 P999 尖峰在时间轴上对齐，根因就从"命令"转向"后台持久化"——这条交叉在[《为什么快》](/posts/redis-fast-and-latency-spikes/)里是排查 P99 尖峰的关键一步。

## 五、内存问题的排查链

内存问题比慢命令更隐蔽，因为它常常是"慢慢涨上去"的，告警触发时已经接近上限。

第一步看构成：`used_memory` 涨，是数据真的多了，还是客户端缓冲区、复制缓冲区、AOF 缓冲区占了。第二步看碎片：`mem_fragmentation_ratio` 远大于 1，是频繁增删大对象留下的洞，`activedefrag` 或重启能收回来一部分，但根因在写入模式。第三步看淘汰：`evicted_keys` 在涨，说明已经触到 `maxmemory`，Redis 在用数据换空间，这不是"内存还够"的信号。

内存排查最容易漏的是**客户端输出缓冲区**：一个订阅了频道却读得慢的客户端，或一次返回大结果的连接，会把输出缓冲区撑大，推高整个 `used_memory`。站内的[只读请求触发 Key 淘汰复盘](/posts/redis-read-trigger-key-eviction/)就记录了一条"客户端输出缓冲区推高内存"的完整故障链。`CLIENT LIST` 里的 `omem` 字段是定位这类问题的入口：

```text
CLIENT LIST
# id=... addr=... name=subscriber age=... omem=187904819 qbuf=... qbuf-free=...
```

`omem` 是"这个连接还没发给客户端的输出缓冲字节数"。一个 `omem` 几亿、`age` 很老的连接，几乎就是"订阅了却读不动"或"拿到大结果却消费不动"的元凶。揪出它之后，处置方向是限制该客户端的输出缓冲、断开异常连接或给它单独限流，而不是继续加内存。

## 六、一次端到端的排障走查

假设监控报警：某 Redis 主节点 P99 每五分钟尖峰一次，同时 `used_memory` 缓慢上涨，CPU 在尖峰时刻小幅跳。

先按决策树，把现象拆到两条线。延迟线：应用端和 `redis-cli --latency` 都尖峰，Slow Log 平静，说明不是业务慢命令；`LATENCY LATEST` 里 `fork` 事件每五分钟一次、和 P99 对齐，指向后台持久化。内存线：`memory` 段 `mem_fragmentation_ratio` 偏高、`used_memory` 在尖峰前后有台阶式上涨，指向 Fork 期间的 Copy-on-Write 放大。

两条线交叉，根因收敛成一个：每五分钟触发一次 `BGSAVE` 或 AOF 重写，Fork 停顿让 P99 尖峰，后台保存期间的写入触发 COW 让内存台阶式上涨。修复不是"加内存"或"调超时"，而是调整快照频率、给 COW 预留内存、或拆小数据集——这些动作对应的是根因，不是症状。

这个走查的价值在于展示了排障的正确姿势：**多路信号交叉，而不是在一条曲线上反复放大**。单一指标（P99、内存、CPU）都只能描述症状的一个侧面，把它们和事件（Fork）、命令统计（`commandstats` 是否平静）对齐，根因才从"猜"变成"证"。

把这个结论落到可观测的证据上，就是三组信号在同一时间轴对齐：`LATENCY LATEST` 里 `fork` 的峰值、`used_memory` 的台阶、P99 的尖峰，三者共享同一个五分钟周期。任何一个单独拿出来都解释不了全貌——`fork` 只说明发生过 Fork，`used_memory` 只说明内存涨了，P99 只说明变慢了。把它们对齐，根因才从"好像和持久化有关"变成"就是 `BGSAVE` 的 Fork 停顿加 COW 放大"。

## 七、告警设计：告什么、阈值怎么定

告警是"指标"这层信号落到自动化的产物，但它很容易做成两种失败：一种是告太多，值班的人麻木后忽略；一种是告太少，出问题没人知道。

告警应该绑定"影响"而不是"数值"。`used_memory` 到 80% 只是"快到线了"，真正影响用户的是"延迟超出 SLO"、"错误率上升"、"写入被拒绝"。把告警建立在延迟分位、错误率、`rejected_connections`、`evicted_keys` 这些"已经开始影响业务"的信号上，比建立在"内存用了多少"上更接近"要不要叫醒人"。

阈值要区分稳态和后台任务窗口。只在刚启动、没有 `BGSAVE` 时测出来的基线，不适用于生产重写窗口——这一点在[《持久化》](/posts/redis-persistence-rdb-aof-data-loss-boundaries/)里反复强调。节点间差异比集群平均值更早暴露倾斜，这一点在[《分片为什么会倾斜》](/posts/redis-key-sharding-skew/)和[《Big Key 与 Hot Key》](/posts/redis-big-key-hot-key-discovery-impact-governance/)里都有体现。

最后，告警要带"下一步"：每条告警都应该能回答"收到这条告警后，我先看哪个段、哪条命令、哪个字段"。否则告警只是把问题从系统转给了半夜的人，而没有给任何线索。

一组可以直接落地的告警起点：

| 告警 | 触发条件（示意） | 收到后先看 |
| --- | --- | --- |
| 延迟超 SLO | 应用端 P99 连续超预算 | `latencystats` + `LATENCY LATEST` |
| 命令被拒绝 | `rejected_connections` 增长 | `connected_clients` + 连接池 |
| 触发淘汰 | `evicted_keys` 速率上升 | `memory` 段 + 客户端缓冲区 |
| 持久化失败 | `rdb_last_bgsave_status != ok` | `persistence` 段 + 磁盘 |
| 副本落后 | offset 差持续扩大 | `replication` 段 |
| 后台任务排队 | Fork 事件尖峰 | `LATENCY LATEST fork` |

这里有个容易忽略的细节：`INFO` 里很多计数是**累计值**，不是速率。`evicted_keys` 是"历史上一共淘汰了多少"，直接看这个数字只会一直涨；要告警的是它的**变化率**——每分钟淘汰了多少。把累计值转成速率、把单点快照转成时间序列，是做 Redis 告警的基本功。只看一次 `INFO` 的当前值，看不到"五分钟前的尖峰"，也看不到"正在加速"。

## 八、排障工具的成本边界

排障工具本身也有成本，用错了会雪上加霜。

`MONITOR` 会把所有命令流经的输出写到连接，显著增加 CPU 和网络，生产环境不该长开，只适合极短的、已定位到某个连接的采样。`redis-cli --bigkeys`/`--memkeys`/`--hotkeys` 都遍历键空间，要在低峰限速，为了找问题制造新的扫描压力得不偿失。`--intrinsic-latency` 会占满一个核，不该在繁忙生产节点直接长跑。

`redis-cli --latency` 和 `SLOWLOG` 的边界也要记住：前者测的是客户端到 Redis 的往返，后者测的是命令执行时间，两者都不覆盖对方的盲区。把它们当成"同一台机器的两个探针"，交叉起来才能判断延迟在链路的哪一段。

实时观察和事后取证是两种用途，工具也不同。`redis-cli --stat` 每秒刷一行实时统计，适合盯着看"现在"的变化，但它不落盘、不回溯；`redis-cli --latency` 实时看往返，适合确认"现在慢不慢"；`SLOWLOG` 和 `LATENCY HISTORY` 是事后回溯，适合还原"刚才发生了什么"。现场还在时用实时工具追，现场过去了只能靠带时间戳的历史——所以别把实时工具当成事后证据来存，也别指望事后用实时工具去追已经消失的尖峰。

一个实用的原则是**先取证、再处置**。事故现场最贵的不是恢复，是恢复之后没有留下能定位根因的证据。`INFO`、`SLOWLOG`、`LATENCY`、`CLIENT LIST`、`CONFIG GET` 的现场快照，比事后回忆"当时好像内存很高"有价值得多。处置动作（重启、`FLUSHALL`、改配置）会销毁证据，所以取证的顺序排在处置之前。

一套最小的事故取证快照可以这样排：

```text
CONFIG GET maxmemory maxmemory-policy appendonly   # 生效配置
INFO server memory stats persistence replication  # 关键段
SLOWLOG GET 100                                    # 慢命令历史
LATENCY LATEST                                     # 内部事件
CLIENT LIST                                        # 连接与输出缓冲区
```

先把这五样落到本地文件、带上时间戳，再动手处置。重启之后 `INFO` 的累计计数、`SLOWLOG`、`CLIENT LIST` 全都会变，这些快照是事故之后唯一能还原现场的东西。取证的顺序排在处置之前，这是排障纪律，不是可选项。

## 九、把可观测性做成一件事，而不是一堆命令

把这一整套收拢起来，可观测性不是"记住一堆命令"，而是一条从现象到根因、再到验证的闭环：

1. 现象 → 决策树 → 定位到 INFO 的哪个段；
2. 段 → 字段 → 定位到哪类信号（指标/事件/命令统计）；
3. 多路信号交叉 → 收敛到一个根因，而不是一个症状；
4. 处置 → 回看指标，验证根因是否真的消除。

前四步是排障，第五步是验证。很多人做到第四步就停了：改完配置、重启完、扩容完，没有回头确认"延迟分位回来了吗、内存增长平了吗、错误率降了吗"。没有第五步，你就不知道这次是"修好了"还是"碰巧恢复了"。

Redis 的可观测性信号是零散的——指标、事件、命令统计散在 `INFO`、`SLOWLOG`、`LATENCY` 各处，没有一个统一的面板替你串起来。把它串起来、并知道每一步看什么的，是你自己的排障框架。这正是这套信号分层和决策树要给的：不是更多的命令，而是更少的、有顺序的、能交叉的观察。

把这套框架落到团队，可以用一张自查清单检验排障能力是否就绪：指标有没有存成时间序列、累计值有没有转成速率；慢命令告警是否基于 `latencystats` 的分位而不是平均；`LATENCY LATEST` 是否在事故前就启用了、阈值是否和 SLO 对齐；节点间差异有没有单独告警、而不是只看集群平均；每条告警有没有对应的"先看哪个段、哪个字段"的 runbook；事故取证快照是不是一条命令就能抓齐。六条里缺任何一条，排障都会在某个环节变成靠运气。

可观测性的建设也讲优先级：先做指标时间序列——这是所有告警和趋势判断的地基；再做慢命令和 Latency Monitor 的事件采集——这是定位能力的核心；命令级分位统计在 Redis 7 之后默认就有、打开监控采集即可；原始流量层永远只做兜底、不进日常。地基不稳时去堆上层工具，是用昂贵的手段补便宜的事。

这一系列从单条命令讲到主从、Cluster、事务、Big Key 与热点，再到这篇排障，串起来是一条完整的 Redis 心智模型：命令怎么执行、数据怎么存、副本怎么追、分片怎么切、问题怎么查。排障是这条模型的最后一环，也是最考验综合的一环——它要求你在同一条时间轴上，同时读懂执行、持久化、复制、分片和内存各自发出的信号。前面的每一篇都是这一篇的一块拼图。

## 参考资料

- [Redis 官方文档：INFO](https://redis.io/docs/latest/commands/info/)
- [Redis 官方文档：SLOWLOG](https://redis.io/docs/latest/commands/slowlog/)
- [Redis 官方文档：Latency monitoring](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency-monitor/)
- [Redis 官方文档：Diagnosing latency issues](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/)
- [Redis 官方文档：Redis CLI tools](https://redis.io/docs/latest/develop/tools/cli/)
- [Redis 官方文档：CLIENT LIST](https://redis.io/docs/latest/commands/client-list/)
- [Redis 官方文档：MONITOR](https://redis.io/docs/latest/commands/monitor/)
