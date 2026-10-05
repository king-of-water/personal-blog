---
title: 一条 SQL 是怎样执行的：优化器、执行计划与 EXPLAIN ANALYZE
description: 从解析、重写、代价估算到迭代器执行，讲清 MySQL 如何选择访问路径，以及怎样用 EXPLAIN ANALYZE 判断慢在扫描、连接、排序还是错误估算。
category: 后端
subcategory: MySQL
articleClass: focused
seriesOrder: 50
featured: true
publishedAt: 2026-07-01T20:40:00+08:00
updatedAt: 2026-07-01T20:40:00+08:00
tags: [MySQL, SQL 优化, 查询优化器, EXPLAIN, EXPLAIN ANALYZE, 执行计划]
---

同一条 SQL 可以有很多种执行方法。按索引读取还是扫描全表，先查订单还是先查明细，连接时逐行探测还是建立哈希表，排序是在索引中自然完成还是额外做一次 filesort，都会改变查询需要访问的数据量。

开发者提交的是“想要什么”，MySQL 要把它转换成“怎样得到”。转换结果就是执行计划。读懂执行计划的目标也不是背 `type` 从 `const` 到 `ALL` 的等级表，而是回答三个问题：数据从哪里进入执行树，中间每一步处理了多少行，优化器的估算与真实执行相差多少。

本文讨论 MySQL 8.4 的查询优化与执行。示例数字用于解释计划字段，不代表通用性能结论；具体系统仍要以相同数据分布和参数下的执行结果为准。

## 一、SQL 从连接到结果经历了什么

客户端通过 MySQL 协议发送 SQL 后，服务端先完成权限、语法和语义检查，再进入优化与执行。可以把主路径压缩成五段：

1. 解析器把文本转换成语法树，识别表、列、表达式和子查询。
2. 预处理阶段解析对象名称、检查列是否存在与是否歧义，并完成相应权限检查。
3. 优化器做等价改写，枚举访问路径、连接顺序和连接算法，再根据统计信息与代价模型选择一个计划。
4. 执行器按计划驱动一棵迭代器树，从子节点逐批或逐行获取数据。
5. 存储引擎完成索引定位、记录读取和可见性判断，结果经过过滤、连接、聚合、排序后返回客户端。

![一条查询从 SQL 文本到结果集的处理链路](/images/posts/mysql-sql-execution-pipeline.svg)

这张图里最容易混淆的是“优化器”和“存储引擎”。优化器决定使用哪条索引、表的连接顺序和算子的组合；InnoDB 根据执行器发出的访问请求读取 B+ 树页与记录。优化器不会提前把全部数据读一遍再比较方案，它使用统计信息估算每个候选方案的行数与代价。

SQL 的书写顺序也不是执行顺序。下面的查询虽然先写 `orders`，优化器仍可以先处理另一个数据集；`WHERE`、连接和聚合条件也可能被下推或改写：

```sql
SELECT o.user_id,
       SUM(oi.quantity * oi.unit_price) AS paid_amount
FROM orders AS o
JOIN order_items AS oi ON oi.order_id = o.id
WHERE o.tenant_id = 42
  AND o.status = 'PAID'
  AND o.created_at >= CURRENT_DATE - INTERVAL 7 DAY
GROUP BY o.user_id
ORDER BY paid_amount DESC
LIMIT 20;
```

业务问题很清楚：找出租户 `42` 最近七天支付金额最高的 20 个用户。执行代价却取决于数据分布。这个租户有多少订单，`PAID` 占比多大，七天范围能过滤掉多少数据，每个订单平均有多少明细，都可能让最优计划发生变化。

## 二、优化器做两类工作：等价改写与代价选择

优化器首先尝试在不改变查询语义的前提下简化表达式。常见动作包括常量传播、恒真恒假条件消除、外连接简化、子查询转换，以及把可以更早判断的条件推向数据源。改写减少候选计划的复杂度，也让索引条件变得可识别。

随后进入访问路径选择。对单表，候选方案可能是主键点查、二级索引范围扫描、索引合并、全索引扫描或全表扫描。对多表查询，还要决定连接顺序和每一步的连接算法。同样三张表，`A -> B -> C` 与 `C -> A -> B` 读取的行数可能相差几个数量级。

[MySQL 查询计划文档](https://dev.mysql.com/doc/refman/8.4/en/execution-plan-information.html)把执行计划定义为优化器选择的一组操作。所谓“代价最小”指估算值最小，不是运行前已经知道真实耗时。优化器大致计算以下成本：

- 读取多少数据页和索引页；
- 需要检查、比较和复制多少行；
- 内层访问会被外层循环调用多少次；
- 是否需要构建临时表、排序或哈希结构；
- 随机读取与顺序读取在当前代价模型中的相对价格。

MySQL 的[代价模型](https://dev.mysql.com/doc/refman/8.4/en/cost-model.html)包含服务层的 `server_cost` 和存储引擎层的 `engine_cost`。其中的 cost 是用来比较候选计划的抽象单位，不能直接换算成毫秒。`cost=100` 也不表示一定比 `cost=50` 慢一倍，尤其当缓存状态、并发争用或临时文件落盘没有被估算准确时。

### 优化器为什么可能放弃索引

“有索引却不走”并不必然是优化器出错。若条件会命中表中大部分行，二级索引路径需要先扫描索引，再按主键反复回表读取完整记录。全表扫描虽然读取更多字段，却可能采用更连续的访问方式，总代价反而较低。

对于 `SELECT * FROM orders WHERE status='PAID'`，若绝大多数订单都是已支付状态，单列 `status` 索引的区分度很低。走索引意味着读取大量二级索引条目和聚簇索引记录。只有少量订单为 `PAID` 时，这条索引才更可能缩小扫描范围。

索引能否提供查询所需的顺序也会进入选择。一个访问路径读取的行数稍多，却可以直接满足 `ORDER BY ... LIMIT 20`，它可能比“过滤更强但需要排序”的路径便宜。因此不能脱离查询的过滤、连接、排序和返回列，仅凭某一列有索引就指定它。

## 三、统计信息决定优化器眼里的数据

代价计算的起点是基数与选择性。基数描述列或索引前缀大致有多少个不同值；选择性描述谓词能保留多大比例的数据。`tenant_id=42` 若只留下万分之一记录，适合作为访问入口；若所有记录都属于同一租户，它几乎没有过滤能力。

InnoDB 会维护索引统计信息。`ANALYZE TABLE` 可以更新表统计；MySQL 还支持列直方图，通过 `ANALYZE TABLE ... UPDATE HISTOGRAM` 维护。[官方优化器统计文档](https://dev.mysql.com/doc/refman/8.4/en/optimizer-statistics.html)说明，直方图记录列值的分布，主要帮助没有索引的列估算常量谓词的过滤比例。

```sql
ANALYZE TABLE orders;

ANALYZE TABLE orders
  UPDATE HISTOGRAM ON status, tenant_id
  WITH 128 BUCKETS;

SELECT schema_name, table_name, column_name, histogram
FROM information_schema.column_statistics
WHERE schema_name = DATABASE()
  AND table_name = 'orders';
```

直方图不会自动消除所有误差。几个常见边界需要单独认识。

第一，数据可能倾斜。全局上 `PAID` 占 70%，新接入租户却只有 5%。只看单列分布时，优化器可能把全局比例套到 `tenant_id=42 AND status='PAID'` 上。

第二，多列之间存在相关性。订单状态、创建时间和租户往往不是相互独立的。若估算时近似把几个选择率相乘，相关性会把误差逐层放大。

第三，统计会过期。一次大批量导入、归档或状态迁移改变了分布，持久统计和直方图仍可能描述旧数据。此时同一条 SQL 会出现 `estimated rows` 与 `actual rows` 明显偏离。

第四，参数值不同。一个租户只有几百条订单，另一个租户有几亿条。用前者观察到的好计划不能直接证明后者也合适。排查时必须保留慢请求的真实参数和时间范围。

统计误差在连接中尤其昂贵。外层预估 10 行、实际 10 万行时，内层迭代器可能被调用 10 万次。单次内层查询只花 0.1 毫秒，总时间也会达到 10 秒左右。`EXPLAIN ANALYZE` 的价值就在这里，它把估算和实际执行放到同一棵树上。

## 四、先把执行计划看成一棵迭代器树

MySQL 8 的执行器使用迭代器模型描述计划节点。叶子节点负责扫描表或索引，上层节点消费子节点的输出，再执行过滤、连接、聚合、排序和限制。最顶层节点产出客户端最终看到的结果。

执行时，父节点向子节点请求下一行。以 Nested-Loop Join 为例，外层每产生一行，内层就按连接键执行一次查找。伪代码可以写成：

```text
for each order from orders_access:
    for each item from order_items where item.order_id = order.id:
        aggregate(order.user_id, item.quantity * item.unit_price)
sort aggregates by paid_amount desc
return first 20 rows
```

[MySQL 的 Nested-Loop Join 文档](https://dev.mysql.com/doc/refman/8.4/en/nested-loop-joins.html)也用相同的多层循环解释连接。内表访问是否便宜，不能只看“一次主键查询很快”，还要乘以外层实际行数。

对于没有可用连接索引的等值连接，MySQL 8.4 也可能采用 Hash Join。执行器先读取一侧建立哈希表，再扫描另一侧并按连接键探测。[Hash Join 文档](https://dev.mysql.com/doc/refman/8.4/en/hash-joins.html)说明了适用条件，`EXPLAIN FORMAT=TREE` 和 `EXPLAIN ANALYZE` 会直接显示 `Hash` 与 `Inner hash join` 节点。

选择 Nested Loop 还是 Hash Join，取决于输入规模、可用索引、谓词类型与代价估算。Nested Loop 配合高选择性的索引点查很有效；两侧都要大量扫描且使用等值条件时，Hash Join 可以避免内表被反复遍历。看到连接慢时，先看输入行数和访问方式，再讨论算法名称。

### `EXPLAIN FORMAT=TREE` 为什么更接近真实执行

传统表格把计划压成多行字段，适合快速查看索引访问，却不容易表达节点的父子关系。`FORMAT=TREE` 直接展示迭代器树：缩进更深的是子节点，执行阅读通常从最深的叶子向上。

```sql
EXPLAIN FORMAT=TREE
SELECT o.user_id,
       SUM(oi.quantity * oi.unit_price) AS paid_amount
FROM orders AS o
JOIN order_items AS oi ON oi.order_id = o.id
WHERE o.tenant_id = 42
  AND o.status = 'PAID'
  AND o.created_at >= CURRENT_DATE - INTERVAL 7 DAY
GROUP BY o.user_id
ORDER BY paid_amount DESC
LIMIT 20;
```

一个简化后的计划可能是：

```text
-> Limit: 20 row(s)
    -> Sort: paid_amount DESC, limit input to 20 row(s) per chunk
        -> Group aggregate: sum((oi.quantity * oi.unit_price))
            -> Nested loop inner join
                -> Index range scan on o using idx_tenant_status_created
                -> Index lookup on oi using idx_order_id (order_id=o.id)
```

阅读时从 `orders` 的范围扫描开始。它每产出一个订单，`order_items` 的索引查找就执行一次；连接结果进入聚合，按 `user_id` 累加，最后排序并截取 20 行。树形结构直接暴露了倍数关系。

![EXPLAIN ANALYZE 中外层行数怎样放大内层 loops](/images/posts/mysql-explain-analyze-iterator-tree.svg)

## 五、传统 EXPLAIN 每一列到底回答什么

默认 `EXPLAIN` 使用表格格式。它没有执行查询，而是展示优化器准备采用的计划。对于简单单表 SQL，它足够快速；多层子查询、Hash Join 或复杂算子更适合看 TREE 或 JSON。

```sql
EXPLAIN
SELECT *
FROM orders
WHERE tenant_id = 42
  AND status = 'PAID'
  AND created_at >= '2026-09-28';
```

需要重点看的字段可以按问题分组。

| 字段 | 回答的问题 | 常见误区 |
| --- | --- | --- |
| `table` | 当前访问哪个表、派生表或子查询 | 同一张物理表可能出现多次 |
| `type` | 使用哪类访问方法 | 不能只按口诀给整条 SQL 打分 |
| `possible_keys` | 哪些索引理论上可选 | 出现在这里不代表一定适合 |
| `key` | 优化器最终选了哪条索引 | `NULL` 也可能是合理的全表扫描 |
| `key_len` | 实际用于访问的索引键长度 | 不是索引文件大小，也不总等于用了几列 |
| `ref` | 哪个常量或列与索引键比较 | 可帮助识别连接输入 |
| `rows` | 预计需要检查或读取的行数 | 是估算，不是返回行数 |
| `filtered` | 当前条件预计保留的百分比 | 与 `rows` 结合才有意义 |
| `Extra` | 排序、临时表、覆盖索引、ICP 等补充行为 | `Using filesort` 不代表一定落盘 |

### `type` 是访问方式，不是性能成绩单

常见访问类型包括：

- `const`：通过主键或唯一索引等值条件，结果最多一行；
- `eq_ref`：连接时，外表每一行在内表最多匹配一行，常见于完整唯一键；
- `ref`：使用非唯一索引或唯一索引前缀，可能返回多行；
- `range`：扫描一个或多个索引区间；
- `index`：扫描整棵索引；
- `ALL`：扫描整张表。

这个顺序能帮助初步识别访问范围，却不能脱离行数判断。扫描一张只有 20 行的配置表通常没问题；对一亿行表做 `ref` 查询，如果一个低区分度键命中五千万行，仍然很慢。`range` 也可能只扫 10 行，也可能扫全表的 80%。

`rows * filtered / 100` 可以粗略理解为该节点预计向上游交付的行数。若 `rows=100000`、`filtered=1`，优化器预计检查十万行后保留约一千行。它仍是近似值，多表计划中误差会沿连接顺序继续传播。

### `key_len` 能说明联合索引用到了哪里吗

`key_len` 表示优化器用于访问的索引键最大字节长度，会受数据类型、字符集、是否允许 `NULL` 等因素影响。它有助于判断联合索引使用了哪些部分，但不宜用字节数机械反推。

更直接的方法是结合 `key`、`ref`、TREE 中的索引条件和 `EXPLAIN FORMAT=JSON` 的字段一起判断。联合索引 `(tenant_id, status, created_at, id)` 遇到前两列等值、第三列范围时，通常能把前三列用于确定扫描区间；范围列之后的 `id` 一般不能继续缩小同一次 B+ 树范围，但可能用于覆盖、过滤或排序。

## 六、Extra 中几个高频提示怎样理解

`Extra` 把无法放入固定列的执行信息集中在一起。它很有用，也最容易被口诀化。

### `Using index` 与 `Using index condition`

`Using index` 通常表示覆盖索引：查询需要的列都能从索引条目中取得，无需再读取完整聚簇索引记录。覆盖减少回表，但仍要看扫描多少索引条目。全索引扫描一千万条，即使全程不回表也可能很贵。

`Using index condition` 表示使用 Index Condition Pushdown（ICP）。[官方 ICP 文档](https://dev.mysql.com/doc/refman/8.4/en/index-condition-pushdown-optimization.html)说明，存储引擎先用二级索引条目判断可下推的条件，满足后才读取完整行。这能减少回表次数，但查询仍然需要完整行，所以它和覆盖索引不是同一件事。

例如索引是 `(tenant_id, status, created_at)`，查询还需要 `amount`。若访问区间只能由 `tenant_id` 确定，`status` 与 `created_at` 的部分条件仍可能在索引层过滤。未通过条件的索引条目无需按主键回表，`amount` 则只能在通过后读取。

### `Using filesort`

当索引顺序不能直接满足 `ORDER BY`，MySQL 要执行额外排序，传统计划显示 `Using filesort`。[ORDER BY 优化文档](https://dev.mysql.com/doc/refman/8.4/en/order-by-optimization.html)指出，filesort 是执行阶段的一次排序；数据太大无法放入内存时才需要临时磁盘文件。

所以 filesort 不等于“必然磁盘排序”，也不等于“查询一定很慢”。对过滤后几十行数据排序通常很便宜。还要继续看送入排序节点多少行、单行多宽、是否有 `LIMIT`、内存是否足够，以及排序前能否更早过滤。

为了消掉 filesort 强行新建索引也不总划算。新索引会增加写放大和存储空间，而且为了满足排序选择一个过滤较弱的索引，可能让前面的扫描成本更高。需要比较整棵计划，不要只消除一个 Extra 文案。

### `Using temporary`

聚合、去重、部分子查询和无法流式完成的中间结果可能使用内部临时表。临时表不等于必然写磁盘；MySQL 会根据数据类型、结果大小和配置选择内存或磁盘路径。

仍以 Top 用户查询为例，按 `user_id` 聚合后再按计算出的 `paid_amount` 排序，很难直接由原表索引提供最终顺序。执行器需要维护分组结果，再排序取前 20。优化重点往往是减少进入聚合的订单和明细，而不是要求计划中完全没有临时结构。

## 七、EXPLAIN ANALYZE 把估算与实际放在一起

普通 `EXPLAIN` 不执行查询，因此看不到实际行数和耗时。`EXPLAIN ANALYZE` 会真的运行语句，并用 TREE 格式输出每个迭代器的估算与实测信息。[MySQL 8.4 的 EXPLAIN 文档](https://dev.mysql.com/doc/refman/8.4/en/explain.html)列出以下字段：estimated cost、estimated rows、返回首行时间、返回全部行时间、actual rows 和 loops。

```sql
EXPLAIN ANALYZE
SELECT o.user_id,
       SUM(oi.quantity * oi.unit_price) AS paid_amount
FROM orders AS o
JOIN order_items AS oi ON oi.order_id = o.id
WHERE o.tenant_id = 42
  AND o.status = 'PAID'
  AND o.created_at >= CURRENT_DATE - INTERVAL 7 DAY
GROUP BY o.user_id
ORDER BY paid_amount DESC
LIMIT 20;
```

下面是一段为讲解压缩过的输出：

```text
-> Limit: 20 row(s)  (cost=1840 rows=20)
   (actual time=842..842 rows=20 loops=1)
    -> Sort: paid_amount DESC, limit input to 20 row(s)
       (actual time=842..842 rows=20 loops=1)
        -> Group aggregate: sum((oi.quantity * oi.unit_price))
           (actual time=0.21..836 rows=18420 loops=1)
            -> Nested loop inner join  (cost=1320 rows=9600)
               (actual time=0.09..691 rows=236000 loops=1)
                -> Index range scan on o using idx_tenant_status_created
                   (cost=310 rows=3200)
                   (actual time=0.06..78 rows=59000 loops=1)
                -> Index lookup on oi using idx_order_id (order_id=o.id)
                   (cost=0.25 rows=3)
                   (actual time=0.004..0.009 rows=4 loops=59000)
```

先看 `orders` 节点。优化器预计读 3,200 行，实际读到 59,000 行，差了约 18 倍。这个偏差传到 Nested Loop 后，`order_items` 的索引查找执行了 59,000 次。内层平均每次只需约 0.009 毫秒，但调用次数太多，连接阶段仍然占据大量时间。

连接节点预计输出 9,600 行，实际输出 236,000 行。聚合必须处理这些明细，最终才收敛成 18,420 个用户。Top 20 排序本身只在约 1.8 万个分组上进行，它并非首要矛盾。若只看到传统 `Extra` 的 `Using temporary; Using filesort`，很容易把优化方向放错。

### `actual time=a..b rows=n loops=m` 怎样读

`a` 是该迭代器平均每次循环返回第一行所需的时间，`b` 是平均每次循环读完全部行所需的时间，单位为毫秒。`rows` 是每次循环平均返回行数，`loops` 是迭代器被初始化并执行的次数。

内层节点的 `actual time=0.004..0.009 rows=4 loops=59000` 表示一次订单明细查找平均约返回 4 行，执行了 59,000 次。估算该节点的累计工作量时，可以观察 `b * loops`，但不能把所有节点的这个数直接相加。父节点时间包含从子节点取数的时间，节点之间存在包含关系，简单求和会重复计算。

若一个节点 `loops=0`，说明上游没有向它请求数据，常见于前一个条件已返回空集或执行发生短路。若 `rows=0` 且耗时很高，可能是在扫描或构建过程中没有产出结果，不能把“返回零行”理解为“没有做工作”。

### 为什么首行时间和全部行时间要分开

索引点查、过滤和 Nested Loop 往往可以边读边返回，首行时间较短。完整排序、某些聚合与 Hash Join 的构建阶段需要先消费大量输入，产生首行前已经完成许多工作。这类算子称为 blocking operator（阻塞算子）。

接口只取少量结果时，首行延迟影响流式响应；批处理必须读完整结果时，全部行时间更重要。`LIMIT 20` 也不能保证首行一定快，若它位于排序或聚合之上，底层仍可能先处理全部候选数据。

## 八、用估算偏差定位计划为什么选错

分析 `EXPLAIN ANALYZE` 时，可以沿执行树按下面顺序检查。

先找第一个出现数量级偏差的叶子或中间节点。如果最底层范围扫描已经从预计 3,200 行变成实际 59,000 行，后面连接与聚合的膨胀很可能只是结果。此时应检查索引前缀、数据分布、统计信息和参数值。

再看 `loops`。一个耗时很低的内层节点可能被调用几十万次。优化方案可能是缩小外层结果、为内层增加合适索引、调整连接顺序，或者让优化器在大输入下选择 Hash Join。只盯单次耗时会漏掉乘法效应。

然后看行数在哪里大幅增长或收缩。连接从 59,000 个订单扩张到 236,000 条明细属于合理的一对多扩张；如果实际平均每单 40 条而优化器估计 3 条，就需要重新审视分布。过滤节点输入百万行只输出几十行，通常说明条件执行得太晚，或者缺少能把它转成访问范围的索引。

最后检查阻塞算子。排序、聚合、物化或 Hash 构建前收到多少行，决定它们需要的内存与时间。优化通常优先减少它们的输入，而不是把 `sort_buffer_size` 当成第一选择。

这套顺序比“看到 `ALL` 就加索引、看到 filesort 就改排序”可靠，因为它保留了执行树中的因果关系。

## 九、联合索引怎样改变这条查询

假设 `orders` 原先只有：

```sql
KEY idx_tenant (tenant_id),
KEY idx_status (status),
KEY idx_created (created_at)
```

单列索引通常只能为一次访问提供一个主要范围。优化器也可能选择 Index Merge，但多个单列索引的结果合并不等同于一条顺序良好的联合索引。对于固定查询模式，更合适的候选是：

```sql
KEY idx_tenant_status_created
    (tenant_id, status, created_at, id, user_id)
```

前两列是等值条件，`created_at` 是范围条件，能够形成连续的索引区间；`id` 支持连接到 `order_items`，`user_id` 供后续分组使用。是否保留后两列要看索引宽度、回表成本、写入压力和真实查询频率，不应为了覆盖一条低频查询无限扩张索引。

`order_items` 至少需要：

```sql
KEY idx_order_id (order_id)
```

若希望减少查询明细金额时的回表，可评估 `(order_id, quantity, unit_price)`。代价是二级索引更宽，每次插入和更新都要维护更多字节。金额字段是否经常变化也会影响取舍。

加索引后仍需再次观察执行计划。预期变化包括：`orders` 访问从单列索引后大量过滤变为联合索引范围扫描，扫描行数下降；`order_items` 保持按订单 ID 查找；进入聚合和排序的行数取决于业务数据，不会因为索引凭空消失。

有时最有效的改动在 SQL 或数据模型。若这个 Top 用户统计每次都要扫描大量订单明细，且被高频调用，可以按天、租户和用户维护汇总表。索引优化减少读取浪费，预聚合则改变每次请求必须处理的数据规模。两者解决的层次不同。

## 十、优化器提示应该放在最后

MySQL 提供 Index Hint、Optimizer Hint、`optimizer_switch` 和可配置代价模型。这些工具可以验证假设或临时规避计划回退，但强制计划会把当前数据分布下的判断写死。

```sql
SELECT /*+ JOIN_ORDER(o, oi) */
       o.user_id,
       SUM(oi.quantity * oi.unit_price) AS paid_amount
FROM orders AS o FORCE INDEX (idx_tenant_status_created)
JOIN order_items AS oi ON oi.order_id = o.id
WHERE ...
GROUP BY o.user_id;
```

上线这类 Hint 前至少要回答：

- 当前计划差是统计信息错误、索引缺失，还是代价模型不适合这类负载？
- 强制索引对大租户和小租户是否都成立？
- 数据增长、冷热变化或索引调整后，谁负责重新验证？
- 新版本优化器已经能选择更好方案时，Hint 会不会阻止升级收益？

更稳妥的处理顺序通常是确认 SQL 语义与参数，更新并检查统计信息，补充与查询模式一致的索引，再比较改动前后的实际计划。Hint 适合有明确证据、回滚方案和持续监控的场景。

当 `EXPLAIN` 只能告诉你“选了什么”，却无法解释“为什么没选另一个索引”时，可以短时间启用 Optimizer Trace：

```sql
SET optimizer_trace = 'enabled=on';

SELECT ...;

SELECT trace
FROM information_schema.optimizer_trace\G

SET optimizer_trace = 'enabled=off';
```

[Optimizer Trace 文档](https://dev.mysql.com/doc/refman/8.4/en/optimizer-tracing.html)说明，trace 会记录优化过程中的候选路径、估算和拒绝原因。它只跟踪当前会话，输出可能很大，更适合针对单条 SQL 做深入诊断，不适合作为常驻监控。

## 十一、EXPLAIN ANALYZE 也有使用边界

`EXPLAIN ANALYZE` 会实际执行语句。对大查询，它会真的读取、连接、聚合和排序，消耗与原查询相近的资源。不要在生产高峰对未知代价的 SQL 随意运行。

它支持 `SELECT`、多表 `UPDATE`、`DELETE` 和 `TABLE` 等文档列出的语句，但对修改语句必须格外谨慎，因为“分析”并不代表没有副作用。线上优先使用只读副本、脱敏后的近似数据环境，或者先用普通 `EXPLAIN` 判断访问规模。

一次执行也不等于稳定结论。Buffer Pool 是否已缓存相关页、并发事务是否争用 CPU 与 I/O、临时表是否落盘、网络与客户端取数方式，都可能改变耗时。`EXPLAIN ANALYZE` 的实际行数通常比单次毫秒值更容易迁移到其他时刻，因为它揭示了计划处理的数据规模。

另外，节点时间包含子节点时间，不能用它精确拆分每个算子的独占 CPU。它最适合识别错误估算、循环放大、过量扫描和阻塞节点；需要分析长期分位延迟、等待事件与资源瓶颈时，还要结合 Performance Schema、慢查询日志和系统指标。下一篇会单独讨论这条线上排查链路。

## 十二、形成一套稳定的读计划顺序

拿到一条执行计划后，可以固定按以下顺序阅读：

1. 确认 SQL 的业务目标、真实参数和结果规模，避免优化错查询。
2. 从 TREE 最深的叶子开始，看数据从哪张表、哪条索引进入。
3. 比较每个节点的 estimated rows 与 actual rows，找到最早的明显偏差。
4. 同时读取 `rows` 和 `loops`，判断内层工作被放大多少次。
5. 沿树向上检查过滤、连接、聚合、排序和 LIMIT 前后的行数变化。
6. 区分访问问题与计算问题，再决定改索引、改 SQL、更新统计还是调整数据模型。
7. 用相同参数和近似缓存状态复查实际计划，并观察其他租户和边界参数是否退化。

这套方法的重点是数量。`type=range`、`Using filesort`、`Using temporary` 都只是计划特征；扫描多少行、过滤后留下多少行、循环多少次，才决定一条 SQL 实际做了多少工作。

## 参考资料

- [MySQL 8.4：Understanding the Query Execution Plan](https://dev.mysql.com/doc/refman/8.4/en/execution-plan-information.html)
- [MySQL 8.4：Optimizing Queries with EXPLAIN](https://dev.mysql.com/doc/refman/8.4/en/using-explain.html)
- [MySQL 8.4：EXPLAIN Statement](https://dev.mysql.com/doc/refman/8.4/en/explain.html)
- [MySQL 8.4：Nested-Loop Join Algorithms](https://dev.mysql.com/doc/refman/8.4/en/nested-loop-joins.html)
- [MySQL 8.4：Hash Join Optimization](https://dev.mysql.com/doc/refman/8.4/en/hash-joins.html)
- [MySQL 8.4：Index Condition Pushdown](https://dev.mysql.com/doc/refman/8.4/en/index-condition-pushdown-optimization.html)
- [MySQL 8.4：ORDER BY Optimization](https://dev.mysql.com/doc/refman/8.4/en/order-by-optimization.html)
- [MySQL 8.4：The Optimizer Cost Model](https://dev.mysql.com/doc/refman/8.4/en/cost-model.html)
- [MySQL 8.4：Optimizer Statistics](https://dev.mysql.com/doc/refman/8.4/en/optimizer-statistics.html)
- [MySQL 8.4：Tracing the Optimizer](https://dev.mysql.com/doc/refman/8.4/en/optimizer-tracing.html)
