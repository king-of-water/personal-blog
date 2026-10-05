---
title: MySQL 事务隔离与 MVCC：从快照读、当前读到可重复读
description: 用双会话实验拆解 MySQL 四种隔离级别、InnoDB 版本链与 Read View，并讲清快照读、当前读、幻读和长事务。
category: 后端
subcategory: MySQL
articleClass: focused
seriesOrder: 30
featured: true
publishedAt: 2026-06-16T22:18:00+08:00
tags: [MySQL, InnoDB, 事务隔离, MVCC, Read View, 快照读, 当前读]
---

同一个事务里连续执行两次 `SELECT`，第二次应该看到别的事务刚提交的数据吗？普通查询不加锁，InnoDB 又怎样避免读到未提交修改？`SELECT ... FOR UPDATE` 为什么与普通 `SELECT` 的结果可能不同？

这些问题经常被拆成两套口诀：四种隔离级别解决脏读、不可重复读和幻读；MVCC 依靠 Undo Log 与 Read View 实现一致性读。只背两张表，遇到下面的事务就会卡住：

```sql
START TRANSACTION;

SELECT balance FROM account WHERE id = 42;
-- 另一个事务更新并提交
SELECT balance FROM account WHERE id = 42;
SELECT balance FROM account WHERE id = 42 FOR UPDATE;
```

第三条查询究竟应该返回旧值还是新值？答案取决于读取方式。前两条普通 `SELECT` 在 `REPEATABLE READ` 下通常共享一个一致性快照，第三条是锁定读，需要读取当前可用版本并加锁。一次事务可以因此观察到两个不同时间语义的数据库状态。

本文从一组可复现的双会话实验出发，连接隔离级别、版本链、Read View、快照读、当前读和范围锁。讨论范围是 MySQL 8.4 的 InnoDB；SQL 标准只用于解释异常名称，最终行为以 InnoDB 实现为准。

## 一、隔离级别约束事务可以观察到什么

事务隔离处理的是并发可见性。为了先建立语言，通常用三种读异常描述它：

- 脏读：读到另一个尚未提交事务的修改；对方随后回滚，读者曾经看到一个从未生效的状态。
- 不可重复读：同一事务两次读取同一行，期间另一个事务提交了更新或删除，两次结果不同。
- 幻读：同一事务按同一谓词读取一个集合，期间另一个事务插入满足条件的行，后一次多出“幻影”。

InnoDB 支持 `READ UNCOMMITTED`、`READ COMMITTED`、`REPEATABLE READ` 和 `SERIALIZABLE`，默认是 `REPEATABLE READ`。先用一张表给出普通一致性读的直觉：

| 隔离级别 | 普通 SELECT 的主要快照规则 | 典型代价或风险 |
| --- | --- | --- |
| `READ UNCOMMITTED` | 可以读取尚未提交的版本 | 允许脏读，业务很难推理 |
| `READ COMMITTED` | 每次一致性读建立新快照 | 同一事务两次查询可能不同 |
| `REPEATABLE READ` | 首次一致性读建立快照，后续复用 | 快照可能长期保留旧版本；混用锁定读要谨慎 |
| `SERIALIZABLE` | 在关闭自动提交时，普通 SELECT 隐式转成共享锁定读 | 并发下降，锁等待和死锁增加 |

这张表只描述普通读，不能直接推导 `UPDATE`、`DELETE` 和 `SELECT ... FOR UPDATE`。它们需要定位可修改的最新记录并加锁，遵循另一条读取路径。很多“RR 到底有没有幻读”的争论，根源就是把两条路径混在了一起。

## 二、先复现 RC 与 RR 的差异

建立一张最小测试表：

```sql
CREATE TABLE account (
    id      BIGINT PRIMARY KEY,
    balance INT NOT NULL
) ENGINE = InnoDB;

INSERT INTO account(id, balance) VALUES (42, 500);
```

打开会话 A 和 B。先在会话 A 使用 `READ COMMITTED`：

```sql
-- Session A
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
START TRANSACTION;
SELECT balance FROM account WHERE id = 42; -- 500
```

会话 B 更新并提交：

```sql
-- Session B
UPDATE account SET balance = 400 WHERE id = 42;
COMMIT;
```

会话 A 再读：

```sql
-- Session A
SELECT balance FROM account WHERE id = 42; -- 400
COMMIT;
```

RC 下每次一致性读建立新快照，所以第二条 `SELECT` 可以看到 B 已提交的 `400`。若把 A 改成 `REPEATABLE READ`，第一次普通查询建立快照后，第二次仍返回 `500`：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;
SELECT balance FROM account WHERE id = 42; -- 500
-- B 将它更新为 400 并提交
SELECT balance FROM account WHERE id = 42; -- 仍为 500
COMMIT;
```

[MySQL 的一致性非锁定读文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html)明确区分了这两种行为：RR 的同一事务使用首次一致性读建立的快照，RC 的每次一致性读使用新的快照。注意快照通常在第一次一致性读时建立，不一定在 `START TRANSACTION` 语句出现的那一刻建立；如果业务需要立即固定快照，可以显式使用 `START TRANSACTION WITH CONSISTENT SNAPSHOT`，但它只在支持一致性快照的隔离级别上有相应意义。

![READ COMMITTED 每次查询换快照，REPEATABLE READ 在事务内复用快照](/images/posts/mysql-rc-rr-readview-timeline.svg)

## 三、MVCC 保存的是版本关系，不是多份主表

Multi-Version Concurrency Control（MVCC）的目标，是让读取旧状态的事务不必阻塞正在写入新状态的事务。InnoDB 没有在聚簇索引里为每次更新并排保存整行副本。当前记录保留在聚簇索引中，旧值所需的信息保存在 Undo Log，再由回滚指针串起来。

[InnoDB Multi-Versioning 文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)列出三个内部字段：

- `DB_TRX_ID`：6 字节，标识最后插入或更新该行的事务；
- `DB_ROLL_PTR`：7 字节，指向 Undo Log 中可用于重建前一版本的记录；
- `DB_ROW_ID`：6 字节，只在 InnoDB 需要自动生成聚簇索引时作为隐藏行标识。

假设余额依次被事务 90、100、110 更新：

```text
聚簇索引当前记录
balance=300, DB_TRX_ID=110
          │ DB_ROLL_PTR
          ▼
Undo: balance=400, trx_id=100
          │
          ▼
Undo: balance=500, trx_id=90
```

一致性读先检查当前记录是否对自己的 Read View 可见。如果事务 110 太新，就沿 `DB_ROLL_PTR` 重建事务 100 对应的版本；100 仍不可见便继续向前。找到第一个可见版本后返回，链尾仍不可见则认为该行在快照中不存在。

![InnoDB 从聚簇记录沿 Undo 版本链寻找 Read View 可见版本](/images/posts/mysql-mvcc-version-chain.svg)

二级索引需要多一步判断。二级索引记录不携带聚簇记录的全部事务字段，旧索引项还可能处于 delete-mark 状态；一致性读发现页面可能包含过新的修改时，需要回到聚簇索引检查记录并沿 Undo 重建。长版本链会占用更多 Undo 空间，也会让本可覆盖的二级索引查询产生更多聚簇索引访问。

## 四、Read View 是一套可见性边界

版本链给出了“有哪些旧版本”，Read View 决定“当前事务能看见哪一个”。把 Read View 想成创建快照时对活跃读写事务的一次登记，比背字段名更有用。

MySQL 源码中的 [`ReadView::changes_visible`](https://github.com/mysql/mysql-server/blob/trunk/storage/innobase/include/read0types.h)体现了判断顺序。为避免旧教程中字段名称颠倒造成混乱，下面同时给出语义和当前源码常见字段：

| 语义 | 源码字段 | 判断 |
| --- | --- | --- |
| 创建快照的事务自身 | `m_creator_trx_id` | 自己产生的修改可见 |
| 快照建立时已完成的较老事务边界 | `m_up_limit_id` | `trx_id` 小于它，直接可见 |
| 快照建立后才出现的事务边界 | `m_low_limit_id` | `trx_id` 大于等于它，不可见 |
| 创建快照时仍活跃的读写事务集合 | `m_ids` | 落在集合中则不可见，不在集合中则已提交、可见 |

假设 Read View 创建时：

```text
creator = 105
active transaction ids = [100, 103]
up_limit = 100
low_limit = 110
```

那么版本的可见性可以这样推导：

- 事务 90 小于 100，快照建立前已经完成，可见；
- 事务 100 和 103 当时仍活跃，虽然编号较小，仍不可见；
- 事务 105 是当前事务自己的写入，可见；
- 事务 106 落在 100 到 110 之间且不在活跃集合中，说明创建快照前已经提交，可见；
- 事务 110 及之后才出现，不可见。

事务 ID 的大小只给出候选时间范围，活跃事务集合才补上并发事务交错的事实。仅用“比当前事务 ID 小就可见”解释 MVCC，会把创建快照时尚未提交的事务误判成已提交。

Read View 也不是把所有数据复制一份。它只保存可见性边界；实际读取旧行时，InnoDB 仍从当前记录出发，沿 Undo 版本链查找。因此，快照创建本身可以很轻，而一个很老的快照会迫使系统保留大量历史。

## 五、快照读和当前读分别解决什么问题

中文资料通常把普通一致性非锁定读称为“快照读”，把锁定读和 DML 的读取阶段称为“当前读”。MySQL 官方文档主要使用 Consistent Nonlocking Read、Locking Read 等术语。两个中文名称很方便，但要记住它们是对行为的归纳，不是所有 SQL 都存在一个可直接显示的 `current_read=true` 开关。

在 RC 和 RR 下，下列查询通常是快照读：

```sql
SELECT balance
FROM account
WHERE id = 42;
```

它根据 Read View 选择版本，一般不对读取的记录加行锁。下列语句需要读取可操作的最新版本并锁住目标：

```sql
SELECT balance FROM account WHERE id = 42 FOR SHARE;
SELECT balance FROM account WHERE id = 42 FOR UPDATE;
UPDATE account SET balance = balance - 100 WHERE id = 42;
DELETE FROM account WHERE id = 42;
```

`FOR SHARE` 取得共享锁，允许其他事务读取但限制冲突写入；`FOR UPDATE` 取得排他性更强的锁，常用于“读取后马上更新”的状态推进。普通 `UPDATE` 和 `DELETE` 也必须识别当前满足条件的记录并加相应锁，否则两个事务可能各自在旧快照上修改同一行。

继续使用 RR 实验。A 的普通查询已经读到快照中的 `500`，B 随后提交 `400`。A 再执行：

```sql
SELECT balance
FROM account
WHERE id = 42
FOR UPDATE;
```

在没有其他锁阻塞时，它会读取并锁定当前的 `400`，而不是把旧版本 `500` 锁住。[Locking Reads 文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)说明，锁只能施加在索引记录上，旧版本通过 Undo 重建，不是可以被直接锁定的当前记录。

这不是 RR 失效。快照读承诺的是同一 Read View 下的可重复观察；锁定读承诺的是基于当前可修改状态进行并发协调。一个事务混用两者时，开发者必须自己理解语义变化。

## 六、为什么事务能看到自己的写入

一致性快照会屏蔽快照建立后其他事务的提交，却不能屏蔽当前事务自己的修改，否则“写后读”会得到违反直觉的结果。Read View 的创建者事务 ID 是可见性规则中的特例。

考虑下面的 RR 事务：

```sql
START TRANSACTION;

SELECT * FROM account WHERE id = 42; -- 快照中 balance=500

UPDATE account
SET balance = 450
WHERE id = 42;

SELECT * FROM account WHERE id = 42; -- 看到自己的 450
COMMIT;
```

第二次普通 `SELECT` 仍使用原来的 Read View，但当前事务的版本对自己可见，因此返回 `450`。这会产生一个更微妙的现象：同一结果集中，事务可能看到自己刚修改的行，同时仍看不到其他事务在快照之后提交的其他行。MySQL 文档把这种混合视图描述为一种在数据库中并不存在于单一物理时刻的状态，并建议在需要锁定语义时避免随意混用普通查询和 DML。

再看一个容易答错的例子：A 建立 RR 快照后看不到 B 新插入的 `id=43`；A 随后执行 `UPDATE account SET balance=balance+10 WHERE id=43`。DML 按当前状态找到并更新这行后，A 的后续普通查询可以看到自己生成的新版本。原快照没看到 B 的版本，当前事务却能看到自己基于它写出的版本。

因此，“RR 整个事务永远看到事务开始时的数据库”并不准确。更精确的说法是：同一事务的普通一致性读复用快照，同时能看到本事务自己的写入；锁定读和 DML 按当前可操作记录工作。

## 七、幻读要分快照读和锁定读讨论

假设订单表有索引 `(status, id)`，A 在 RR 中执行：

```sql
SELECT *
FROM orders
WHERE status = 'PENDING';
```

如果这是普通快照读，B 之后插入另一条 `PENDING` 并提交，A 使用同一 Read View 再查时仍看不到新行。MVCC 从可见性上保持了结果集合稳定。

库存扫描、任务领取等业务还要基于“目前有哪些待处理行”采取动作：

```sql
SELECT *
FROM orders
WHERE status = 'PENDING'
FOR UPDATE;
```

锁定读必须防止另一个事务在已扫描范围中插入新记录，否则 A 锁住现有结果后，B 仍能制造一个满足同一谓词的新行。InnoDB 在 RR 下对范围搜索使用 Next-Key Lock：记录锁与其前方间隙锁的组合，覆盖索引范围中的现有记录和可插入间隙。对唯一索引上的唯一等值查询，通常只需要锁定目标记录；对范围或非唯一条件，则可能锁住多个记录与间隙。

在 RC 下，锁定读通常只锁实际扫描到的索引记录，Gap Lock 大多关闭，外键检查和重复键检查等情况除外。这减少锁冲突，也允许更多幻影插入。RC 仍然使用 MVCC，只是每条普通查询获得新快照，锁定范围也更窄。

所以面试中问“InnoDB RR 是否解决幻读”，需要先确认场景：

- 连续普通快照读：同一 Read View 不会看到后来提交的新行；
- 需要锁定并据此更新的范围操作：Next-Key Lock 阻止范围内并发插入；
- 先快照读、后当前读：后者可能看到快照之后已经提交的行，不能拿前一次结果当作同一个时间点的证据。

## 八、四种隔离级别怎样选择

### READ UNCOMMITTED

它允许普通查询观察未提交修改。即使只用于统计，也可能读到随后回滚的行、重复变化的值或内部过渡状态。线上业务很少有理由用它；“数据本来就不精确”也不意味着脏读没有代价，因为它破坏的首先是可解释性。

### READ COMMITTED

RC 每次一致性读使用新 Read View，更接近“每条语句读取执行时已经提交的数据”。它减少旧快照持有时间，锁定读和 DML 的 Gap Lock 也更少，因此许多高并发业务会选择 RC。

它并不自动消除业务竞态。下面的“先查再改”仍可能丢失更新：

```text
A 读取 balance=500
B 读取 balance=500
A 写入 400 并提交
B 写入 400 并提交
```

两个事务都完成了扣减计算，最终只少了 100。正确方案可以是原子更新 `balance = balance - 100` 并检查影响行数，或使用 `FOR UPDATE`，或加版本号进行乐观锁比较。隔离级别定义可见性，不替代业务并发控制。

### REPEATABLE READ

RR 适合一个事务内需要基于稳定快照完成多次关联读取的场景。InnoDB 默认使用它，并结合 Next-Key Lock 处理锁定范围操作。稳定快照的代价是旧版本保留时间更长；事务范围越大，应用越容易误把快照数据用于需要当前状态的决策。

### SERIALIZABLE

SERIALIZABLE 提供最强隔离。在关闭自动提交时，普通 `SELECT` 会隐式采用共享锁定读；事务更接近串行执行，但读写互相阻塞、死锁与超时都会增加。它适合确实需要数据库强制串行化且并发可接受的窄场景，不宜作为“不想分析并发”的全局开关。

隔离级别可以按会话或下一事务设置：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;
```

修改默认值前，应先盘点 ORM 是否自动开启事务、只读请求是否会长期持有连接，以及代码中是否依赖 RR 的范围锁行为。RC 与 RR 的区别会影响锁冲突、重试频率、任务扫描器正确性和查询结果。

## 九、MVCC 不能解决所有并发问题

MVCC 擅长让读写并发，却没有替应用定义业务不变量。下面几类问题仍需显式设计：

1. 两个请求同时创建“每个用户只能有一条”的记录，应使用数据库唯一约束兜底，而不是先查询不存在再插入。
2. 余额、库存等递减应使用条件更新，例如 `WHERE stock >= 1`，并检查影响行数。
3. 状态机推进可使用 `WHERE id=? AND status=?` 或 `version=?` 的 CAS 条件，失败后读取当前状态再决定。
4. 任务领取应使用锁定读、`SKIP LOCKED` 等明确的并发协议，同时处理事务失败后的重新可见。
5. 跨行、跨表甚至跨服务的不变量，可能需要更高层的锁、唯一键、事务或补偿机制。

Snapshot Isolation 一类机制还可能出现 Write Skew：两个事务读取同一个约束集合，却分别更新不同的行，单行写集没有冲突，合并结果却违反跨行约束。InnoDB 的具体结果还取决于语句取得的锁；工程上应把不变量落到可锁定记录、唯一索引或显式串行化点上，而不是假设“用了 RR 就不会并发出错”。

## 十、长事务为什么会拖慢整个实例

Update Undo 在没有任何 Read View 需要后才能清理。一个 RR 事务建立快照后长时间不提交，其他事务可以继续更新，但它们产生的旧版本要为这个老快照保留。后台 Purge 无法越过仍可能被读取的历史边界。

[Purge Configuration 文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-purge-configuration.html)说明，Purge 从 History List 中处理已提交事务的 Undo 页面，并在 MVCC 与回滚都不再需要后释放它们。长事务会带来一条逐步扩散的链：

```text
老 Read View 存活
  → Update Undo 不能清理
  → History List Length 增长
  → 读取旧版本需要走更长版本链
  → Undo 表空间、Buffer Pool 与 I/O 压力增加
  → 普通查询和写入都变慢
```

只读事务也可能造成这个问题。常见来源包括导出任务、管理后台分页、忘记提交的连接、ORM 把整段请求包进事务，以及“先开事务，再等待远程调用”的代码。

排查时可以结合以下信息：

```sql
SELECT *
FROM information_schema.innodb_trx
ORDER BY trx_started;

SHOW ENGINE INNODB STATUS;
```

重点看最老事务的开始时间、状态、正在执行的 SQL、锁等待，以及 `History list length` 是否持续上升。生产治理通常包括事务超时、连接池归还前回滚、批处理分段提交、只读导出走专用副本，以及禁止在数据库事务内等待不受控的 RPC。

不要看到 History List 增长就先调大 Purge 线程。若最老快照仍需要这些版本，再多 Purge 线程也不能合法删除；先找到阻塞清理的事务，才是在处理原因。

## 十一、排查并发读问题时按这条顺序问

遇到“明明提交了，为什么这个事务读不到”或“同一事务怎么读出了两个值”，可以按下面的顺序缩小范围：

1. 当前会话的隔离级别和 `autocommit` 是什么？
2. 事务何时开始，首次一致性读何时发生？
3. 这条 SQL 是普通一致性读、锁定读，还是 DML？
4. 读取的是自己写入的版本，还是其他事务提交的版本？
5. 查询用了哪个索引，锁的是单条记录还是一个范围？
6. 是否存在长事务保留旧 Read View，或锁等待让当前读停在执行中？
7. 业务真正需要的是稳定观察、最新状态，还是对后续写入的并发排他？

最后一个问题决定方案。报表读取可能需要稳定快照；账户扣款需要原子条件更新；任务领取需要当前状态与锁；唯一性应由约束确认。把所有需求都翻译成“提高隔离级别”，通常只会获得更大的锁范围和更难解释的超时。

## 十二、结论

MVCC 的最小模型由三部分组成：聚簇索引中的当前记录、Undo Log 中的旧版本、Read View 中的可见性边界。RC 每次一致性读更新边界，RR 在事务内复用首次一致性读的边界；当前事务自己的修改始终是特殊可见版本。

普通 `SELECT` 通过版本链获得快照，`FOR SHARE`、`FOR UPDATE` 和 DML 则面向当前可操作记录并加锁。RR 下的快照稳定性与 Next-Key Lock 共同处理两类“幻读”问题，但混合快照读和当前读仍会看到不同时间语义。隔离级别能规定可见性和锁行为，业务不变量仍需唯一键、条件更新、CAS 或显式锁来守住。

理解这条链路后，四种隔离级别不再是一张需要死记的异常表。它们是在选择 Read View 更新频率、锁定范围和并发成本，而每条 SQL 的读取方式决定这套选择怎样落到具体记录上。

## 参考资料

- [MySQL 8.4：Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [MySQL 8.4：Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html)
- [MySQL 8.4：Locking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)
- [MySQL 8.4：InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)
- [MySQL 8.4：Purge Configuration](https://dev.mysql.com/doc/refman/8.4/en/innodb-purge-configuration.html)
- [MySQL Server Source：ReadView](https://github.com/mysql/mysql-server/blob/trunk/storage/innobase/include/read0types.h)
