---
title: MySQL 联合索引为什么遵循最左匹配：从 B+ 树的排序规则讲起
description: 从一次联合索引面试题出发，拆解 InnoDB B+ 树、(a,b,c) 的字典序、范围扫描、ICP、排序与索引设计。
category: 后端
subcategory: MySQL
articleClass: focused
seriesOrder: 10
featured: true
publishedAt: 2026-10-04
tags: [MySQL, InnoDB, B+ 树, 联合索引, 最左匹配, EXPLAIN]
---

有一道很常见的 MySQL 面试题：表上存在联合索引 `idx_abc(a, b, c)`，下面哪些查询能够使用它？

```sql
SELECT * FROM t WHERE a = 1;
SELECT * FROM t WHERE a = 1 AND b = 2;
SELECT * FROM t WHERE b = 2;
SELECT * FROM t WHERE a = 1 AND c = 3;
SELECT * FROM t WHERE a > 1 AND b = 2;
SELECT * FROM t WHERE a = 1 ORDER BY b, c;
```

背过“最左匹配”的人通常能答对前两行，却很容易在后四行上含糊：`c` 算不算用到索引，范围条件后面的 `b` 是否彻底失效，`ORDER BY` 为什么也受相同规则约束，MySQL 8 的 Skip Scan 又算不算例外。

这些问题都落在一个基础事实上：`(a,b,c)` 是一个复合排序键。索引先按 `a` 排，`a` 相同时再按 `b` 排，`a、b` 都相同时才按 `c` 排。看懂这个顺序之后，最左匹配可以直接推导出来。

本文围绕这一条因果链展开：InnoDB 为什么采用面向页的 B+ 树，联合索引的记录如何排列，查询条件怎样被转换成连续的索引区间，以及如何根据真实查询设计列顺序。全文讨论普通 InnoDB B-tree 索引，不覆盖全文索引、空间索引和多值索引。

## 一、先给出判断框架

分析一个联合索引查询时，不要只问“是否走索引”。这个说法把几件不同的事情混在了一起。更有用的是连续问四个问题：

1. MySQL 能否根据条件在 B+ 树中确定扫描起点和终点？
2. 扫描过程中还有哪些条件能直接读取索引记录完成过滤？
3. 返回结果是否需要回到聚簇索引读取完整行？
4. 索引本身的顺序能否满足 `ORDER BY` 或 `GROUP BY`？

对 `idx_abc(a,b,c)`，开头六个查询可以先得到下面这张简表：

| 条件 | 用于确定扫描区间的部分 | 仍可能在索引层过滤 | 关键原因 |
| --- | --- | --- | --- |
| `a = 1` | `a` | 无 | 所有 `a=1` 的记录连续 |
| `a = 1 AND b = 2` | `a,b` | 无 | 固定 `a` 后，`b` 局部有序 |
| `b = 2` | 通常没有 | `b` | 全局的 `b=2` 分散在不同 `a` 下 |
| `a = 1 AND c = 3` | `a` | `c` | 缺少 `b`，同一 `c` 不是连续区间 |
| `a > 1 AND b = 2` | 通常到 `a` 的范围为止 | `b` | `a` 进入范围后，不能形成一个更窄的连续 `(a,b)` 区间 |
| `a = 1 ORDER BY b,c` | `a` | 无 | 固定 `a` 后，叶子记录已经按 `b,c` 排好 |

表里故意使用“用于确定扫描区间”和“索引层过滤”两个说法。前者减少需要扫描的索引记录，后者可能只减少回表次数，收益并不一样。后文会把它们分别对应到 Range Access 和 Index Condition Pushdown。

## 二、索引要解决页面访问成本

红黑树、B 树和 B+ 树的查找都可以写成 `O(log n)`。这个表达式没有反映数据库的主要成本，因为一次页面访问通常比一次整数比较昂贵得多。

InnoDB 默认索引页大小为 16KB。数据库从磁盘或 Buffer Pool 读取的是整页，不是树节点中的某一个整数。[MySQL 8.4 的物理结构文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-physical-structure.html)也明确说明，InnoDB 普通索引采用 B-tree 结构，索引记录位于叶子页中。于是更重要的问题变成：一个页面能保存多少路由信息，需要经过多少页才能走到目标叶子页？

### 红黑树为什么不适合直接充当磁盘索引

红黑树是二叉搜索树，每个节点最多只有两个孩子。即使它保持平衡，千万级记录仍需要较多层级。若把一个逻辑节点对应到一个磁盘页，每下降一层都可能产生一次页面访问，树高会直接进入查询成本。

B+ 树的内部页可以容纳大量键和子页指针，一个页面能分出数百路甚至更多。相同记录量下，树通常只有少数几层。根页和部分内部页又很容易常驻 Buffer Pool，查询经常只需要读取少量页面。

红黑树的问题不在渐进复杂度，而在二叉分支没有充分利用数据库的块设备和页面模型。它很适合内存里的有序集合，直接映射到磁盘页后却会产生更多层级。

### Hash 为什么不能替代 B+ 树

Hash 擅长等值查找，但它没有保存键的全序关系。下面这些能力都依赖有序性：

- `a > 10`、`BETWEEN` 等范围查询；
- 按索引顺序读取结果；
- 找到起点后连续扫描下一条记录；
- 使用键的前缀完成查找；
- 计算 `MIN()`、`MAX()` 或按序分页。

[MySQL 对 B-tree 与 Hash 索引的官方比较](https://dev.mysql.com/doc/refman/8.4/en/index-btree-hash.html)也把边界写得很清楚：B-tree 支持等值、大小比较、范围和不以通配符开头的 `LIKE`；Hash 主要适合完整键上的等值比较。InnoDB 确实存在 Adaptive Hash Index，但它是根据热点访问在内存中自动建立的辅助结构，不会取代持久化的 B-tree 索引。

### B 树与 B+ 树的区别应该讲到什么程度

MySQL 官方文档通常使用宽泛的“B-tree”一词。工程讨论里把 InnoDB 普通索引称为 B+ 树，是在强调两个实现特征：内部层主要负责导航，完整索引记录集中在叶子层；范围扫描到达第一个叶子记录后，可以沿叶子页顺序继续读取。

与把记录分散在内部节点和叶子节点的经典 B 树相比，这样做让内部页能容纳更多路由键，也让范围扫描拥有稳定的顺序入口。没必要纠结名称上的一字之差，真正应该记住的是“高扇出、面向页、数据记录在叶子层、适合顺序扫描”。

![红黑树、Hash 与 B+ 树面对数据库查询时的能力差异](/images/posts/mysql-index-structure-comparison.svg)

## 三、InnoDB 实际上维护了两类树

理解联合索引前，还要先区分聚簇索引和二级索引，否则很容易把“找到索引记录”和“拿到完整数据”当成同一步。

[InnoDB 官方文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html)规定，每张表都有一个聚簇索引。存在主键时，主键通常就是聚簇索引；没有主键时，InnoDB 会选择第一个所有列均为 `NOT NULL` 的唯一索引；再没有合适索引，才生成隐藏的 `GEN_CLUST_INDEX`。

假设有下面这张表：

```sql
CREATE TABLE orders (
    id         BIGINT PRIMARY KEY,
    a          INT NOT NULL,
    b          INT NOT NULL,
    c          INT NOT NULL,
    payload    VARCHAR(200) NOT NULL,
    KEY idx_abc (a, b, c)
) ENGINE = InnoDB;
```

它至少有两棵树：

- 聚簇索引 `PRIMARY(id)` 的叶子记录保存完整行；
- 二级索引 `idx_abc(a,b,c)` 的叶子记录保存 `a、b、c`，同时携带主键 `id`。

执行下面的查询时：

```sql
SELECT payload
FROM orders
WHERE a = 1 AND b = 2 AND c = 3;
```

存储引擎先在 `idx_abc` 中找到匹配记录，取出相应的 `id`，再用 `id` 查询聚簇索引获得 `payload`。第二次查树就是常说的“回表”。如果查询只返回 `a、b、c、id`，二级索引已经包含全部所需列，便可能形成覆盖索引，无需回表。

这也解释了为什么主键不宜无节制地变长：主键值会出现在每一棵二级索引的叶子记录中。主键越宽，所有二级索引都会跟着变大。

![InnoDB 二级索引通过主键回到聚簇索引读取完整行](/images/posts/mysql-secondary-index-lookup.svg)

## 四、从 `(a,b,c)` 的字典序开始

`idx_abc` 只有一棵树，每条索引记录的逻辑键是一个元组。它不会分别为 `a`、`b`、`c` 建三棵树，也不会在查询时临时拼接三个单列索引：

```text
(a, b, c, primary_key)
```

可以把比较过程理解成字典查词：

1. 先比较 `a`，较小的元组排在前面；
2. `a` 相同才比较 `b`；
3. `a、b` 都相同才比较 `c`；
4. 二级索引列全部相同时，再使用主键区分不同记录。

假设索引中有下面这些数据，最终顺序会是：

```text
(1, 1, 1, 101)
(1, 1, 2, 108)
(1, 2, 1, 103)
(1, 2, 3, 106)
(2, 1, 1, 102)
(2, 1, 2, 105)
(2, 2, 1, 109)
(3, 1, 3, 104)
```

从这个序列可以观察到三层有序性：

- 从整棵索引看，`a` 全局有序；
- 固定某个 `a` 后，该组内部的 `b` 有序；
- 同时固定 `a、b` 后，更小的组内 `c` 有序。

反过来，全局的 `b` 并不连续有序。`b=1` 会出现在 `a=1`、`a=2`、`a=3` 的不同区段；全局的 `c` 更是如此。所谓“最左”，指的就是必须先利用左边的列，把查找收缩到一个内部仍然有序的连续区段。

![联合索引 (a,b,c) 先按 a、再按 b、最后按 c 排列](/images/posts/mysql-composite-index-order.svg)

## 五、最左匹配描述怎样构造连续区间

MySQL 的 Range Access 会尝试把查询条件转换成联合键上的一个或多个连续区间。[MySQL 8.4 Range Optimization 文档](https://dev.mysql.com/doc/refman/8.4/en/range-optimization.html)直接用 key tuple interval 描述这一过程，比逐个条件判断“能否使用索引”更准确。

### 只有 `a = 1`

条件可以转换成：

```text
(1, -∞, -∞) <= (a, b, c) < (1, +∞, +∞)
```

存储引擎先沿树下降到第一条 `a=1` 的记录，然后连续向后扫描，直到遇到第一条 `a>1` 的记录。所有目标记录紧挨在一起，因此这是一个清晰的索引区间。

### `a = 1 AND b = 2`

区间进一步缩小：

```text
(1, 2, -∞) <= (a, b, c) < (1, 2, +∞)
```

因为 `a` 已经固定，`b` 在这个局部区间中有序，MySQL 能同时利用两个键部分确定边界。

### 只有 `b = 2`

这次无法写出一个连续区间。索引中可能存在：

```text
(1, 2, ...)
(2, 2, ...)
(3, 2, ...)
```

它们被不同 `a` 值的记录隔开。如果不知道 `a`，常规 range scan 就不知道应该从哪一个位置开始，又在哪一个位置结束。MySQL 可能选择全索引扫描、全表扫描，或者在满足严格条件时选择 Skip Scan，但这不是普通的左前缀查找。

### `a = 1 AND c = 3`

`a=1` 仍然能定义连续区间，`c=3` 却不能越过缺失的 `b` 继续缩小该区间：

```text
(1, 1, 1)
(1, 1, 3)  <- c=3
(1, 2, 1)
(1, 2, 3)  <- c=3
(1, 3, 2)
```

在 `a=1` 的区段里，每换一个 `b`，`c` 都会重新开始排序。因此执行过程通常是先定位并扫描全部 `a=1` 的索引记录，再判断哪些记录满足 `c=3`。如果是二级索引且还需读取完整行，ICP 有机会在回表前完成这次判断。

由此可以给出更准确的表述：查询条件形成联合键左侧连续前缀时，才能持续收紧 B+ 树的扫描边界。

## 六、SQL 的书写顺序不决定最左匹配

下面两条 SQL 在逻辑上等价：

```sql
SELECT * FROM orders WHERE a = 1 AND b = 2;
SELECT * FROM orders WHERE b = 2 AND a = 1;
```

最左匹配约束索引键顺序，`WHERE` 子句中文字出现的顺序不影响它。优化器会分析谓词并构造可用区间，[官方 Range Optimization 文档](https://dev.mysql.com/doc/refman/8.4/en/range-optimization.html)也明确指出，区间提取结果不依赖条件在 `WHERE` 中的排列顺序。

索引定义和谓词语义共同决定可用区间。把 SQL 手工改写成 `a` 在前、`b` 在后，通常只会改善可读性，不会凭空提高索引利用率。

还有一个容易误判的条件是 `IN`：

```sql
WHERE a IN (1, 2) AND b = 5
```

`IN` 可以被视为多个等值区间。优化器可以构造 `(a=1,b=5)` 和 `(a=2,b=5)` 两个范围，并继续利用后面的 `b`。`LIKE 'foo%'` 通常也可以形成字符串范围，`LIKE '%foo'` 因为缺少确定前缀，通常不能形成相同的定位区间。

## 七、范围条件之后的列真的完全失效吗

常见口诀是：“联合索引遇到范围查询，后面的列全部失效。”它适合帮助初学者快速答题，却混淆了“确定扫描边界”和“执行过滤”。

考虑索引 `(a,b,c)` 和查询：

```sql
SELECT payload
FROM orders
WHERE a = 1
  AND b > 10
  AND c = 3;
```

优化器可以用 `a=1 AND b>10` 确定扫描起点。进入 `b>10` 的范围后，不同 `b` 值下面都各自包含一组按 `c` 排列的记录，`c=3` 不能把整个结果再压缩成一个更小的连续区间。官方文档的规则是：多列 B-tree 索引会在 `=`、`<=>`、`IS NULL` 这类条件后继续尝试使用下一个键部分；遇到 `>`、`<`、`BETWEEN`、非前缀式 `LIKE` 等范围操作后，用该列形成边界，但不再用后续键部分继续构造区间。

不过，`c` 不一定毫无作用。开启 Index Condition Pushdown 时，如果 `c` 就在二级索引记录里，存储引擎可以先检查 `c=3`，不满足便跳过回表。[ICP 官方文档](https://dev.mysql.com/doc/refman/8.4/en/index-condition-pushdown-optimization.html)描述的正是这个过程：先读取索引元组，在存储引擎层判断可由索引列完成的条件，只有通过后才读取完整行。

于是应把结论拆成两层：

- `c` 通常不能继续缩小需要扫描的 `(a,b)` 索引区间；
- `c` 可能通过 ICP 减少回表数量。

如果查询本身是覆盖索引，不需要读取完整行，ICP 的“减少回表”价值也就不存在，但条件仍会对扫描出的索引记录进行过滤。

## 八、同一套排序也决定 `ORDER BY`

B+ 树不仅能定位记录，还天然提供顺序。只要查询需要的顺序与可用索引区间中的顺序一致，MySQL 就有机会避免额外排序。

```sql
SELECT a, b, c
FROM orders
WHERE a = 1
ORDER BY b, c;
```

固定 `a=1` 后，剩余记录本来就按 `b` 排，同一个 `b` 内再按 `c` 排。顺序与查询要求完全一致，因此可以沿索引读取结果。

换成下面这条：

```sql
SELECT a, b, c
FROM orders
WHERE a > 1
ORDER BY b, c;
```

`a` 不再是单个常量。扫描顺序先按多个 `a` 分组，每个组内才按 `b,c` 排；把所有组连接起来后，全局并不按 `b,c` 有序，通常还需要额外排序。

同理，索引 `(a,b,c)` 可以直接提供 `(a)`、`(a,b)`、`(a,b,c)` 的顺序，却不能天然提供全局 `(b,c)` 顺序。[MySQL 的索引使用说明](https://dev.mysql.com/doc/refman/8.4/en/mysql-indexes.html)把排序、分组和左前缀放在同一规则下，原因就是它们共享同一份物理顺序。

还要留意方向。MySQL 支持降序索引和反向扫描，但多个列升降序混合时，索引定义的方向必须与查询需求兼容。看到 `Using filesort` 也不代表一定发生磁盘文件排序；它表示结果顺序不能直接由所选索引提供，排序可能在内存中完成。

## 九、覆盖索引怎样改变取数成本

假设业务只需要主键和联合索引中的列：

```sql
SELECT id, b, c
FROM orders
WHERE a = 1 AND b = 2;
```

二级索引叶子记录已经拥有 `a、b、c、id`，查询可以直接返回结果。传统 `EXPLAIN` 的 `Extra` 中通常会出现 `Using index`，表示使用覆盖索引。

如果改成：

```sql
SELECT payload
FROM orders
WHERE a = 1 AND b = 2;
```

`payload` 不在二级索引中，匹配的每条索引记录都可能触发一次聚簇索引查找。假如 `a=1 AND b=2` 命中几十万条记录，即使“走了索引”，大量随机回表也可能比顺序扫描更贵，优化器甚至可能放弃该索引。

“走索引”只能描述执行路径的一部分。联合索引负责界定候选记录，覆盖索引决定候选记录能否直接提供查询结果，两者带来的成本变化不同。

## 十、Skip Scan 的适用边界

MySQL 8.0 引入了 Skip Scan。对于索引 `(a,b)` 和只有 `b > 40` 的查询，优化器可能枚举少量不同的 `a`，分别构造：

```text
a = 第一个值 AND b > 40
a = 第二个值 AND b > 40
...
```

它相当于跳到每个不同前缀下面执行一次子范围扫描，因此某些没有提供最左列的查询也可能显示 `Using index for skip scan`。

但这项优化有明显前提。按照 [MySQL 8.4 Skip Scan 文档](https://dev.mysql.com/doc/refman/8.4/en/range-optimization.html)，它面向单表查询，要求查询列都能由索引覆盖，不使用 `GROUP BY` 或 `DISTINCT`，并且要满足特定的等值前缀与范围条件结构。是否采用还取决于基数统计和成本估算。

如果 `a` 有两个不同值，拆成两次扫描可能很划算；如果 `a` 有几十万个不同值，枚举前缀就接近另一种形式的全索引扫描。因此不能因为 Skip Scan 存在，就给高频的 `WHERE b=?` 查询只建 `(a,b)`。稳定的索引设计仍应让重要查询拥有可直接使用的左前缀。

## 十一、怎样决定联合索引的列顺序

“区分度高的列放最左边”只考虑了扫描行数。联合索引还承担排序、覆盖、回表控制和写入成本，列顺序需要从查询路径反推。

假设订单查询常见条件是：

```sql
SELECT id, created_at, amount
FROM orders
WHERE tenant_id = ?
  AND status = ?
  AND created_at >= ?
ORDER BY created_at DESC
LIMIT 50;
```

候选索引可能是：

```sql
KEY idx_tenant_status_time (tenant_id, status, created_at)
```

这条查询总是先限定租户和状态，再扫描一段时间范围，并希望直接按时间顺序取前 50 条。两个等值条件放在范围列之前，可以让 `created_at` 在已经固定的局部区间中保持可用顺序；这里不需要假设 `tenant_id` 必然比 `status` 选择度高。

设计时可以按下面的顺序检查：

1. 列出必须优化的真实 SQL，而不是孤立地观察字段。
2. 找出长期存在的等值条件、连接条件和租户边界。
3. 找出范围条件以及查询要求的排序方向。
4. 判断一棵索引能否同时形成窄扫描区间并提供结果顺序。
5. 评估是否值得加入少量返回列构成覆盖索引。
6. 检查新增索引带来的空间、写放大和 Buffer Pool 压力。

等值列之间的顺序有时可以根据选择度和可复用前缀决定；一旦涉及排序和范围，不能只按基数机械排列。索引 `(tenant_id,status,created_at)` 可以服务所有按租户查询的路径，而把 `status` 放在最前面，虽然某条 SQL 仍可能同时使用三个等值/范围条件，却未必适合更多只按租户访问的数据隔离场景。

索引增加一列，就会扩大索引记录，降低单页扇出，并增加写入、页分裂和缓存占用。[MySQL 优化文档](https://dev.mysql.com/doc/refman/8.4/en/optimization-indexes.html)同样提醒，不必要的索引既占空间，也会增加 `INSERT`、`UPDATE`、`DELETE` 的维护成本。

## 十二、用 `EXPLAIN ANALYZE` 检验推理

索引推理给出候选方案，最终仍要通过真实数据分布和执行计划验证。可以建立一张专门的实验表：

```sql
CREATE TABLE index_lab (
    id      BIGINT NOT NULL AUTO_INCREMENT,
    a       INT NOT NULL,
    b       INT NOT NULL,
    c       INT NOT NULL,
    payload VARCHAR(200) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_abc (a, b, c)
) ENGINE = InnoDB;
```

准备足够多且分布有差异的数据后，依次执行：

```sql
EXPLAIN ANALYZE
SELECT * FROM index_lab
WHERE a = 10 AND b = 20 AND c = 30;

EXPLAIN ANALYZE
SELECT * FROM index_lab
WHERE a = 10 AND c = 30;

EXPLAIN ANALYZE
SELECT * FROM index_lab
WHERE a = 10 AND b > 20 AND c = 30;

EXPLAIN ANALYZE
SELECT id, a, b, c FROM index_lab
WHERE a = 10 AND b = 20;
```

`EXPLAIN ANALYZE` 在 MySQL 8.4 中使用 TREE 格式并实际执行查询。还可以去掉 `ANALYZE`，用传统表格格式再看一遍计划。两种输出各有侧重：

- TREE 格式显示的是 index lookup、index range scan 还是 table scan；
- 实际扫描行数与返回行数相差多少，循环次数和耗时集中在哪里；
- 传统格式的 `type` 是 `const`、`ref`、`range`、`index` 还是 `ALL`；
- 传统格式中的 `key`、`key_len`、`rows`、`filtered` 和 `Extra`；
- `Extra` 是否出现 `Using index`、`Using index condition`、`Using filesort` 或 `Using index for skip scan`。

`key_len` 表示计划最多使用的索引键前缀长度，不应被当成“所有显示出来的列都负责精确定位”的绝对证据。可空列、隐式扩展的主键列和范围边界都会影响它。比起只盯着 `key_len`，`EXPLAIN ANALYZE` 提供的实际扫描行数更能说明索引有没有真正缩小工作量。

还要记住，`EXPLAIN ANALYZE` 会实际执行语句。验证生产查询时应先确认语句是只读的、参数具有代表性，并避免在业务高峰对重查询直接运行。官方的 [EXPLAIN 文档](https://dev.mysql.com/doc/refman/8.4/en/explain.html)可以作为各字段的版本基准。

## 十三、几类常见误判

### “联合索引等于三个单列索引”

`(a,b,c)` 提供的是 `(a)`、`(a,b)`、`(a,b,c)` 这些左前缀能力，不自动提供独立的 `(b)` 和 `(c)` 索引。三个单列索引也不能等价替代联合索引；即使优化器采用 Index Merge，它也需要合并多份结果，且不能自然获得 `(a,b,c)` 的复合顺序。

### “查询使用了索引，速度就一定快”

全索引扫描也叫扫描索引，低选择性范围可能读取大量记录，非覆盖查询还可能产生大量回表。需要观察扫描行数、返回行数和实际耗时，而不是只看 `key` 不为空。

### “把选择度最高的列永远放最前面”

选择度只是成本的一部分。高频查询是否总带该列、后面是否存在范围和排序、索引能否复用于其他关键路径，都可能改变顺序。脱离 SQL 谈列顺序，结论通常不可靠。

### “范围条件后面的列彻底不能使用”

后续列通常不能继续收紧单个连续扫描区间，却可能参与 ICP、覆盖索引过滤或返回结果。回答时必须说明“用在什么阶段”。

### “SQL 条件按索引顺序写才生效”

优化器会重组条件。决定能力的是索引键的排列和谓词语义，不是 `WHERE` 中文字的先后顺序。

### “Skip Scan 已经解决最左列缺失”

Skip Scan 有严格适用条件且依赖成本估算。它适合偶发查询的优化机会，不适合作为高频访问路径缺少正确索引的理由。

## 十四、把面试答案组织成一条因果链

如果面试官问“为什么联合索引遵循最左匹配”，可以这样回答：

> InnoDB 的普通索引按 B+ 树方式组织。联合索引 `(a,b,c)` 把三个字段当成一个复合键，按字典序排列：先比较 `a`，`a` 相同再比较 `b`，前两列都相同才比较 `c`。因此整棵树上只有 `a` 全局有序；固定 `a` 后 `b` 才局部有序；固定 `a、b` 后 `c` 才局部有序。查询要从左侧连续约束键部分，才能把条件转换成一个较窄的连续扫描区间，这就是最左匹配。
>
> 遇到范围条件时，该列可以确定范围边界，但后面的列通常不能继续收紧这个区间。不过后续列仍可能通过 ICP 在索引层过滤，所以不能简单说成“完全失效”。如果查询列都在二级索引中，还可能使用覆盖索引避免回表。最终应通过 `EXPLAIN ANALYZE` 查看实际扫描行数，而不是只判断有没有索引名称。

如果继续追问“为什么不用红黑树”，再补上页模型：

> 红黑树和 B+ 树的渐进复杂度都是对数级，但数据库按页读写。红黑树每个节点只有两个分支，树会更高；B+ 树内部页能保存大量键和子页指针，扇出高、层级少，并且叶子层适合范围扫描。因此差异不在 `O(log n)` 这几个字符，而在一次查询需要访问多少页面。

这两段回答已经覆盖了数据结构、物理排列、查询边界和工程验证。继续背更多口诀，反而容易在范围条件与 ICP 这类追问上产生矛盾。

## 结语

最左匹配不是 MySQL 人为规定的一条奇怪限制，它是复合有序结构的自然结果。`(a,b,c)` 先按 `a` 排，再按 `b` 排，最后按 `c` 排；查询只有从左向右逐步固定前缀，才能把目标压缩成连续的索引区间。

以后再分析联合索引，可以暂时忘掉“走不走索引”这个模糊问题，直接在纸上写出几条 `(a,b,c)` 记录，然后问：目标记录是否连续，扫描从哪里开始、到哪里结束，剩余条件在哪里过滤，最终是否需要回表。答案通常会比口诀更准确。

## 参考资料

- [MySQL 8.4：How MySQL Uses Indexes](https://dev.mysql.com/doc/refman/8.4/en/mysql-indexes.html)
- [MySQL 8.4：Multiple-Column Indexes](https://dev.mysql.com/doc/refman/8.4/en/multiple-column-indexes.html)
- [MySQL 8.4：Range Optimization](https://dev.mysql.com/doc/refman/8.4/en/range-optimization.html)
- [MySQL 8.4：Index Condition Pushdown](https://dev.mysql.com/doc/refman/8.4/en/index-condition-pushdown-optimization.html)
- [MySQL 8.4：Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html)
- [MySQL 8.4：The Physical Structure of an InnoDB Index](https://dev.mysql.com/doc/refman/8.4/en/innodb-physical-structure.html)
- [MySQL 8.4：Comparison of B-Tree and Hash Indexes](https://dev.mysql.com/doc/refman/8.4/en/index-btree-hash.html)
