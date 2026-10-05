---
title: Redis 主从复制与 Sentinel：故障切换会不会丢数据
description: 从复制流、replication ID 与 offset 出发，拆解 Redis 主从复制的部分/全量重同步、Sentinel 的 SDOWN 与 ODOWN、quorum 与多数派选主、副本选择与分区丢写窗口，以及怎样用 min-replicas-to-write 和 WAIT 把数据丢失边界压到可量化。
category: 后端
subcategory: Redis
articleClass: flagship
seriesOrder: 80
featured: true
publishedAt: 2026-07-21T20:20:00+08:00
updatedAt: 2026-07-21T20:20:00+08:00
tags: [Redis, 主从复制, Sentinel, 高可用, 故障切换, 复制流, PSYNC, 数据丢失, WAIT, min-replicas-to-write]
---

主节点突然宕机，Sentinel 在几十秒内把一个副本提升为新主，业务随后发现最近写入的几条会话状态和计数器"不见了"。这些写入此前都收到了 `OK`，谁也没报错。

问题出在哪一层？主从复制让副本实时追赶主节点，Sentinel 让故障切换自动发生，但两者都没有改变一个事实：Redis 的复制默认是异步的，主节点向客户端返回 `OK` 时，并不保证这条写入已经到达任何副本。故障切换只是决定"由谁接管"，没有决定"接管者是否拥有全部已确认写入"。

本文回答一个问题：由 Redis 主从复制和 Sentinel 组成的高可用，一次故障切换会不会丢已经向客户端确认的写入？如果能，丢的是什么、最多丢多少、又能压到什么程度。答案可以提前说清：会丢。Sentinel 不把 Redis 变成强一致系统，它把"主挂了之后选谁、怎么切、客户端去哪找新主"自动化，同时把丢失窗口限定在几种具体场景里。复制、读写分离与 Quorum 的通用模型站内[《数据库增加副本后，为什么仍会读到旧数据》](/posts/database-replication-read-write-splitting-quorum/)已经讨论，MySQL 的 Binlog、GTID 与半同步在[《MySQL 主从复制与读写分离》](/posts/mysql-replication-read-write-splitting-failover/)展开，RDB、AOF 与 `WAITAOF` 的本地丢失边界在上一篇[《Redis 持久化》](/posts/redis-persistence-rdb-aof-data-loss-boundaries/)展开。本文只写 Redis 特有的复制流、重同步机制和 Sentinel 的选主协议，并说明它们与那几篇文章的结论怎样衔接。主要依据是 Redis 官方复制与 Sentinel 文档、`redis.conf` 配置示例以及 redis-doc 仓库中的 Sentinel 说明，托管版产品的实现与承诺以各自文档为准。

## 一、复制、Sentinel、高可用各自承诺什么

三个词经常被当成一回事，它们实际上位于不同层次。

复制（replication）回答"同一份数据集是否存在于多个进程"。Redis 的主从复制让副本尽量成为主节点的精确拷贝，副本断开后会自动重连并继续追赶。它提供数据冗余，也提供一部分读扩展能力。

高可用（high availability）回答"主节点失效后服务能否继续"。高可用靠的是故障检测、选主、切换和路由更新这一整套动作，复制只是它依赖的数据基础。

Sentinel 是 Redis 官方提供的高可用组件，但它是一个独立于数据路径的控制面进程。它做四件事：监控（不断检查主和副本是否正常）、通知（通过 API 把异常告诉管理员或其他程序）、自动故障切换（主不可用时提升副本、重配其余副本、告知应用新地址）、配置提供者（客户端向 Sentinel 查询当前主节点地址）。官方文档把它列为四类能力，而不是一个"更强的复制模式"。

这层区分直接决定本文的结论。Sentinel 不参与复制流，也不把异步复制改成同步复制。它决定"由谁接管、何时接管、客户端去哪找新主"，但不决定"一次写入已经被安全复制了几份"。因此：

| 组件 | 它承诺什么 | 它没有承诺什么 |
| --- | --- | --- |
| 主从复制 | 副本持续追赶主节点，形成冗余拷贝 | 写入已确认前到达了副本 |
| Sentinel | 监控、通知、自动切换、提供新主地址 | 已确认写入在切换后仍然保留 |
| 持久化 | 本节点重启后能从磁盘恢复 | 其他节点拥有这份数据 |
| 备份 | 能回到某个历史时间点 | 秒级故障切换 |

判断"故障切换会不会丢数据"，不能问 Sentinel 一句，而要问：主节点返回 `OK` 时写入复制到了哪里，切换时被提升的副本又拥有到什么水位。这两个位置之间的差，就是可能丢失的写入。

## 二、一次写入怎样到达副本

Redis 主从复制的核心是一条复制流。主节点把改变数据集的操作编码成命令，流式发送给每个副本：客户端写、主节点主动过期或淘汰某个 Key 时合成的 `DEL`、其他任何改变数据集的动作，都会进入这条流。

这条流有两个坐标。每个主节点有一个 replication ID，一个伪随机的大字符串，用来标记"这一段数据集历史"；还有一个 offset，主节点每产生一个字节的复制流就递增，即使当前没有任何副本连接，offset 也照常前进。于是 `(replication ID, offset)` 唯一标识主节点数据集的某个版本。两个实例拥有相同 replication ID 时，offset 更大的一方拥有更新、更完整的数据集；offset 较小的一方只要再应用一小段命令，就能追到完全相同。

副本连接主节点时，用 `PSYNC` 命令带上自己记忆的旧 replication ID 和已处理 offset。主节点据此决定两种做法：如果副本请求的历史还认得、缺失的部分还在 backlog 里，就只发增量（部分重同步）；否则要求副本从零拿一份完整数据集（全量重同步）。

![Redis 复制流中 replication ID 与 offset 标定副本追赶水位](/images/posts/redis-replication-stream.svg)

这张图的关键是中间那条复制流和两个水位。客户端收到 `OK` 只意味着写入进入了主节点的复制流，主节点的 `master_repl_offset` 前进了；副本自己的 offset 是否追上，是另一回事。站内通用复制篇已经区分了"收到、应用、可读"的层级，Redis 用单一 offset 把它们压缩成"副本处理到第几个字节"，这是 Redis 复制独有的简化：offset 既是传输进度，也近似代表副本数据集的新旧程度。

副本会以级联结构存在。除了多个副本直接挂到同一个主节点，副本还可以作为下一级副本的源：`A → B → C`。自 Redis 4.0 起，C 收到的复制流与 A 发给 B 的完全一致，所以 B 上的本地写不会传播给 C。级联能减轻单个主节点向大量副本分发全量同步的带宽压力，代价是引入额外的转发跳数。

## 三、部分重同步与全量重同步什么时候发生

副本断开又重连，未必需要重新传一遍全部数据。Redis 靠一个内存里的环形缓冲避免这件事，它就是 replication backlog。

主节点持续把复制流写进 backlog，同时向每个副本转发。backlog 由 `repl-backlog-size` 限制大小（默认 1 MB），在最后一个副本断开后由 `repl-backlog-ttl` 决定保留多久（默认 3600 秒）。副本重连时带上旧 replication ID 和 offset，主节点检查这段字节是否还在 backlog 里：还在，就从缺失点继续发（部分重同步）；已经滚出 backlog，或者副本的 replication ID 完全不认识，就只能全量重同步。

`repl-backlog-size` 因此不是随便设的内存项，它决定"副本最多断开多久、落后多少字节，重连后还能增量补上"。一个写入高峰期的实例每秒可能产生几 MB 复制流，1 MB 的默认 backlog 几秒钟就被覆盖；此时一次短暂断线也会退化成全量同步。

全量同步的过程比"发一份快照"更复杂：

```text
1. 主节点 fork 子进程，基于当前数据集生成 RDB
2. 同时主节点开始缓冲此后到达的新写命令
3. 主节点把 RDB 发给副本，副本落盘后载入内存
4. 主节点再把缓冲的新写命令流式发给副本
```

如果多个副本几乎同时请求全量同步，主节点只做一次后台保存，把同一份 RDB 发给它们。默认开启的 `repl-diskless-sync` 让子进程直接把 RDB 经网络发出、不写中间文件，配合 `repl-diskless-sync-delay`（默认 5 秒）等待更多副本加入这次传输。这在慢盘环境能减少主节点压力，代价是一次传输失败要整体重来。

载入新数据集期间，副本会短暂阻塞新连接：旧的删除可以放在后台线程，但新 RDB 的载入在主线程完成。数据集很大时，这个窗口可以长达数秒甚至更久。这也解释了为什么 Sentinel 用 `parallel-syncs` 控制同时重同步的副本数——后面会再遇到它。

复制主节点在故障切换后被换人，副本仍可能走部分重同步。这是 Redis 用两个 replication ID 实现的效果：一个实例被提升为主后，把原来的主 replication ID 记为 secondary，同时生成一个新的主 replication ID，因为一段新历史开始了。其他副本带着旧 replication ID 连上来时，新主能用 secondary ID 和对应 offset 匹配它们，让它们无需全量同步。为什么必须换掉 replication ID？因为旧主可能还在某个网络分区里继续当主，同一个 ID 加同一个 offset 不能同时对应两个不同的数据集。这个细节在后面分区场景里会显得重要。

## 四、副本什么时候读到旧数据

副本默认 `replica-read-only yes`，拒绝写命令。这是防误写，不是把副本安全地暴露给不可信客户端：`CONFIG`、`DEBUG` 之类的管理命令仍然可用，网络边界还是要靠 ACL 和防火墙。

副本默认 `replica-serve-stale-data yes`。这意味着主从链路断开、或初次全量同步还没完成时，副本仍用旧数据集服务读请求；设成 `no` 则在这类时刻返回 `MASTERDOWN` 或 `LOADING` 错误，宁可失败也不给旧数据。这是读扩展与新鲜度之间的第一道选择：默认值适合"旧一点也比没有强"的缓存类读，需要严格新鲜度的读要么走主节点，要么走后面说的 `WAIT`。

副本天然落后一个窗口，这个窗口不是一个固定的毫秒数。它等于主节点 offset 与副本 offset 的差，再除以复制链路的实际吞吐。主节点写入突增、网络抖动、副本执行慢命令，都会让同一份"落后 100 字节"对应完全不同的时间。站内通用复制篇已经强调"读己之写、单调读"要靠水位或主节点读来解决，Redis 的对应物就是这个 offset：`WAIT` 让某条连接等待自己的写入被 N 个副本 ack 到这个 offset。

过期键的复制有它自己的规则。副本不主动过期 Key，而是等主节点过期或淘汰后合成一条 `DEL` 发下来。但主节点可能来不及发，副本内存里就会短暂停留逻辑上已经过期的 Key。为此副本在读取时用自己的逻辑时钟判断：对只读操作，副本把已经到期的 Key 当作不存在返回，避免给客户端返回"逻辑上已经过期"的值；同时继续等主节点真正的 `DEL`。Lua 脚本执行期间主节点冻结过期判断，保证同一脚本发到副本产生相同效果。这套设计的目的是让过期行为不依赖主从时钟同步。

## 五、Sentinel 是数据路径之外的独立控制面

Sentinel 是独立运行的一批进程，不是 Redis 的一个配置项，用 `redis-server /path/sentinel.conf --sentinel` 或 `redis-sentinel` 启动，默认监听 26379 端口。它必须有一个可写的配置文件，因为 Sentinel 会把当前状态写回这个文件，重启后据此恢复。

把 Sentinel 当成一个分布式系统来部署，有三条硬要求。第一，至少三个实例，放在彼此独立的故障域（不同物理机或可用区）。第二，Sentinel 之间要通过 26379 互相通信，否则无法达成一致、永远不执行切换。第三，客户端要么使用支持 Sentinel 的客户端库，要么用脚本或虚拟 IP 做透明重定向，否则切换完成后应用还连在旧地址上。

Sentinel 的成员发现不需要手写配置。每个 Sentinel 每两秒向它监控的主和副本的 `__sentinel__:hello` Pub/Sub 频道广播自己的 IP、端口和 runid，同时订阅这些频道发现其他 Sentinel；副本列表则靠查询主节点的 `INFO` 自动发现。于是 `sentinel monitor` 只需要点名主节点，副本和其余 Sentinel 都会被自动补全。这套发现机制依赖 Redis 的地址自述，也正是它在 Docker 端口映射下会失效的原因：`INFO` 里看到的副本地址是容器内的，外面连不上，此时需要用 `replica-announce-ip`/`replica-announce-port` 显式声明对外地址。

![一主两副本三 Sentinel 的监控与发现关系](/images/posts/redis-sentinel-topology.svg)

这张图要区分两条线。实线是监控：Sentinel 周期性 `PING` 主和副本，判断它们是否存活。虚线是发现与配置传播：Sentinel 通过 Redis 的 `__sentinel__:hello` 频道互相认识、交换配置版本，客户端则通过 `SENTINEL get-master-addr-by-name` 向任意 Sentinel 查询当前主节点地址。数据路径（客户端读写 Redis）完全不经 Sentinel，Sentinel 只负责把"现在该连谁"这个答案喂给客户端。

## 六、判断"挂了"有两道门槛：SDOWN 与 ODOWN

一个主节点是否"不可用"，不能由单个 Sentinel 单独判定。Sentinel 区分两种状态。

主观下线（Subjectively Down，SDOWN）是单个 Sentinel 自己的判断：在 `down-after-milliseconds` 配置的时长内，它对实例的 `PING` 没有收到合法回复。合法回复只有三种：`+PONG`、`-LOADING`、`-MASTERDOWN`；其他回复或不回复都不算。另外，一个在 `INFO` 里自称是副本的主节点，也会被判为主观下线。SDOWN 要求整个区间内都没有合法回复：`down-after-milliseconds` 是 30 秒时，每 29 秒收到一次 `PONG` 就不会触发。

客观下线（Objectively Down，ODOWN）要多个 Sentinel 一致。一个 Sentinel 用 `SENTINEL is-master-down-by-addr` 向其他 Sentinel 询问，当认为这个主下线的 Sentinel 数量达到 `sentinel monitor` 里配置的 quorum，主节点才进入 ODOWN。官方文档强调，从 SDOWN 升到 ODOWN 用的不是强共识算法，而是一种 gossip 式的信息交换：足够多 Sentinel 在一段时间内报告同一个主不可达，就判定 ODOWN；这些报告后来消失，标记也会被清除。ODOWN 只针对主节点，副本和其他 Sentinel 永远只有 SDOWN，因为系统不需要对它们执行切换动作。

SDOWN 不足以触发切换，ODOWN 才会。但 ODOWN 仍然不是"可以动手了"的授权——下一节会说，真正的执行还要过一道多数派投票。

## 七、quorum 与 majority 是两回事

这是 Sentinel 官方文档反复强调、也最容易在评审里被写反的区分：quorum 和 majority 决定的是两件不同的事。

quorum 是 `sentinel monitor <name> <ip> <port> <quorum>` 的第四个参数，它决定"多少个 Sentinel 同意主挂了，才算客观下线"。majority 是 Sentinel 进程总数的多数，它决定"授权这个 Sentinel 真的去执行切换"。两者可以不同。

一个具体例子：5 个 Sentinel，quorum 设为 2。只要 2 个 Sentinel 同时判定主不可达，就达到 ODOWN、触发一次切换尝试；但发起切换的那个 Sentinel 必须再拿到至少 3 个 Sentinel 的授权，才能实际执行。换句话说，少数派判定就足以"触发"，多数派授权才足以"动手"。

```ini
# 5 个 Sentinel 部署，quorum=2
sentinel monitor mymaster 10.0.0.1 6379 2
sentinel down-after-milliseconds mymaster 30000
sentinel failover-timeout mymaster 180000
sentinel parallel-syncs mymaster 1
```

这个参数因此有两种调法。quorum 设得比多数派小，系统对故障更敏感：少数 Sentinel 失联就触发切换尝试，但仍要多数授权才执行。quorum 设得比多数派大（例如 5 个 Sentinel 设 5），则所有 Sentinel 都同意主挂了才 ODOWN，执行时也需要所有 Sentinel 授权，任何一台 Sentinel 暂时失联都会让切换卡住。前者用"更容易判定失败"换响应速度，后者用"更难判定"换判定置信度。

一个常见误区是把 quorum 理解成"切换需要的票数"。它只用于检测。这解释了官方文档里那个看似矛盾的现象：quorum=1 时两台 Sentinel 就能判定失败，但少数的那个分区仍然无法授权切换，因为授权要多数。把这个区别写清楚，才能回答"为什么分区里永远不发生切换"——因为少数派分区里凑不出多数授权。

## 八、一次故障切换究竟发生什么

主节点进入 ODOWN 后，切换要先选出一个 leader，而不是所有 Sentinel 一拥而上。

被选中执行切换的 Sentinel，会拿到这个主节点的一个唯一 configuration epoch，一个用于给"切换后的新配置"编号的版本号。因为是多数派同意把某个版本交给某个 Sentinel，其他 Sentinel 就不可能再用同一个版本，所以每次切换的配置都带唯一版本。投票规则里还有一个约束：一个 Sentinel 若已投票支持某次切换，会等待 `2 × failover-timeout` 才再次尝试切换同一个主。这套规则给系统两个性质：只要多数 Sentinel 可达，最终一定有一个被授权（liveness）；每次切换都用不同 epoch（safety）。

拿到授权的 leader 开始挑副本。它先做一次过滤：副本的 `INFO` 显示它与主断开超过 `down-after-milliseconds × 10 + 主进入 SDOWN 以来的时长`，就被视为不可靠、直接剔除。剩下的副本按下述顺序排序：

1. `replica-priority` 越小越优先，`replica-priority 0` 表示永不提升（但仍会被重配去跟随新主）；
2. 优先级相同看 offset，已处理更多复制流的副本优先；
3. 都相同看 runid，选字典序更小的，只是为了结果确定，不代表 runid 小有什么优势。

选好副本后，leader 向它发送 `REPLICAOF NO ONE` 让它变主，随后从它的 `INFO` 观察到角色确实变成 master，这次切换就算成功。之后 leader 按 `parallel-syncs` 的数量，分批让其余副本 `REPLICAOF` 到新主；`parallel-syncs 1` 表示一次只重同步一个副本，避免所有副本同时停下来载入全量数据。

新配置通过 `__sentinel__:hello` 频道广播出去，epoch 更大的配置覆盖更小的。于是所有 Sentinel 最终收敛到"新主是谁"，这也是官方文档说的：Sentinel 整体是一个最终一致系统，合并规则是 last-failover-wins。被提升的副本并不包含所有旧主已确认写入，这一点下面专门展开。

![从失联判定到新主对外服务的一次故障切换](/images/posts/redis-sentinel-failover-decision.svg)

## 九、故障切换丢数据的三种具体场景

异步复制意味着，主节点向客户端返回 `OK` 之后、这条写入的复制流到达副本之前，存在一个窗口。切换只把"接管的副本"摆到台前，不补上这个窗口。具体有三种会丢的场景。

**场景一：主节点在写入未复制前就不可恢复。** 主节点返回 `OK`，offset 前进到 N，但复制流还没到任何副本。此刻主节点连同它的内存和本地磁盘一起丢失（整机故障、磁盘损坏），候选副本最多只到 offset N−1。切换后，offset N 的那条写入从整个系统里消失。若主节点开了 AOF `always` 或 `everysec`，本地落盘能缩小这个窗口，却仍然不等于副本已经拿到；上篇持久化文章的结论在这里适用：`WAITAOF` 能要求本地和副本都落盘，但那是特定写入的额外确认，不是默认路径。

**场景二：网络分区里，旧主继续收写。** 主节点被隔离在一个分区，Sentinel 多数在另一个分区判定它下线并提升副本。但还连着旧主的客户端不知道这件事，继续向旧主写入。分区恢复后，旧主被 Sentinel 重配为新主的副本，它的整个数据集被丢弃，分区期间收到的写全部丢失。官方 Sentinel 文档用一页 ASCII 图专门描述这个场景：这是"客户端和旧主被分到同一侧"时特有的风险，副本机制本身无法阻止旧主继续收写。

**场景三：主节点无持久化却自动重启。** 主节点关闭持久化，进程崩溃后由守护进程自动拉起，起来时内存是空的。副本连上这个空主节点，为了"精确拷贝主节点"，把自己的数据也清空。整组在无人察觉的情况下变空。官方复制文档明确把这条列为危险配置：主节点不持久化时，要么关闭自动重启，要么接受整组被清空的风险。Sentinel 场景里更隐蔽——主节点可能重启得足够快，快过 `down-after-milliseconds`，Sentinel 甚至没察觉发生过故障，切换根本不会触发。

三种场景的共同点是：丢失的不是"还没执行"的写，而是"已经执行、已经确认、但只存在于旧主"的写。Sentinel 无法消除它们，只能通过配置把其中一部分变成有界。

## 十、min-replicas-to-write：把分区丢写窗口变成有界

场景二最危险的地方是窗口没有上界：只要分区不愈合，旧主就能无限收写。Redis 用两个配置给这个窗口加一个上限。

副本每秒向主节点 `REPLCONF ACK` 自己已处理的 offset，主节点记住每个副本最近一次 ack 的时间。`min-replicas-to-write N` 和 `min-replicas-max-lag M` 联合表达一条写门槛：只有当至少 N 个副本的 lag 不超过 M 秒时，主节点才接受写；否则返回错误、拒绝写入。

```ini
# 至少 1 个副本在 10 秒内确认过复制流，否则主节点拒绝写
min-replicas-to-write 1
min-replicas-max-lag 10
```

回到分区场景。旧主被隔离后，它收不到任何副本的 ack，`max-lag` 秒之后 lag 超过阈值，旧主开始拒写。于是"旧主在分区里最多还能多收多少写"被压到约 `max-lag` 秒的量级。分区愈合后，旧主被重配为副本、丢弃它多收的那一小段，但这段是有界的，而不是整个分区期间的全部写入。

这里有两个必须说清的限制。第一，`max-lag` 是"最近一次 ack 距今的秒数"，不是副本真正落后多少字节——副本可能已经 ack 到一个较高 offset 后又断线，lag 从 0 慢慢涨到 M 的过程中，旧主已经又收了不少写。它是一个尽力而为的界，官方文档用"best effort"形容它，目标是"有界丢失好过无界丢失"，不是"零丢失"。第二，代价是反向的：如果 N 个副本同时挂掉，主节点会拒绝所有写，即使主节点自己完全健康。这是用写入可用性换数据安全的直接交换，`N` 和 `M` 要按业务能接受的最坏情况来设。

这个机制与 `WAIT` 不同。`min-replicas-to-write` 是主节点对所有写设的持续门槛，`WAIT` 是某条连接对自己刚发出的写做的主动等待。两者可以叠加，后面一起说。

## 十一、WAIT、持久化与 Sentinel 怎样组合才接近"不丢"

`WAIT numreplicas timeout` 让当前连接等待：本连接此前产生的写入，被指定数量的副本确认"处理到这个 offset"。它返回实际确认的副本数，超时不会回滚前面的写。官方文档给它的定位很精确：`WAIT` 能大幅降低故障后丢失一次写入的概率，把它压到几种"难以触发的故障模式"，但不会把一组 Redis 实例变成一个强一致的 CP 系统，因为确认的写仍可能在某些配置下于切换中丢失。

把三个机制叠起来，才能把丢失边界压到最小，而不是指望其中某一个：

```text
SET payment:42 confirmed
WAIT 1 1000
# 返回实际 ack 的副本数，客户端必须核对它是否达到自己的门槛
```

- `min-replicas-to-write` 给主节点设一道持续写门槛，副本全离线时宁可拒写；
- `WAIT` 给少数关键写加一次显式的副本确认，返回计数是可观测证据；
- 主和副本各自开启持久化（AOF），让"副本 ack 了 offset"不等于"落盘"的缺口由磁盘补上。

即便如此，结论仍然是"可能丢，但窗口被压缩到难以触发"。要真正做到"已确认写入绝不因切换丢失"，需要同步复制加上一个共识协议来运行复制状态机（Raft 一类），这是 Redis 明确不在其目标内的事情。Redis 的官方说法是把整组描述为最终一致、last-failover-wins，旧主数据在合并时被丢弃。认清这条边界，比在方案评审里写一句"Redis 主从 + Sentinel 保障数据不丢"重要得多。

## 十二、一次机房分区的端到端复盘

假设主节点在机房 A，副本 R1 也在 A，副本 R2 在机房 B；三个 Sentinel 分布在 A、A、B。机房 B 与 A 之间的网络中断。

开始时一切正常，客户端把会话状态写入主节点。分区发生后，B 侧的 R2 和第三个 Sentinel 与主节点失联，但 A 侧的两个 Sentinel 仍能互相通信，也仍连着主节点和 R1。

假如故障是主节点进程崩溃而非网络分区，A 侧两个 Sentinel 会先后把它判为 SDOWN，`is-master-down-by-addr` 之后达到 quorum=2 的 ODOWN，其中一台拿到多数授权（3 台里的 2 台）后提升 R1。切换完成后 R1 成为新主，A 侧客户端恢复写入。B 侧的 Sentinel 和 R2 还持有旧配置，等分区愈合后通过 epoch 更大的新配置收敛，R2 重新跟随 R1。

真正危险的是另一条分支：主节点没崩，只是和多数 Sentinel 分开了。此时 A 侧 Sentinel 判定主下线并提升 R1，但主节点自己还活着，B 侧客户端还连在它上面。如果没配 `min-replicas-to-write`，主节点在分区期间持续收写，这些写最终全部随"旧主变副本"被丢弃。配了 `min-replicas-to-write 1` 和 `max-lag 10`，主节点在失去所有副本 ack 的 10 秒后开始拒写，把丢失量限制在这 10 秒的写入内。

![机房分区下旧主继续收写与 min-replicas-to-write 的边界](/images/posts/redis-sentinel-partition-write-loss.svg)

复盘时不要只看 Sentinel 日志里有没有"failover 成功"。要同时对齐三个水位：旧主最后确认的 offset、被提升副本的 offset、以及业务事实源里的最后状态。上一篇文章已经演示过用单调序号和时间戳给写入编号、再与事实源交叉核对的方法，这里同样适用。若丢失的写入里有关键状态，结论应落到"min-replicas-to-write 设了多少、WAIT 用了没有、副本是否落盘"这些可查项上，而不是"Sentinel 切得太慢"。

## 十三、上线前要验证什么，平时监控什么

配置评审只能推导理论窗口，故障实验才能暴露真实边界。至少做四组：

1. 直接杀死主进程，观察切换耗时、被提升副本的 offset 与主最后 offset 的差、客户端重连后的行为；
2. 制造网络分区而不是杀进程，确认旧主在分区里是否继续收写、`min-replicas-to-write` 是否在预期秒数后拒写；
3. 关闭主节点持久化并让进程重启，确认整组是否被清空，验证"无持久化 + 自动重启"这条禁令；
4. 人为让某个副本落后，再触发切换，验证 `replica-priority`、offset 和 runid 的排序是否按预期选出副本。

第 4 组还要覆盖 `replica-priority 0` 的副本永远不被提升，以及落后超过 `down-after × 10` 的副本被剔除。

监控从 `INFO replication` 和 Sentinel 命令入手。主节点看 `connected_replicas`、`master_repl_offset`；副本看 `master_link_status`、`master_last_io_seconds_ago`、自己的 `slave_repl_offset` 与主 offset 的差。主从 offset 差持续扩大，比"副本连接正常"更有判断价值——连接正常只能说明链路在，不能说明追得上。Sentinel 侧用 `SENTINEL master <name>` 看当前主地址、副本数和每个副本的 `master-link-down-time`，用 `SENTINEL ckquorum <name>` 检查多数派是否可达。

Sentinel 还有一个特殊状态要纳入告警：TILT 模式。Sentinel 依赖系统时钟判断"多久没收到回复"，如果时钟被回拨、进程被阻塞、或两次定时器回调间隔异常（2 秒以上），Sentinel 会进入 TILT：继续监控，但停止一切动作，也不再对其他 Sentinel 的 `is-master-down-by-addr` 给出肯定判断。正常持续 30 秒后退出。`INFO` 里的 `sentinel_tilt` 字段为 1 时，系统处于"看得见但不会切"的状态，此时任何切换都不会发生。用 NTP 保持时钟稳定，并避免把 Sentinel 与重负载进程挤在同一台机器。

## 十四、选型落到一张表

| 数据特征 | 建议起点 | 必须验证的风险 |
| --- | --- | --- |
| 可从数据库重建的普通缓存 | 主从 + Sentinel，接受切换丢最近写入 | 重建流量是否压垮源站 |
| 能接受秒级丢失的状态 | 主从 + Sentinel + AOF + `min-replicas-to-write` | 副本全离线时主节点拒写 |
| 少数关键写要求更强确认 | 在关键写后显式 `WAIT` 并核对返回计数 | 超时结果未知、幂等重试 |
| 需要分片横向扩展 | Redis Cluster（自带复制与自动切换） | Multi-Key 限制、槽迁移、热点 |
| 已确认写绝不能丢 | 换用具备同步复制与共识的存储 | Redis 本身不在这个目标内 |

Sentinel 解决的是"非 Cluster 的 Redis 如何高可用"，不是"如何把 Redis 变成强一致"。当数据量或写入吞吐超过单主能力，下一步是 Redis Cluster，它在每个分片内部仍然使用主从复制和自动切换，这一层会留到下一篇展开。选择路径时先问三个问题：一次写入返回 `OK` 时复制到了哪、切换时被提升的副本拥有到什么水位、业务能否接受这两个位置之间的差。把"故障切换不丢数据"这句模糊承诺，换成这三个可测的问题，主从复制和 Sentinel 的边界才算真正落到工程里。

## 参考资料

- [Redis 官方文档：Replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
- [Redis 官方文档：High availability with Redis Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
- [Redis 官方文档：WAIT](https://redis.io/docs/latest/commands/wait/)
- [Redis 官方文档：PSYNC](https://redis.io/docs/latest/commands/psync/)
- [Redis 官方文档：REPLICAOF](https://redis.io/docs/latest/commands/replicaof/)
- [Redis 官方文档：ROLE](https://redis.io/docs/latest/commands/role/)
- [Redis 官方文档：INFO](https://redis.io/docs/latest/commands/info/)
- [Redis 官方文档：SENTINEL](https://redis.io/docs/latest/commands/sentinel/)
- [Redis 官方配置示例：redis.conf](https://github.com/redis/redis/blob/unstable/redis.conf)
- [redis-doc 仓库：Sentinel 文档](https://github.com/redis/redis-doc/blob/master/topics/sentinel.md)
