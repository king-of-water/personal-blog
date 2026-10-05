---
title: MySQL 主从复制与读写分离：延迟、数据一致性和故障切换
description: 从 Binlog、Relay Log、GTID 与并行回放出发，解释 MySQL 副本为什么会延迟，读写分离怎样保证关键读取，以及主库故障时如何安全切换。
category: 后端
subcategory: MySQL
articleClass: focused
seriesOrder: 70
featured: true
publishedAt: 2026-06-21T23:12:00+08:00
updatedAt: 2026-06-21T23:12:00+08:00
tags: [MySQL, 主从复制, 读写分离, GTID, 半同步复制, 故障切换]
---

一笔订单更新在主库返回成功，用户立即刷新详情页，却看到“订单不存在”或旧状态。过了几百毫秒再刷新，数据又正常了。此时主库没有回滚，副本也没有损坏，问题只是读取落在了尚未回放这笔事务的副本。

这类现象很容易被概括为“主从延迟”，但这个词把几个不同阶段揉在了一起：主库是否已经把事务写入 Binlog，副本是否已经收到事件，Relay Log 是否落盘，回放线程是否已经执行，读取流量又是否被送到了这台副本。故障切换时还要回答另一个问题：候选副本究竟缺少哪些事务，旧主库怎样被隔离，客户端何时可以重新写入。

本文以 MySQL 8.4 的单主多副本异步复制为主，回答一个具体问题：一笔已经在主库提交的事务，怎样传播到可查询的副本；这条链路变慢或中断时，应用与运维系统应该怎样处理。通用复制模型、Quorum 和多数派读写已经在[《数据库增加副本后，为什么仍会读到旧数据》](/posts/database-replication-read-write-splitting-quorum/)中讨论，本文只展开 MySQL 的实现与工程决策。

## 一、复制是一条有多个进度点的流水线

MySQL 传统复制采用 Source 与 Replica 的术语。应用把写请求发到 Source，Source 生成 Binlog；Replica 上的 Receiver Thread 拉取 Binlog 事件并写入本地 Relay Log；Applier Thread 再读取 Relay Log，把事务执行到副本自己的 InnoDB 中。MySQL 官方的[复制线程说明](https://dev.mysql.com/doc/refman/8.4/en/replication-threads.html)把它们分为 Source 上的 Binlog Dump Thread、Replica 上的 Receiver Thread，以及一个或多个 Applier Worker。

![MySQL 事务从主库提交到副本可读的复制流水线](/images/posts/mysql-replication-pipeline.svg)

这条链路要分别记录三个进度点：

- Source committed：事务已经在主库提交，并进入主库可供复制的历史；
- Replica received：副本已经接收事件并写入 Relay Log；
- Replica executed：副本已经执行并提交事务，本机查询才有机会看到结果。

三个位置相等时，副本才真正追上主库。若 received 落后于 committed，瓶颈在传输或接收；若 executed 落后于 received，瓶颈在副本回放。应用只观察“查询读到了旧值”，无法区分两种原因。

### Binlog 和 Relay Log 各自解决什么问题

Binlog 是 Source 产生的逻辑变更历史，用于复制、时间点恢复和 CDC。Relay Log 是某条复制通道在 Replica 上接收到的中转日志。根据官方的[Relay Log 与复制元数据说明](https://dev.mysql.com/doc/refman/8.4/en/replica-logs.html)，Receiver Thread 写 Relay Log，Applier Thread 消费它；连接进度与回放进度则保存在复制元数据仓库中。

Relay Log 把网络接收和本地执行拆开。网络暂时中断时，副本可以继续回放已经收到的事件；副本回放变慢时，Receiver Thread 仍能先把事件收下来。代价是系统出现了两个积压点。只检查网络连接正常，无法证明副本数据新鲜；只看到 SQL Thread 忙碌，也无法证明 Receiver Thread 没有落后。

这也解释了为什么“副本在线”不是一个充分的健康定义。进程存活、TCP 连接正常、Receiver Thread 正常、Applier Thread 正常、业务读取满足新鲜度要求，是五个不同条件。

### 单线程回放为什么容易成为瓶颈

主库可以由许多连接并发提交事务。副本若只用一个 SQL Thread 串行回放，主库的并发写入会被压缩成一条队列。只要主库产生变更的速度持续高于副本执行速度，Relay Log 就会不断增长。

MySQL 8.4 默认启用多线程副本。`replica_parallel_workers` 大于 0 时，一个 Coordinator 顺序读取 Relay Log，再把可以并行的事务分配给多个 Worker。官方文档说明 8.4 的默认值为 4，同时默认使用 `LOGICAL_CLOCK` 调度并开启 `replica_preserve_commit_order`，让副本按照 Relay Log 中的顺序提交事务。并行回放提高的是“彼此没有依赖的事务”的吞吐量，它无法把一个大事务拆成许多任意并行的小事务。

```sql
SHOW VARIABLES WHERE Variable_name IN (
  'replica_parallel_workers',
  'replica_parallel_type',
  'replica_preserve_commit_order'
);
```

以下负载仍可能让并行 Worker 等待：

- 一个事务修改几百万行，其他 Worker 无法替它完成这笔事务；
- 大量事务集中更新同一批热点记录，在副本上仍要竞争行锁；
- DDL、缺少索引的更新或触发大量 I/O 的事务本身执行很慢；
- Worker 已经执行完毕，但为了保持提交顺序等待更早的事务提交。

因此看到 Worker 数量不足就直接调大 `replica_parallel_workers`，效果不一定好。需要先判断积压来自并行度不足、单事务过大、热点冲突，还是磁盘与 CPU 已经饱和。

## 二、GTID 给事务一个跨节点身份

基于文件位置的复制用 `mysql-bin.000123:456789` 表示进度。这个坐标只在某一台服务器的某组 Binlog 中有意义。发生主从切换后，新主库拥有自己的日志文件名和位置，运维系统必须换算每台服务器之间的对应关系。

GTID（Global Transaction Identifier）给每笔已提交事务分配跨服务器可识别的身份，基本形式是：

```text
source_uuid:transaction_id

3E11FA47-71CA-11E1-9E33-C80AA9429562:1-93842
```

同一笔事务复制到其他服务器时继续携带原 GTID。一个服务器的 `gtid_executed` 表示它已经执行过的 GTID 集合；`gtid_purged` 表示已经执行、但对应事件已不在当前 Binlog 中的集合。MySQL 的[GTID 生命周期文档](https://dev.mysql.com/doc/refman/8.4/en/replication-gtids-lifecycle.html)说明，副本提交复制事务时会持久化原 GTID，随后把它加入自己的 `gtid_executed`。

### 自动定位省掉的是坐标换算

启用 `SOURCE_AUTO_POSITION=1` 后，副本连接 Source 时会提交自己的 GTID 集合。Source 计算出副本缺少的事务并继续发送，不再依赖人工填写某个 Binlog 文件位置。

```sql
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST = 'mysql-source.internal',
  SOURCE_USER = 'repl',
  SOURCE_PASSWORD = '***',
  SOURCE_AUTO_POSITION = 1;

START REPLICA;
```

这对重新挂载副本和故障切换很有帮助，但 GTID 没有把异步复制变成同步复制。它只能回答“这笔事务是谁”和“这台机器执行过哪些事务”，不能保证每台副本此刻拥有相同集合。判断候选副本是否追平，仍要比较 GTID 集合；判断用户读请求能否落到某个副本，也仍要确认目标事务已经执行。

GTID 还依赖可用的日志历史。若副本缺少的 GTID 已从 Source 的 Binlog 清理，自动定位也无法凭空恢复事件，只能从一致快照重新建立副本。Binlog 保留周期要覆盖可接受的最长故障与修复时间。

### GTID 可以作为因果读取令牌

用户完成写入后，应用若能拿到代表这次提交的 GTID，就可以在准备读取的副本上等待它执行：

```sql
SELECT WAIT_FOR_EXECUTED_GTID_SET(
  '3E11FA47-71CA-11E1-9E33-C80AA9429562:93842',
  0.2
);
```

`WAIT_FOR_EXECUTED_GTID_SET()` 会等待指定集合中的事务都出现在本机已执行集合中。返回 0 表示已满足，1 表示超时，`NULL` 表示出错。它提供的是一个明确边界：“至少执行到包含我刚才写入的状态”，比睡眠 100 毫秒再查可靠。

不过它会占用连接并增加读取延迟。每次普通查询都先等待 GTID，会把副本吞吐消耗在等待和状态判断上。比较合适的做法是只把令牌用于确实需要读己之写的链路，并设置很短的超时；超时后回主库读取，或者返回可识别的处理中状态。

## 三、复制延迟要拆成接收与回放两段

“副本延迟 5 秒”只给出一个结果，无法直接指导修复。更有用的模型是：

```text
总可见延迟
  = Source 产生到 Replica 收到的传输延迟
  + Relay Log 排队到事务执行完成的回放延迟
  + 读流量路由与连接切换带来的额外时间
```

传输段变慢，常见原因包括网络抖动、Source Binlog Dump Thread 受阻、副本 Receiver Thread 停止、Relay Log 磁盘写入慢，以及副本磁盘空间限制导致 Receiver 主动暂停。回放段变慢，则要检查长事务、热点锁、无索引 DML、DDL、Worker 队列和副本资源。

### 不要把 Seconds_Behind_Source 当成唯一真相

`SHOW REPLICA STATUS` 中的 `Seconds_Behind_Source` 很方便，但它有明确边界。官方[字段说明](https://dev.mysql.com/doc/refman/8.4/en/show-replica-status.html)指出，这个值主要比较当前回放事件的 Source 时间戳与 Replica 当前时间；网络很慢时，Applier 可能已经追上一个同样落后的 Receiver，于是显示 0，实际仍没有收到 Source 最新事件。线程停止或时钟变化也会让值变成 `NULL` 或失真。

```sql
SHOW REPLICA STATUS\G
```

排查时至少同时看：

- `Replica_IO_Running` 与 `Replica_SQL_Running` 是否都为 `Yes`；
- `Last_IO_Error`、`Last_SQL_Error` 和对应时间；
- `Retrieved_Gtid_Set` 与 `Executed_Gtid_Set` 的差集；
- Relay Log 空间是否持续增长；
- Coordinator 和 Worker 正在处理哪笔事务，队列是否堆积；
- Source 当前 GTID 集合与副本已执行集合之间还差多少。

Performance Schema 把复制状态拆到了多张表。`replication_connection_status` 观察 Receiver 连接和已接收事务；`replication_applier_status_by_coordinator` 观察协调线程；`replication_applier_status_by_worker` 观察每个 Worker 的最后事务、当前事务与错误。官方提供了完整的[复制监控表清单](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-replication-tables.html)。

```sql
SELECT CHANNEL_NAME, SERVICE_STATE,
       RECEIVED_TRANSACTION_SET,
       LAST_ERROR_NUMBER, LAST_ERROR_MESSAGE
FROM performance_schema.replication_connection_status;

SELECT CHANNEL_NAME, WORKER_ID, SERVICE_STATE,
       LAST_APPLIED_TRANSACTION,
       APPLYING_TRANSACTION,
       LAST_ERROR_NUMBER, LAST_ERROR_MESSAGE
FROM performance_schema.replication_applier_status_by_worker
ORDER BY CHANNEL_NAME, WORKER_ID;
```

监控面板应区分“线程停止”“连接落后”“回放落后”和“业务读取已超出新鲜度预算”。前三项帮助数据库值班人员定位，最后一项决定网关是否还应把读请求送到这台副本。

### 延迟突增时怎样定位

可以按流水线从前往后检查：

1. 先确认 Source 是否正常提交，Binlog 是否持续增长，磁盘与网络是否异常；
2. 比较 Source 已执行 GTID 与 Replica 已接收 GTID，判断传输缺口；
3. 比较 Replica 已接收与已执行 GTID，判断回放积压；
4. 若积压在回放，检查 Worker 状态、长事务、锁等待、CPU 和 I/O；
5. 找到制造积压的业务批次、DDL 或热点 SQL，评估暂停、拆批或限速；
6. 在副本重新满足新鲜度阈值之前，把它从关键读取池摘除。

修复期间也要摘除不满足新鲜度要求的副本。若应用继续把支付状态、权限判断或库存校验发到落后副本，用户侧错误仍会扩大。

## 四、异步与半同步改变的是主库确认边界

异步复制中，Source 本地提交完成后可以直接向客户端返回，不等待任何 Replica。吞吐和延迟较好，但 Source 随后立刻发生不可恢复故障时，尚未传到副本的事务可能丢失。此时 RPO（可接受的数据丢失量）大于零。

半同步复制让 Source 在返回提交成功前，等待至少一个 Replica 确认已经接收并记录事务事件。MySQL 官方的[半同步复制说明](https://dev.mysql.com/doc/refman/8.4/en/replication.html)给出的确认边界是 Replica 已 received and logged，并不是事务已经由 Applier 执行完成。

所以半同步能缩小“成功事务只存在于旧主库”的窗口，却不能提供副本立即可读保证：

```text
Source COMMIT
  -> Replica 收到并记录 Relay Log
  -> Replica ACK
  -> Source 向客户端返回成功
  -> Replica 之后才回放并提交到 InnoDB
```

一台副本可能已经发送半同步 ACK，同时 Relay Log 后面仍积压几秒钟。若请求马上被读写分离中间件送到这台副本，依然会读到旧值。

半同步还有超时降级行为。若 Source 在 `rpl_semi_sync_source_timeout` 内收不到足够确认，可以退回异步复制继续运行；`rpl_semi_sync_source_wait_for_replica_count` 控制需要多少个 Replica ACK，默认是 1。运维系统不能只检查配置开关，还要观察当前是否实际处于半同步状态、发生过多少次降级，以及提交等待时间是否抬升。

对于“宁可短暂停写，也不能扩大丢失窗口”的系统，超时后退回异步可能不符合业务策略。是否允许降级应由 RPO、写可用性和故障处置能力决定，不能把插件默认行为当成业务结论。

## 五、读写分离先按一致性需求分流

最简单的读写分离规则是 INSERT、UPDATE、DELETE 走 Source，SELECT 走 Replica。这条规则在真实事务里并不够用。

`SELECT ... FOR UPDATE` 是加锁读取，必须进入写事务所在的 Source；一个事务中前面的写和后面的读必须使用同一连接；临时表、会话变量和连接级状态也不能随意漂移。更重要的是，普通 SELECT 之间的一致性要求并不相同。

可以把读取分成四类：

| 读取类型 | 例子 | 推荐路由 |
| --- | --- | --- |
| 权威读取 | 支付结果、权限校验、扣减前库存确认 | Source |
| 写后立即读取 | 提交订单后打开详情 | Source 粘滞或 GTID 等待 |
| 有界陈旧读取 | 商品列表、运营报表 | 满足延迟阈值的 Replica |
| 可长期陈旧读取 | 历史归档、离线分析 | 专用 Replica 或数据平台 |

这种分法让路由规则绑定业务语义。副本数量增加后，系统获得的是更多读取容量，不会自动获得更强的一致性。

### 三种常见的读己之写方案

第一种是写后粘滞 Source。用户或请求链在写成功后的短时间内继续读 Source。它实现简单，适合登录态、订单详情等链路；粘滞窗口过长会压缩读扩展收益，过短则会再次暴露延迟。

第二种是携带 GTID 令牌。写接口返回提交对应的 GTID，后续读在候选 Replica 上调用 `WAIT_FOR_EXECUTED_GTID_SET()`，在预算内追平就读取，超时就回 Source。它比固定时间窗口精确，但要求应用、数据库代理和连接管理共同传递令牌。

第三种是让关键状态始终读 Source。支付终态、余额、权限和库存决策经常值得这样做。这些读取量通常远小于列表、搜索和历史查询，没必要为了形式上的“全部读写分离”把正确性放到异步副本上。

### 订单状态为什么会短暂倒退

假设用户提交支付后，Source 把订单从 `PENDING` 更新为 `PAID`，接口返回成功。前端立即请求订单详情，代理随机选择 Replica B；B 的 Receiver 已经收到事务，但 Worker 正在回放前面的批量更新，因此查询仍返回 `PENDING`。

更麻烦的是应用把这个旧结果写入 Redis，并设置 30 秒 TTL。数据库原本只有 500 毫秒延迟，缓存却把错误状态放大成 30 秒。若缓存未命中时允许读取 Replica，负缓存与状态缓存都必须考虑副本新鲜度。

一个可执行的修正策略是：

```text
支付写入 Source 成功
  -> 返回订单结果与 commit token
  -> 订单详情读取携带 token
  -> Replica 在 100 ms 内已执行 token：从 Replica 读
  -> 等待超时：回 Source 读
  -> 只有权威结果可以回填关键状态缓存
```

如果系统拿不到提交 GTID，支付结果直接读 Source 更稳妥。订单列表可以继续读满足延迟阈值的 Replica。这样把有限的主库容量留给真正需要权威结果的查询。

## 六、故障切换的第一步是阻止双主写入

主库故障后，旧 Source 与新 Source 同时接受写入会产生两条不同的事务历史，恢复后无法靠普通复制自动合并。网络分区时尤其容易发生这种情况：自动化系统判断旧 Source 不可达并提升一个 Replica，但旧 Source 仍在另一个网络区域运行，部分客户端还能连接它。

因此故障切换必须包含 fencing（隔离旧主）。`read_only=ON` 会拒绝普通客户端更新，但拥有 `CONNECTION_ADMIN` 或旧 `SUPER` 权限的账号仍能写；`super_read_only=ON` 会进一步禁止这些特权客户端写入。官方的[系统变量说明](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html)也指出，复制线程仍可在只读副本上应用更新。

这两个变量是防误写措施，不是完整的隔离机制。失联节点上可能无法及时设置变量，应用也可能保留旧连接。生产切换通常还需要代理摘流、服务发现变更、网络 ACL、节点关机或存储层隔离，确保任意时刻只有一个可写入口。

### 计划内切换怎样做

计划内切换的目标是 RPO=0，并把不可写时间控制在预算内。顺序可以概括为：

1. 选择健康候选副本，确认版本、配置、容量和复制链路；
2. 停止新写入或让入口进入短暂只读，等待在途事务完成；
3. 记录旧 Source 的最终 GTID 集合，等待候选副本全部执行；
4. 隔离旧 Source，关闭旧写入口；
5. 将候选副本提升为新 Source，关闭只读限制；
6. 更新代理与服务发现，把写流量指向新 Source；
7. 让其他副本通过 GTID Auto-Position 改为跟随新 Source；
8. 验证读写、GTID 连续性、复制线程和业务关键路径，再恢复全部流量。

![MySQL 计划内主库切换中的追平、隔离与提升顺序](/images/posts/mysql-failover-switchover.svg)

图中的隔离是硬门槛。候选副本追平但旧 Source 仍可写时，不能开放新 Source。提升完成后也不能立刻宣布结束，要确认连接池和代理没有继续向旧地址发送写请求。

### 非计划故障怎样选择候选副本

旧 Source 已经不可访问时，无法再做最终追平。故障处理系统应在存活副本中比较 `gtid_executed`，选择拥有最完整事务集合且状态健康的节点。异步复制下，任何副本都可能缺少旧 Source 最后提交的事务；半同步只能提高至少一个副本收到事务的概率，还要确认发送 ACK 的副本是否存活、事务是否能继续回放。

候选节点不能只按 `Seconds_Behind_Source` 最小选择。一个显示 0 的副本可能 Receiver 已停止；另一台副本可能已收到更多 GTID，只是 Applier 还有少量积压。真正要比较的是事务集合、Relay Log 可恢复性、线程错误和节点资源。

非计划切换的基本流程是：

```text
判定旧 Source 不可服务
  -> 阻断旧 Source 的所有客户端与代理路径
  -> 比较存活副本的 received / executed GTID
  -> 让候选副本回放已收到的 Relay Log
  -> 记录可能丢失的 GTID 区间与 RPO
  -> 提升候选副本并切换写入口
  -> 重挂其余副本
  -> 核对业务账、消息与外部副作用
```

数据库拓扑恢复后还要核对业务流水。数据库事务丢失不一定意味着外部动作没有发生：旧 Source 可能已提交并向支付渠道发出请求，但 Binlog 尚未到任何存活副本；也可能数据库提交结果对客户端未知，客户端已经重试。恢复过程要依靠业务幂等键、流水号和对账，复制线程恢复只是其中一个条件。

### 旧主库不能直接重新加入

旧 Source 恢复后，它可能包含新 Source 没有的事务，也缺少故障后新 Source 接受的事务。直接把它改成 Replica，容易遇到 GTID 冲突、唯一键冲突或更隐蔽的数据分叉。

安全做法通常是保留现场用于比对，然后从新 Source 的一致快照重建旧节点。若确实要抢救孤立事务，应先导出并按业务语义核对，再通过受控补偿写入，而不是修改 `gtid_executed` 或跳过复制错误让拓扑“看起来正常”。

## 七、运行时要监控进度、错误与业务新鲜度

复制监控至少有三层。

第一层是线程与错误：Receiver、Coordinator、Worker 是否运行，最近一次 I/O 与 SQL 错误是什么，错误从何时开始。`START REPLICA` 返回成功只代表线程启动命令已执行；官方文档明确提醒，线程随后连接失败或应用事件失败时，这条命令不会持续监控。

第二层是复制进度：Source 已提交、Replica 已接收、Replica 已执行三个水位之间的距离。GTID 差集比单个秒数更可靠；同时保留最老未执行事务的时间，才能判断业务陈旧程度。

第三层是业务结果：关键读请求有多少回退到 Source，GTID 等待超时率是多少，用户是否看到状态倒退，副本查询 p99 是否抬升。数据库水位正常但代理把关键读路由错了，故障仍然存在。

一组实用告警可以包括：

- 任一复制线程停止或持续重连；
- `Last_IO_Error`、`Last_SQL_Error` 出现新值；
- received 与 executed 的差集持续扩大；
- Source 与 received 的差集持续扩大；
- Relay Log 占用逼近磁盘或配置上限；
- Worker 长时间停留在同一事务或等待提交顺序；
- 半同步实际状态退回异步，或 ACK 等待时间异常；
- 关键读取的 Source 回退率、GTID 等待超时率超出预算。

### 复制不是备份

误删表、错误 UPDATE 和被入侵后的恶意写入都会通过 Binlog 复制到副本。副本能够承接读取和故障切换，不能替代独立备份、Binlog 归档和恢复演练。需要抵御逻辑误操作时，可以保留延迟副本，但它仍要配合访问隔离与明确的停止回放流程，否则延迟窗口过去后错误同样会被执行。

## 八、几个容易混淆的结论

| 说法 | 实际边界 |
| --- | --- |
| 副本连接正常，所以数据是新的 | Receiver 在线只说明连接存在，还要看接收与执行进度 |
| `Seconds_Behind_Source=0` 就完全追平 | Receiver 自身落后时，Applier 追上 Receiver 也可能显示 0 |
| 半同步返回成功后，副本已经可读 | ACK 通常发生在收到并记录事件后，回放可能尚未完成 |
| 开启 GTID 后不会丢事务 | GTID 标识事务并简化定位，不改变异步复制的确认边界 |
| `read_only` 能彻底防止双写 | 特权账号可能仍可写，失联旧主也无法靠远程设置完成隔离 |
| 副本越多，故障切换越安全 | 候选选择、日志保留、隔离和业务核对缺一不可 |
| 读写分离就是 SELECT 走副本 | 权威读、写后读和事务内读取需要单独路由 |

设计 MySQL 复制拓扑时，可以依次回答这些问题：

1. 业务允许的 RPO 和 RTO 是多少，异步还是半同步符合要求；
2. 哪些读取必须权威，哪些允许有界陈旧；
3. 写后读采用 Source 粘滞、GTID 等待还是固定读 Source；
4. 监控能否区分 Source 到 Receiver 与 Receiver 到 Applier 的积压；
5. 故障切换如何比较候选节点的事务集合；
6. 哪个系统负责隔离旧 Source，如何证明隔离已经生效；
7. 旧 Source 如何重建，孤立事务怎样通过业务对账处理；
8. 备份、Binlog 保留与恢复演练是否独立于在线副本。

MySQL 主从复制把一次提交延伸成跨节点流水线。读写分离是在这条流水线上选择读取位置，半同步调整主库返回成功前等待到哪个位置，GTID记录每个位置已经包含哪些事务，故障切换则要在只有部分进度可见时选出新主库并隔离旧主库。把这几个动作放回同一条事务路径，延迟、旧读和切换风险才会变成可以观测和处理的问题。

## 参考资料

- [MySQL 8.4 Reference Manual: Replication Threads](https://dev.mysql.com/doc/refman/8.4/en/replication-threads.html)
- [MySQL 8.4 Reference Manual: Relay Log and Replication Metadata Repositories](https://dev.mysql.com/doc/refman/8.4/en/replica-logs.html)
- [MySQL 8.4 Reference Manual: GTID Format and Storage](https://dev.mysql.com/doc/refman/8.4/en/replication-gtids-concepts.html)
- [MySQL 8.4 Reference Manual: GTID Life Cycle](https://dev.mysql.com/doc/refman/8.4/en/replication-gtids-lifecycle.html)
- [MySQL 8.4 Reference Manual: Replica Server Options and Variables](https://dev.mysql.com/doc/refman/8.4/en/replication-options-replica.html)
- [MySQL 8.4 Reference Manual: Semisynchronous Replication](https://dev.mysql.com/doc/refman/8.4/en/replication-semisync.html)
- [MySQL 8.4 Reference Manual: SHOW REPLICA STATUS](https://dev.mysql.com/doc/refman/8.4/en/show-replica-status.html)
- [MySQL 8.4 Reference Manual: Performance Schema Replication Tables](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-replication-tables.html)
