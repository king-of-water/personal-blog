---
title: MySQL 为什么需要三种日志：Undo Log、Redo Log 与 Binlog
description: 从一次 UPDATE 的提交与崩溃恢复出发，解释 Undo Log、Redo Log、Binlog 的职责、WAL、两阶段提交和持久性配置。
category: 后端
subcategory: MySQL
articleClass: focused
seriesOrder: 20
featured: true
publishedAt: 2026-06-25T10:38:00+08:00
tags: [MySQL, InnoDB, Undo Log, Redo Log, Binlog, WAL, 两阶段提交]
---

执行一条 `UPDATE` 时，MySQL 可能同时写 Undo Log、Redo Log 和 Binlog。把它们都叫作“日志”很容易产生一个误解：同一份修改为什么要记三遍？如果只保留一份，数据库是不是也能恢复？

答案藏在三个不同的问题里：事务想回滚时，怎样找回修改前的记录；内存里的脏页还没落盘就断电，怎样恢复已经提交的数据；主库之外的副本和备份，怎样重放这次业务修改。三个问题的使用者、数据形式和保存周期都不同，无法由一份日志自然地兼顾。

本文以 InnoDB 为主，围绕下面这笔余额更新追踪完整路径：

```sql
BEGIN;

UPDATE account
SET balance = balance - 100
WHERE user_id = 42;

COMMIT;
```

我们关心的不是背诵“Undo 用于回滚、Redo 用于恢复、Binlog 用于复制”，而是弄清四件事：修改发生在内存和磁盘的什么位置，`COMMIT` 返回前必须持久化什么，进程在不同时间点崩溃会得到什么结果，以及两阶段提交为什么能避免 InnoDB 与 Binlog 互相矛盾。

## 一、先把三种日志放回各自的系统边界

Undo Log 和 Redo Log 属于 InnoDB 存储引擎。Binlog 属于 MySQL Server 层，其他支持二进制日志的存储引擎也可以把变更交给它。这个边界比“物理日志还是逻辑日志”的标签更重要：前两者维护一台实例内部的事务与数据页，后者记录可供实例之外消费的数据变化。

| 日志 | 主要回答的问题 | 主要使用者 | 典型生命周期 |
| --- | --- | --- | --- |
| Undo Log | 修改如何撤销，旧版本如何重建 | 回滚、MVCC、一致性读、Purge | 没有事务再需要旧版本后才可清理 |
| Redo Log | 已提交修改怎样在崩溃后重新落到数据页 | InnoDB 崩溃恢复、检查点机制 | 日志覆盖范围内的数据页安全落盘后可复用 |
| Binlog | 数据变化怎样被另一个实例重放 | 复制、增量恢复、CDC | 按保留策略轮转和清理 |

![Undo、Redo 与 Binlog 分别服务于旧版本、实例恢复和实例外重放](/images/posts/mysql-three-logs-responsibilities.svg)

三者记录的内容也不相同。Undo 保存足以构造修改前版本的信息；Redo 描述 InnoDB 数据结构所发生的可重做变化；Binlog 记录 MySQL 层的数据变更事件。把 Redo 简称为“物理日志”、Binlog 简称为“逻辑日志”可以帮助入门，但不要把它理解成逐字节磁盘镜像和原 SQL 文本：Redo 是面向 InnoDB 页结构的重做记录，Row 格式 Binlog 保存的则是行事件。

## 二、先理解数据页为什么不能在每次提交时落盘

InnoDB 以页为单位管理数据，查询或修改前通常先把页面读入 Buffer Pool。一条 `UPDATE` 修改的是内存中的页，这个页随后成为脏页；真正的表空间文件可以稍后由后台线程批量刷写。

如果每次提交都要求把所有相关数据页同步写盘，会碰到两个问题。一次事务可能修改许多分散页面，写入位置随机；一个页面上还可能包含多个事务的记录，很难把“提交某个事务”直接等价成“完整刷出若干页面”。小而连续的日志写入更适合提交路径。

Write-Ahead Logging（WAL）的基本约束是：允许数据页延迟落盘，但在数据库确认事务成功前，必须先让足够的 Redo 记录到达约定的持久化边界。崩溃后，InnoDB 从磁盘上的旧数据页出发，重放 Redo，补上尚未刷入表空间的变化。

这带来一个经常被忽略的结论：`COMMIT` 成功不等于相关数据页已经写入 `.ibd` 文件。成功意味着事务满足当前配置定义的提交持久性；在最强常用配置下，Redo 和 Binlog 已经同步到稳定存储，数据页仍可以留在 Buffer Pool 中。

## 三、Undo Log 保存的是“回去的路”

更新 `balance=500` 为 `400` 之前，InnoDB 必须保留足够的信息，以便事务失败时恢复旧值。Undo 记录位于 Undo Tablespace 的回滚段中。MySQL 官方的 [Undo Log 文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-undo-logs.html)将它定义为与读写事务关联的撤销记录；[多版本文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)进一步说明，InnoDB 也用这些记录构造一致性读需要的旧行版本。

因此，Undo 同时服务两个路径：

- 当前事务执行 `ROLLBACK`，或语句因错误被撤销时，沿 Undo 恢复修改前状态；
- 其他事务的快照需要看到较早版本时，从当前记录沿回滚指针找到可见版本。

对聚簇索引记录，InnoDB 维护 `DB_TRX_ID` 和 `DB_ROLL_PTR` 等隐藏字段。前者标识最近插入或更新它的事务，后者指向相应 Undo 记录。多次更新形成的是“当前聚簇记录加一串 Undo 记录”，并非在主表中并排保存多份完整行。

Undo 的清理也不能只看写事务是否已经提交。Insert Undo 只服务事务回滚，提交后通常可以释放；Update Undo 还可能被旧快照读取，必须等到不再有 Read View 需要它时，才能由 Purge 处理。长事务即使只读，也可能让旧版本长期保留。这部分会在下一篇 MVCC 中展开。

还有一个容易绕晕的问题：如果 Undo 本身只在内存里，数据库崩溃时拿什么回滚未完成事务？Undo 页面也是 InnoDB 管理的数据页，对持久 Undo 的修改同样会产生 Redo。恢复时先通过 Redo 把数据库结构推进到崩溃前可恢复的状态，再利用 Undo 撤销未提交事务。Redo 也负责保护 Undo 的持久性。

## 四、Redo Log 让脏页可以晚一点写

[MySQL 8.4 Redo Log 文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html)把 Redo 定义为用于崩溃恢复的磁盘数据结构。记录带有递增的 Log Sequence Number（LSN）；检查点表示在某个 LSN 之前，恢复所需的数据页变化已经安全推进到表空间。

一次更新大致经历下面几层状态：

1. 修改 Buffer Pool 中的数据页，同时写入内存中的 Redo Log Buffer；
2. Redo 被写入操作系统页缓存；
3. `fsync` 等操作把日志推进到稳定存储；
4. 脏数据页在之后某个时间被刷入表空间；
5. 检查点前进，较老 Redo 空间可以复用。

“写入文件”和“同步到磁盘”不是一回事。机器断电可能丢失仍停留在操作系统缓存中的内容，所以 `innodb_flush_log_at_trx_commit` 决定了事务提交时写 Redo 和刷盘的策略：

| 值 | 提交时行为的核心差异 | 主要风险 |
| --- | --- | --- |
| `1` | 每次提交写 Redo 并同步到磁盘 | 常用的最强持久性边界，成本是更多同步写 |
| `2` | 每次提交写到操作系统缓存，周期性同步 | mysqld 崩溃通常可保留，操作系统或断电可能丢最近事务 |
| `0` | 写入和同步主要按周期执行 | mysqld 崩溃也可能丢最近事务 |

这里的“周期”不是精确的一秒交付协议，不能据此承诺最多只丢一秒。调度、系统负载和存储实现都会影响实际窗口。对支付、订单等需要明确持久性承诺的数据库，通常以 `1` 为基线，再用组提交、合适的 Redo 容量和存储能力消化同步写成本。

Redo 容量不足也会影响吞吐。脏页刷写赶不上日志增长时，检查点无法及时前进，可复用空间减少，前台写入会被迫等待更积极的刷脏。扩大 Redo 容量能吸收更长的写入突发，却会增加极端情况下需要扫描和重放的日志范围。它是吞吐、刷脏压力和恢复时间之间的容量选择。

## 五、Binlog 记录给实例之外看的变化

[MySQL Binary Log 文档](https://dev.mysql.com/doc/refman/8.4/en/binary-log.html)列出的两个核心用途是复制和时间点恢复。主库把完成的数据变化写成事件，副本读取并应用；恢复时先还原一次全量备份，再将备份之后的 Binlog 重放到目标时间点。

Binlog 不负责修复本机某个没刷盘的数据页，这件事属于 Redo。Redo 通常也不能替代 Binlog 做长期增量恢复：它服务 InnoDB 内部页面恢复，空间会循环复用，不是面向跨实例重放的业务事件序列。

MySQL 支持三种 Binlog 格式：

- `STATEMENT` 记录产生变化的语句，体积有时更小，但需要保证副本重放具有确定性；
- `ROW` 记录行变化事件，能更直接地复现变更，也是 MySQL 8.4 默认格式；
- `MIXED` 由服务器根据语句选择前两种格式。

Row 格式也不是“把整张数据页复制一遍”。它保存表映射和行事件，副本仍要通过自己的存储引擎把事件应用为本地页面修改。大事务会占用更大的 Binlog Cache，并形成更大的事务事件；复制端也必须完整接收和应用它，所以拆分批量写入往往比只调大缓存更有效。

`sync_binlog` 控制 Binlog 同步频率。`sync_binlog=1` 表示每个提交组写完后同步 Binlog，提供最强的常用 Binlog 持久性；大于 `1` 或为 `0` 可以减少同步次数，但机器崩溃时可能丢失已经写入文件缓存、尚未同步的尾部事件。仅把 Redo 配成最安全，而让 Binlog 留在易丢状态，仍可能破坏数据文件与复制日志的一致性。

## 六、一次 UPDATE 怎样穿过三种日志

回到开头的余额更新。为了突出日志关系，先忽略 SQL 解析、优化器选路和锁等待，保留事务内部最关键的步骤：

1. InnoDB 根据索引找到 `user_id=42` 的记录，并取得所需行锁。
2. 生成 Undo 信息，使 `balance=400` 可以还原成 `500`，也让旧快照能够重建旧版本。
3. 修改 Buffer Pool 中的聚簇索引记录；涉及的 Undo 页、数据页和索引页变化生成 Redo。
4. MySQL Server 将事务对应的 Binlog Event 暂存在事务缓存中。
5. 提交阶段，InnoDB 把事务推进到 `prepare`，并按配置持久化相应 Redo。
6. Server 把完整事务写入 Binlog，并按 `sync_binlog` 约定同步。
7. InnoDB 将事务标记为 `commit`，完成提交；锁随后释放，客户端收到结果。
8. 数据页稍后刷盘，检查点继续前进；旧 Undo 在没有 Read View 需要后由 Purge 清理。

![一次 UPDATE 从 Undo、Redo 到 Binlog 的提交顺序](/images/posts/mysql-update-three-logs-sequence.svg)

真实实现还包含组提交和并发排序等细节，但这个模型足以解释每一种崩溃结果。组提交会把多个事务的日志同步合并成较少的 `fsync`，摊薄持久化成本；它没有削弱单个事务约定的持久性，只是改变批次组织方式。

## 七、为什么 Redo 和 Binlog 之间需要两阶段提交

Redo 与 Binlog 由不同层维护。如果简单地依次提交，中间总存在一个崩溃窗口。

假设先把 InnoDB 提交，再写 Binlog。两步之间宕机，主库数据已经生效，Binlog 却没有这笔事务；副本和时间点恢复都会缺少它。反过来先写 Binlog，再提交 InnoDB，宕机后若 InnoDB 回滚，Binlog 却会让副本执行一笔主库不存在的事务。

MySQL 使用内部两阶段提交协调二者。可以把普通 InnoDB 事务的提交决策理解成三个关键点：

```text
InnoDB prepare  →  Binlog durable  →  InnoDB commit
```

`prepare` 表示 InnoDB 已经保存足够信息，崩溃后既能提交也能回滚；Binlog 持久化后，Server 获得跨层的提交依据；最后写入 InnoDB 提交标记。MySQL 官方 [Binary Log 文档](https://dev.mysql.com/doc/refman/8.4/en/binary-log.html)说明，重启时服务器会扫描最新 Binlog 中的事务 XID，并要求 InnoDB 完成已经成功写入 Binlog 的 prepared 事务，同时把 Binlog 截断到最后一个有效位置。

于是不同崩溃点有确定结果：

| 崩溃位置 | Binlog 是否有完整事务 | InnoDB 恢复决定 | 对外结果 |
| --- | --- | --- | --- |
| `prepare` 之前 | 否 | 回滚未提交事务 | 两边都没有 |
| `prepare` 之后、Binlog 持久化之前 | 否 | 回滚 prepared 事务 | 两边都没有 |
| Binlog 持久化之后、InnoDB commit 之前 | 是 | 根据 XID 完成提交 | 两边都有 |
| InnoDB commit 之后 | 是 | 保持提交 | 两边都有 |

这张表成立还依赖日志本身达到所声明的持久性边界。常见的强持久配置组合是：

```ini
innodb_flush_log_at_trx_commit = 1
sync_binlog = 1
```

两阶段提交解决的是 Redo 和 Binlog 的原子一致性；两个 `1` 解决的是它们何时真正同步到稳定存储。协议和刷盘策略处理的是两类问题，不能互相替代。

## 八、崩溃恢复时 Redo 和 Undo 各做什么

[InnoDB Recovery 文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-recovery.html)把崩溃恢复分成 Redo 应用、未完成事务回滚、Change Buffer 合并和 Purge 等阶段。最简模型可以记为“先重做，再撤销”：

1. 从检查点附近开始应用 Redo，把数据页和事务元数据推进到日志所描述的状态；
2. 确认哪些事务已经提交、哪些处于可恢复的 prepared 状态、哪些仍未完成；
3. 对未提交事务沿 Undo 回滚，对已进入 Binlog 的 prepared 事务完成提交；
4. 后台继续处理耗时的回滚、Purge 等工作，并尽早恢复对外服务。

为什么不直接跳过未提交事务的 Redo？因为 Redo 不只包含最终业务行，还可能保护 Undo 页、索引结构和其他页面状态。恢复首先需要把存储结构修复到一致、可解释的状态，随后才能按事务结果撤销不应保留的变化。

大事务在崩溃时会让恢复更慢。官方文档指出，未完成事务的回滚时间可能达到事务运行时间的数倍；服务虽然可能较早接受连接，新请求仍可能遇到被恢复事务持有的锁。限制单事务规模可以同时控制复制压力、恢复时间和故障影响面。

## 九、三个常见误区

### “Undo 是 Redo 的反向记录”

这个说法忽略了用途和结构。Undo 要支持语义上的事务撤销和旧版本重建，Redo 要支持页面级崩溃恢复。某个更新的 Undo 可以表达“旧余额是 500”，Redo 记录的是让 InnoDB 结构重做到某状态所需的信息。两者可能都与同一次修改有关，但不能互相简单取反。

### “有了 Binlog 就不需要 Redo”

Binlog 可以在备份基础上做时间点恢复，却不适合替代本机每次崩溃后的快速页面恢复。它不知道 Buffer Pool 中哪些脏页已经落盘，也不以 InnoDB 页面状态和检查点作为恢复边界。若每次宕机都从全量备份重放全部业务日志，恢复时间和运维成本都不可接受。

### “客户端收到成功就绝不可能丢数据”

这取决于配置、存储硬件和系统边界。`innodb_flush_log_at_trx_commit=1` 与 `sync_binlog=1` 把单机日志推进到最强常用边界，但不能替代备份、跨机复制和灾难恢复。磁盘损坏、整个主机不可恢复或机房事故，需要副本和备份处理；复制是否同步、备份是否可恢复又属于新的保证层级。

## 十、用一张决策表收束

| 你要解决的问题 | 应先看什么 | 不应误用什么 |
| --- | --- | --- |
| 当前事务撤销 | Undo、事务状态 | Binlog 不是行级回滚日志 |
| 一致性读旧版本 | Undo、Read View、Purge | Redo 不提供业务快照 |
| 实例崩溃后恢复脏页 | Redo、Checkpoint、刷盘策略 | Binlog 不知道页面刷盘进度 |
| 主从复制 | Binlog、Relay Log、应用进度 | Redo 不是跨实例复制协议 |
| 从备份恢复到某个时间点 | 全量备份加 Binlog | 只保留循环使用的 Redo 不够 |
| 保证 Redo 与 Binlog 不打架 | 内部两阶段提交、XID | 调高任意一个缓存不能替代协议 |
| 明确提交后断电是否可能丢失 | 两个刷盘参数与真实存储语义 | 只看 `COMMIT` 返回值不够 |

Undo 让修改可以后退，也给 MVCC 留下旧版本；Redo 让数据页可以延迟落盘，同时保持实例可恢复；Binlog 把已经决定的数据变化交给复制和时间点恢复。两阶段提交再把 InnoDB 的事务结果与 Server 层事件序列对齐。沿着一次 `UPDATE` 看完整条路径，三个相似的名字就会变成三个清楚的系统边界。

## 参考资料

- [MySQL 8.4：Undo Logs](https://dev.mysql.com/doc/refman/8.4/en/innodb-undo-logs.html)
- [MySQL 8.4：InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)
- [MySQL 8.4：Redo Log](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html)
- [MySQL 8.4：InnoDB Recovery](https://dev.mysql.com/doc/refman/8.4/en/innodb-recovery.html)
- [MySQL 8.4：The Binary Log](https://dev.mysql.com/doc/refman/8.4/en/binary-log.html)
- [MySQL 8.4：Binary Logging Options and Variables](https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html)
