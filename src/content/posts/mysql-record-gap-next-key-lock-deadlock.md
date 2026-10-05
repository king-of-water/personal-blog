---
title: MySQL 锁与死锁：Record Lock、Gap Lock 和 Next-Key Lock
description: 从 InnoDB 锁住的索引区间出发，讲清 Record Lock、Gap Lock、Next-Key Lock、Insert Intention Lock，以及死锁定位与事务重试。
category: 后端
subcategory: MySQL
articleClass: focused
seriesOrder: 40
featured: true
publishedAt: 2026-06-18T23:31:00+08:00
tags: [MySQL, InnoDB, Record Lock, Gap Lock, Next-Key Lock, 死锁, 索引]
---

下面两条 SQL 都只返回一行，锁的范围却可能完全不同：

```sql
SELECT * FROM orders WHERE id = 42 FOR UPDATE;

SELECT * FROM orders
WHERE status = 'PENDING'
ORDER BY id
LIMIT 1
FOR UPDATE;
```

第一条通过主键唯一定位，通常只锁住 `id=42` 的索引记录。第二条要沿 `status` 对应的索引区间扫描，除了命中的记录，还可能锁住记录之间的空隙，阻止其他事务插入新的 `PENDING` 订单。即使最后只返回一行，存储引擎也可能访问并锁定更大的范围。

这正是 InnoDB 锁最容易讲乱的地方。开发者写的是行条件，InnoDB 操作的却是 B+ 树索引记录和索引区间。Record Lock、Gap Lock 与 Next-Key Lock 不是三个孤立功能，它们是在回答同一个问题：一条锁定查询沿某棵索引扫描时，哪些已有记录可以被修改，哪些位置暂时不能插入新记录。

本文以 MySQL 8.4 InnoDB 为准，讨论索引区间、锁范围、死锁和应用重试。普通快照读与 Read View 已在上一篇 [MySQL 事务隔离与 MVCC](/posts/mysql-isolation-mvcc-snapshot-current-read/) 中展开，这里集中讨论锁定读与写操作。

## 一、InnoDB 所谓的行锁实际锁在索引上

[MySQL 的 InnoDB Locking 文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)对 Record Lock 的定义很直接：它锁定的是 index record。即使表没有显式索引，InnoDB 也会建立隐藏聚簇索引，并在这棵索引上加锁。

假设表结构如下：

```sql
CREATE TABLE orders (
    id          BIGINT PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    status      VARCHAR(16) NOT NULL,
    created_at  DATETIME NOT NULL,
    amount      DECIMAL(12, 2) NOT NULL,
    KEY idx_user (user_id),
    KEY idx_status_created (status, created_at, id)
) ENGINE = InnoDB;
```

这张表至少有三棵相关的 B+ 树：聚簇索引 `PRIMARY(id)`、二级索引 `idx_user(user_id,id)`，以及 `idx_status_created(status,created_at,id)`。二级索引叶子记录会携带主键，用于回到聚簇索引定位完整行。

执行下面的写操作：

```sql
UPDATE orders
SET amount = 99.00
WHERE user_id = 7;
```

如果优化器选择 `idx_user`，InnoDB 沿这棵二级索引扫描 `user_id=7` 的记录。对需要排他锁的二级索引记录，InnoDB 还会取出对应主键，并锁定聚簇索引记录。[不同 SQL 的加锁说明](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)明确写到，使用二级索引搜索并设置排他锁时，相应的聚簇索引记录也会被锁住。

所以“锁一行”可能同时涉及两棵索引。排查锁冲突时，只看业务 `WHERE` 条件不够，还要看实际访问路径：优化器选了哪棵索引，扫描了多少索引记录，是否发生回表。

## 二、S、X 与意向锁是兼容性规则

Record、Gap、Next-Key 描述锁覆盖的位置；Shared（S）和 Exclusive（X）描述同一位置上的操作兼容性。两组概念处于不同维度。

S 锁允许持有者读取被锁记录，另一个事务也可以取得 S 锁，但不能取得 X 锁。X 锁用于更新或删除；其他事务对同一记录申请 S 或 X 都要等待。常见 SQL 可以先这样理解：

| SQL | 典型锁模式 | 用途 |
| --- | --- | --- |
| 普通 `SELECT` | RC、RR 下通常不加记录锁 | 通过 MVCC 读取快照 |
| `SELECT ... FOR SHARE` | S | 读取后保证目标当前不能被冲突修改 |
| `SELECT ... FOR UPDATE` | X | 读取后准备修改或领取资源 |
| `UPDATE`、`DELETE` | X | 修改扫描命中的记录 |

InnoDB 还会在表级别设置 Intention Shared（IS）或 Intention Exclusive（IX）锁。事务对某行申请 S 锁前，先在表上取得 IS；申请 X 锁前，先取得 IX。意向锁主要让表锁快速判断“表内是否有人持有行锁”，无需遍历所有记录锁。

两个事务可以同时持有同一张表的 IX，因为它们可能修改不同的行。IX 不代表整张表被排他锁住。它会与表级 S、X 请求发生相应冲突，因此在 `data_locks` 中看到 `TABLE IX` 时，不应直接判断为“发生表锁，所有写都串行”。

## 三、Record Lock 保护一条已有索引记录

对主键或完整唯一索引做唯一等值搜索，且目标记录存在时，InnoDB 通常只需要 Record Lock：

```sql
SELECT *
FROM orders
WHERE id = 42
FOR UPDATE;
```

主键 `id=42` 只可能对应一条记录。锁住这条记录后，其他事务不能更新或删除它，也不能取得冲突的锁；`id=41` 和 `id=43` 仍可独立修改，在相邻位置插入其他主键也不需要为了防止当前谓词出现幻影而封锁整个区间。

在 InnoDB Monitor 或 `performance_schema.data_locks` 中，这类锁常显示为 `X,REC_NOT_GAP`，意思是 X 模式的记录锁，不包含前方 Gap。

“完整唯一条件”几个字不能省略。若唯一索引是 `(tenant_id, order_no)`，查询只写 `order_no=?`，它并没有唯一定位一条索引记录，InnoDB 仍要扫描多个 `tenant_id` 区间。若目标唯一键根本不存在，系统为了保证当前事务基于“该键不存在”继续操作时不会被并发插入破坏，也可能锁住它应当出现的位置。判断锁范围不能只看索引定义上有没有 `UNIQUE`，还要看查询是否完整使用唯一键，以及扫描实际遇到了什么。

## 四、Gap Lock 锁住的是两个索引记录之间的插入位置

假设某索引当前有值：

```text
10, 20, 30
```

它隐含四个 Gap：

```text
(-∞, 10)   (10, 20)   (20, 30)   (30, +∞)
```

Gap Lock 不锁住 `10`、`20`、`30` 这些已有记录，只禁止其他事务向指定空隙插入新索引记录。锁住 `(10,20)` 后，插入 `15` 会等待；更新已经存在的 `10` 或 `20` 是否受阻，取决于它们各自的 Record Lock，而不是这个 Gap Lock。

Gap 也不要求真的“有空间”。两个相邻键之间没有其他整数，甚至索引值在业务上连续，InnoDB 仍把它们之间视为一个索引位置区间。前无穷和后无穷也属于可锁范围，最大键之后通过 supremum 伪记录表示边界。

Gap Lock 的兼容性很特殊。官方文档称它为 purely inhibitive：用途只是阻止插入。不同事务持有同一 Gap 上所谓的 S Gap Lock 和 X Gap Lock 可以共存，它们不会像普通 S/X Record Lock 那样互相排斥。看到“X locks gap”不能简单理解成这个区间只归一个事务所有。

Gap Lock 主要出现在 RR 的锁定搜索、范围更新和删除中。切换到 RC 后，普通搜索与索引扫描的大部分 Gap Lock 会关闭，但外键约束检查和重复键检查仍可能使用它。RC 能缩小部分锁范围，却不能让写事务不再死锁，也不能取消所有 Gap 相关锁。

## 五、Next-Key Lock 把记录和它前面的 Gap 合在一起

Next-Key Lock 等于“某条索引记录的 Record Lock，加上它前面的 Gap Lock”。若索引值为 `10、11、13、20`，可能形成以下区间：

```text
(-∞, 10]  (10, 11]  (11, 13]  (13, 20]  (20, +∞)
```

左开右闭来自它的组成方式。以 `(11,13]` 为例，它锁住记录 `13`，同时禁止在 `11` 和 `13` 之间插入新记录。最后的 `(20,+∞)` 实际锁住最大值之后的 Gap 与 supremum 伪记录，没有一条真实的“正无穷记录”。

![Record Lock、Gap Lock 与 Next-Key Lock 在索引上的覆盖范围](/images/posts/mysql-record-gap-next-key-lock-ranges.svg)

在默认 RR 隔离级别下，InnoDB 对非唯一搜索和范围扫描通常使用 Next-Key Lock，从而让已读取的索引范围保持稳定。它解决的是“集合本身可能长出新行”的问题：只锁住当前存在的记录，还挡不住另一个事务在两条记录之间插入满足条件的新记录。

例如：

```sql
SELECT *
FROM orders
WHERE status = 'PENDING'
  AND created_at < '2026-10-05 00:00:00'
FOR UPDATE;
```

如果使用 `idx_status_created(status,created_at,id)`，InnoDB 沿着 `status='PENDING'` 且时间小于边界的连续索引区间扫描。它会锁住遇到的记录和相关 Gap，使其他事务不能在这个已锁范围内插入新的匹配元组。锁的对象是复合键 `(status,created_at,id)` 的区间，并非单独的 `created_at` 数轴。

## 六、SQL 返回多少行不等于锁多少行

[MySQL 官方文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)指出，锁定读、`UPDATE` 与 `DELETE` 通常对执行过程中扫描到的索引记录加锁。InnoDB 记住的是扫描过的索引范围，不会保存原始 `WHERE` 表达式并在之后用业务语义缩小锁集合。

这会产生几个反直觉结果。

第一，`LIMIT 1` 只约束最终返回或处理的行数。为了找到第一条符合条件的记录，执行器可能已经扫描了多条索引记录。具体哪些非匹配记录能够提前释放，还受隔离级别和执行计划影响。

第二，没有合适索引时，MySQL 可能做全表扫描。对锁定读或写语句，扫描路径会让大量聚簇索引记录被锁住，其他插入和更新也更容易受阻。一个“只更新很少几行”的 SQL，可能因为索引缺失演变成大范围锁。

第三，二级索引扫描可能同时锁二级索引记录和对应聚簇索引记录。并发事务如果从另一条访问路径以不同顺序接触这些记录，等待关系会比 SQL 表面复杂。

第四，优化器换索引会改变加锁顺序和范围。同一条 SQL 在数据分布、统计信息或索引结构变化后，返回结果相同，锁冲突模式却可能发生变化。因此，加锁分析应该从 `EXPLAIN` 的访问路径开始，而不是从结果集行数倒推。

## 七、Insert Intention Lock 为什么不让同一 Gap 内的插入全部串行

Gap Lock 负责阻止插入，但正常情况下，两个事务向同一个 Gap 的不同位置插入不应互相阻塞。Insert Intention Lock 用来表达这种“我要在这里插入”的意图。

假设索引只有 `4` 和 `7`，两个事务分别插入 `5`、`6`。它们都会在 `(4,7)` 上取得 Insert Intention Lock，再对各自新记录申请 X Record Lock。因为插入位置不同，二者可以并发进行。

如果另一个事务已经通过范围锁定持有 `(4,7)` 的 Gap Lock，插入意向会等待。监控中常见的描述是：

```text
lock_mode X locks gap before rec insert intention waiting
```

它表示插入者正在等待进入某个 Gap，不是已经用 X 模式独占整段空隙。Insert Intention Lock 自身的价值，正是避免把互不冲突的插入错误地串成一条队列。

唯一键冲突又是另一条路径。多个事务插入相同唯一键，需要进行重复键检查，并可能围绕目标索引记录或位置形成等待，最后由一个事务成功，其他事务收到重复键错误或在复杂交错中形成死锁。不能因为 SQL 只有单行 `INSERT` 就断言它绝不会死锁；一行数据可能对应主键、多个二级索引和唯一约束上的多次加锁。

## 八、一个待处理订单查询到底锁什么

回到开头第二条查询，补全索引和条件：

```sql
SELECT id, user_id, amount
FROM orders
WHERE status = 'PENDING'
ORDER BY created_at, id
LIMIT 1
FOR UPDATE;
```

若存在 `idx_status_created(status,created_at,id)`，扫描从 `status='PENDING'` 的最早元组开始。RR 下它通常会对扫描位置设置 Next-Key Lock，并对返回行对应的聚簇索引记录设置 X Lock。后续事务是否能插入新的 `PENDING`，取决于新元组在索引顺序中落到哪个 Gap，以及该 Gap 是否被当前扫描覆盖。

若没有这条联合索引，优化器可能选择 `idx_status` 后再排序，或直接扫描更多记录。为了得出同一条结果，数据库访问和锁定的记录数会显著增加。`ORDER BY ... LIMIT 1` 并不会神奇地把锁缩成一行，合适的有序索引才能让搜索尽早停止。

多个 worker 并发领取任务时，通常还会考虑：

```sql
SELECT id
FROM orders
WHERE status = 'PENDING'
ORDER BY created_at, id
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

`SKIP LOCKED` 让 worker 跳过已被其他事务锁住的候选记录，减少排队，很适合队列式表消费。它返回的是一个可能不一致的当前视图，不适合普通业务查询；而且 worker 仍需在同一短事务内把选中记录更新为处理中状态并提交。跳过锁只改变等待策略，没有提供消息确认、失败重投和业务幂等。

## 九、死锁是一张出现环的等待图

锁等待本身不等于死锁。事务 B 等待 A 的锁，而 A 最终可以提交，这只是一条等待链。死锁要求等待关系形成环。

最典型的是双向转账。事务 A 先锁账户 1，再锁账户 2；事务 B 同时先锁账户 2，再锁账户 1：

```text
事务 A：持有 account(1)，等待 account(2)
事务 B：持有 account(2)，等待 account(1)
```

两者都无法继续，也都不会主动释放已经持有的锁。等待图出现 `A → B → A` 的环。

![两个事务以相反顺序锁定账户后形成死锁等待环](/images/posts/mysql-deadlock-wait-for-cycle.svg)

InnoDB 默认启用 `innodb_deadlock_detect`。检测到环后，它选择一个受害事务回滚，打破等待。官方[死锁检测文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlock-detection.html)说明，InnoDB 倾向回滚较小的事务，大小按已插入、更新或删除的行数衡量。被选中的事务收到死锁错误，另一方随后取得锁继续运行。

死锁也可能来自同一张表上的范围与插入、二级索引和主键的不同访问顺序、唯一键检查，甚至看起来只有单行的插入与删除。根因仍然可以还原为三件事：每个事务已经持有什么，正在申请什么，申请顺序怎样形成了环。

## 十、死锁与锁等待超时不是同一种失败

死锁检测通常立即发现等待环，并回滚一个完整事务。应用常见错误码是 `1213`，SQLSTATE 为 `40001`。因为整个事务已经撤销，重试必须从事务入口重新执行，不能只补发最后失败的 SQL。

锁等待超时则可能只有一条长等待链，没有环。事务等待超过 `innodb_lock_wait_timeout` 后收到 `1205`。MySQL 8.4 默认值是 50 秒，但线上系统通常会结合请求 deadline、事务长度和业务延迟目标设置更合适的会话或全局值。

二者的回滚边界也不同：[InnoDB Error Handling](https://dev.mysql.com/doc/refman/8.4/en/innodb-error-handling.html)规定，死锁会回滚整个事务；锁等待超时默认只回滚正在等待的语句，除非服务器启用了 `innodb_rollback_on_timeout`。应用捕获 `1205` 后若误以为整个事务已经消失，可能带着之前成功的修改继续执行，造成更难理解的部分结果。

工程上更稳妥的做法，是把一组相关修改封装成可整体重跑的事务函数。捕获 `1213` 或按团队策略处理 `1205` 后，先明确回滚当前连接状态，再用有限次数与随机退避重试完整业务单元。事务内的外部副作用需要幂等，不能让数据库重试重复发送短信、扣外部余额或发布不可撤销请求。

## 十一、怎样从监控信息还原一次锁冲突

线上出现阻塞时，至少要读懂三类信息。

`performance_schema.data_locks` 展示已经持有和正在申请的数据锁。重点字段包括事务 ID、表名、索引名、`LOCK_TYPE`、`LOCK_MODE`、`LOCK_STATUS` 和 `LOCK_DATA`。例如 `X,REC_NOT_GAP` 指向 X Record Lock，带 `GAP` 的模式说明涉及索引空隙，`WAITING` 表示请求尚未获批。

`performance_schema.data_lock_waits` 把 requesting lock 与 blocking lock 连接起来，可以回答“谁在等谁”。再结合 `information_schema.innodb_trx` 的事务开始时间、状态和当前 SQL，可以找到长时间持锁的事务以及等待链入口。官方文档提醒，这些表展示的是快速变化的瞬时状态，跨表查询期间数据就可能变化，因此不要把缺失或短暂不一致误判成数据库损坏。

```sql
SELECT
    w.REQUESTING_ENGINE_TRANSACTION_ID AS waiting_trx,
    w.BLOCKING_ENGINE_TRANSACTION_ID  AS blocking_trx,
    rl.OBJECT_SCHEMA,
    rl.OBJECT_NAME,
    rl.INDEX_NAME,
    rl.LOCK_MODE,
    rl.LOCK_DATA
FROM performance_schema.data_lock_waits AS w
JOIN performance_schema.data_locks AS rl
  ON rl.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
 AND rl.ENGINE = w.ENGINE;
```

`SHOW ENGINE INNODB STATUS` 的 `LATEST DETECTED DEADLOCK` 保存最近一次 InnoDB 用户事务死锁，包含参与事务、持有锁、等待锁和最终回滚对象。若死锁频繁且需要持续取证，可以临时启用 `innodb_print_all_deadlocks` 把每次死锁写入错误日志；取证结束后应关闭，避免长期制造不必要日志。

分析顺序应该是：先找到访问的索引，再把 `LOCK_DATA` 放回索引顺序，最后重建各事务的加锁先后。只截取报错 SQL 通常不够，因为形成环的第一把锁可能来自事务更早执行的另一条语句。

## 十二、减少死锁要缩小范围并统一顺序

死锁无法靠一个参数彻底消除。数据库允许并发事务逐步取得多把锁，就始终可能遇到特定交错。设计目标是减少不必要的锁和冲突顺序，并让应用能够恢复。

### 让所有路径使用一致的资源顺序

转账同时涉及两个账户时，统一按较小账户 ID 先锁、较大 ID 后锁：

```sql
SELECT id, balance
FROM account
WHERE id IN (?, ?)
ORDER BY id
FOR UPDATE;
```

如果所有入口都遵守同一顺序，两个事务会在第一把锁上排队，不再一个拿左边、一个拿右边。统一顺序需要覆盖所有写路径，包括后台任务、补偿逻辑和管理脚本；只修改主链路不足以消除反向路径。

### 用索引缩短扫描和持锁集合

为锁定读与写语句提供匹配的索引，能让 InnoDB 更快到达目标，并少扫描、少锁记录。联合索引应同时考虑等值前缀、范围条件和排序需求。多余索引会增加写入维护与唯一性检查的锁点，核心事务需要的是一条短而稳定的访问路径。

### 缩短事务，不在持锁期间等待外部系统

锁通常在事务提交或回滚时释放。事务中间等待 RPC、人工输入、消息发送或大批量计算，会把原本毫秒级的冲突窗口扩大到秒级。先准备好数据库外的数据，再开启事务完成必要读写；需要可靠发布消息时，可以在本地事务内写 Outbox，由事务外组件发送。

### 选择符合业务语义的读取方式

只需要快照数据的查询不要随意加 `FOR UPDATE`。任务领取等确实需要排他的操作，可以使用锁定读并把事务做短；高并发队列可评估 `SKIP LOCKED`。切换到 RC 能减少部分 Gap Lock，但会改变 Read View 与范围锁语义，应按整个业务事务评估，不能把它当作通用死锁开关。

## 十三、几个容易混淆的判断

| 说法 | 更准确的判断 |
| --- | --- |
| “只返回一行，所以只锁一行” | 锁范围取决于执行计划和扫描的索引区间 |
| “有主键就一定只有 Record Lock” | 只有完整唯一等值搜索等条件下才通常如此 |
| “Gap Lock 是把一段范围独占” | 它只禁止插入，同一 Gap 上的 Gap Lock 可以共存 |
| “Next-Key Lock 锁当前记录后面的区间” | 它组合当前记录与该记录前面的 Gap，区间通常左开右闭 |
| “IX 表示整张表被排他锁住” | IX 表示事务准备在表内取得行级 X 锁 |
| “RC 没有 Gap Lock” | 搜索扫描中大多关闭，外键与重复键检查等仍可能使用 |
| “死锁说明数据库坏了” | 死锁是并发交错形成的等待环，应用必须准备重试 |
| “超时后事务一定全部回滚” | 锁等待超时默认只回滚当前语句，死锁回滚整个事务 |

Record Lock 保护已有索引记录，Gap Lock 禁止在索引空隙插入，Next-Key Lock 把记录与前方 Gap 组合成稳定范围。SQL 最终采用哪一种，不由返回行数单独决定，而由索引结构、访问路径、搜索条件和隔离级别共同决定。

排查锁问题时，先把 `WHERE` 条件翻译成实际扫描的索引区间，再看事务取得锁的顺序。这个视角能同时解释范围更新为什么挡住插入、缺少索引为什么扩大冲突，以及两条看似无关的 SQL 怎样形成死锁。

## 参考资料

- [MySQL 8.4：InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)
- [MySQL 8.4：Locks Set by Different SQL Statements](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)
- [MySQL 8.4：Phantom Rows](https://dev.mysql.com/doc/refman/8.4/en/innodb-next-key-locking.html)
- [MySQL 8.4：Deadlocks in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html)
- [MySQL 8.4：Deadlock Detection](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlock-detection.html)
- [MySQL 8.4：How to Minimize and Handle Deadlocks](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html)
- [MySQL 8.4：InnoDB Error Handling](https://dev.mysql.com/doc/refman/8.4/en/innodb-error-handling.html)
- [MySQL 8.4：The data_locks Table](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html)
- [MySQL 8.4：The data_lock_waits Table](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-lock-waits-table.html)
