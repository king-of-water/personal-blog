---
title: MySQL 慢查询怎样排查：从发现 SQL 到验证优化效果
description: 用一条订单深分页查询串起应用 Trace、慢查询日志、Performance Schema、锁等待、执行计划与上线验证，形成可复用的慢 SQL 排查闭环。
category: 后端
subcategory: MySQL
articleClass: focused
seriesOrder: 60
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [MySQL, 慢查询, Performance Schema, Slow Query Log, SQL 优化, 故障排查]
---

接口变慢时，数据库经常最先被怀疑。可“请求用了 3 秒”和“某条 SQL 执行了 3 秒”不是同一个事实。请求还可能在连接池排队、等待行锁、传输大量结果，或者在应用中反序列化。即使已经确认时间花在 MySQL，一条 SQL 变慢也可能来自执行计划、数据量、并发等待和底层资源。

慢查询排查要把现象缩小成可验证的因果链：哪个请求受影响，时间花在哪一段，哪类 SQL 贡献最大，这条 SQL 在等待还是运行，执行过程中处理了多少数据，修改后哪些指标应该变化。

本文以 MySQL 8.4 为准，使用一个订单列表深分页故障贯穿全文。SQL 与指标数字经过简化，用于说明排查方法。执行计划字段和 `EXPLAIN ANALYZE` 的读法已在上一篇[《一条 SQL 是怎样执行的》](/posts/mysql-sql-execution-optimizer-explain-analyze/)展开，这里集中讨论线上定位与验证。

## 一、先定义“慢”发生在哪一层

一个典型数据库请求至少经过这些时间段：

```text
客户端请求
  -> 应用线程排队
  -> 等待数据库连接
  -> 建立或复用连接
  -> MySQL 执行与等待
  -> 结果集通过网络返回
  -> 驱动读取、对象映射与业务处理
  -> 响应客户端
```

应用监控只看到端到端耗时，MySQL 慢日志只看到服务端记录的语句信息，两边口径不同。若接口耗时 2.8 秒，数据库 Span 只有 80 毫秒，应先检查连接池、下游调用或应用计算。反过来，数据库 Span 占了 2.4 秒，才需要继续进入 MySQL。

排查开始时应同时记录四个边界：发生时间、受影响接口、请求参数范围和数据库实例。缺少其中任何一个，都容易拿错时间窗口或查到另一个实例上的同名 SQL。

### 平均值正常，用户仍然可能很慢

订单列表接口的大部分请求只看第一页，少数运营人员会翻到几千页。假设第一页耗时 30 毫秒，深分页耗时 2 秒，整体平均值仍可能只有 50 毫秒。用户感受到的是后者，平均值会把它稀释。

因此至少要同时看调用量、错误率和延迟分位数。p95、p99 抬升而平均值稳定，通常说明问题只影响部分参数、租户或数据分片。所有分位数同时抬升，则更像实例资源、公共锁、网络或全局计划变化。

“慢查询”也不应只按固定阈值定义。在线接口 300 毫秒可能已经超出预算；每天一次的离线任务运行 5 秒却可以接受。阈值要来自业务延迟目标和查询类型，而不是把 `long_query_time=10` 的默认值当成性能标准。

## 二、完整排查链路从请求证据开始

一次可靠排查通常按“发现、归因、诊断、修改、验证”推进。任何一步缺失，结论都可能变成猜测。

![MySQL 慢查询从告警到验证的排查闭环](/images/posts/mysql-slow-query-troubleshooting-loop.svg)

发现阶段回答影响范围：哪些接口、租户、节点和时间窗口异常。归因阶段把请求映射到具体数据库 Span 与 SQL Digest。诊断阶段区分锁等待、资源饱和、执行计划和返回数据量。修改阶段选择最小且可回滚的方案。验证阶段比较同口径指标，并观察修改是否把成本转移到写入、其他查询或副本。

不要从 `SHOW PROCESSLIST` 里随便挑一条运行时间最长的 SQL 开始。它只是故障现场的一张瞬时照片，可能恰好捕获到一个正常的大任务，也可能错过已经执行完的尖峰。先用请求链路和时间窗口缩小范围，再进入数据库找证据，命中率会高很多。

## 三、慢查询日志保存单次慢执行

MySQL 的[慢查询日志](https://dev.mysql.com/doc/refman/8.4/en/slow-query-log.html)记录执行时间超过 `long_query_time`，且检查行数达到 `min_examined_row_limit` 的语句。它适合回答“哪一次执行很慢、当时参数是什么、检查了多少行”。

```sql
SHOW VARIABLES WHERE Variable_name IN (
  'slow_query_log',
  'slow_query_log_file',
  'long_query_time',
  'min_examined_row_limit',
  'log_output',
  'log_slow_extra'
);
```

一套常见的配置思路是把日志写入 FILE，由采集系统增量读取和归档：

```ini
[mysqld]
slow_query_log=ON
slow_query_log_file=/var/log/mysql/mysql-slow.log
log_output=FILE
long_query_time=0.5
min_examined_row_limit=100
log_slow_extra=ON
```

具体阈值要结合实例容量、日志预算和业务 SLO。临时把 `long_query_time` 降到很小会大幅增加日志量与 I/O，线上调整前要确认采集、轮转和磁盘空间。`log_queries_not_using_indexes` 也要谨慎开启，因为小表扫描、合理的分析查询和无法从索引获益的语句都可能灌满日志；MySQL 提供 `log_throttle_queries_not_using_indexes` 做每分钟限流。

### 一条慢日志能告诉你什么

FILE 输出的基本字段包括 `Query_time`、`Lock_time`、`Rows_sent` 和 `Rows_examined`。开启 `log_slow_extra` 后，还能看到每条语句的临时表、排序、Handler 读取和字节收发等计数。

```text
# Query_time: 2.184  Lock_time: 0.000
# Rows_sent: 50  Rows_examined: 180050
SET timestamp=1791183600;
SELECT id, user_id, amount, status, created_at
FROM orders
WHERE tenant_id = 42 AND status = 'PAID'
ORDER BY created_at DESC, id DESC
LIMIT 50 OFFSET 180000;
```

这条记录中，`Rows_examined / Rows_sent` 达到 3,601。数据库为了返回 50 行检查了 180,050 行，说明单次请求存在大量无效工作。SQL 已经使用索引也可能出现这种现象，因此“只记录未用索引查询”抓不到它。

慢日志也有边界。它在语句执行完成后写入，日志顺序可能与开始执行顺序不同；文档还明确说明，获取初始锁的时间不计入执行时间。排查正在发生的阻塞时，必须结合实时会话和锁等待信息，不能只从事后日志推断完整等待过程。

阈值采样还会漏掉“单次不慢、总量很大”的 SQL。某查询每次 20 毫秒却每秒执行 5,000 次，它不会进入 500 毫秒阈值的慢日志，但每秒累计消耗 100 秒的数据库执行时间，可能正是 CPU 压力来源。

## 四、Performance Schema 用 Digest 聚合同类 SQL

Performance Schema 会把字面量归一化，形成 SQL Digest。例如：

```sql
SELECT * FROM orders WHERE tenant_id = 42 AND id = 1001;
SELECT * FROM orders WHERE tenant_id = 77 AND id = 9008;
```

可以归并成类似：

```text
SELECT * FROM orders WHERE tenant_id = ? AND id = ?
```

`events_statements_summary_by_digest` 按 schema 和 Digest 聚合执行次数、总耗时、平均耗时、最大耗时、锁时间、检查行数、发送行数、临时表和排序等信息。[官方 Statement Summary 文档](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-statement-summary-tables.html)还提供 p95、p99 与 p999 估算列，以及一条采样 SQL 文本。

直接查询原始表时，计时器单位和列较多。日常排查可以先用 sys schema 的友好视图：

```sql
SELECT db,
       query,
       exec_count,
       total_latency,
       avg_latency,
       max_latency,
       lock_latency,
       rows_examined,
       rows_examined_avg,
       rows_sent,
       tmp_disk_tables,
       full_scan,
       first_seen,
       last_seen,
       digest
FROM sys.statement_analysis
WHERE db = 'trade'
ORDER BY total_latency DESC
LIMIT 20;
```

[sys.statement_analysis 文档](https://dev.mysql.com/doc/refman/8.4/en/sys-statement-analysis.html)说明，这个视图基于 Digest 汇总，并默认按总延迟降序展示。总延迟适合找“总体资源贡献最大”的 SQL；最大或尾延迟适合找偶发慢请求；平均延迟只能作为其中一个维度。

还可以针对特征查看 sys 视图：

```sql
SELECT * FROM sys.statements_with_runtimes_in_95th_percentile;
SELECT * FROM sys.statements_with_full_table_scans;
SELECT * FROM sys.statements_with_sorting;
SELECT * FROM sys.statements_with_temp_tables;
```

这些视图负责筛选候选，不负责直接判定故障。小表全扫可能合理，磁盘临时表也可能来自低频报表。仍要把 SQL 与业务流量、处理行数和实例资源对应起来。

### Digest 会隐藏参数倾斜

归一化能合并同类 SQL，也会把不同参数的行为揉在一起。订单列表的第一页与第 3,600 页属于同一 Digest：平均耗时主要由大量第一页请求决定，`OFFSET=180000` 的慢执行只占很小比例。

因此定位到 Digest 后，还要回到 Trace、慢日志或 `QUERY_SAMPLE_TEXT` 找代表性参数。多租户系统尤其如此。小租户走同一执行计划只需几毫秒，大租户可能扫描百万行；只拿一个方便构造的参数运行 `EXPLAIN`，很容易复现出“完全正常”的计划。

Digest 汇总是累计值。实例启动时间、表是否被 truncate、采集窗口多长，都会影响总量比较。观察一次发布前后的变化时，最好保存窗口快照或计算增量，而不是拿运行三十天的累计值与发布后十分钟直接比较。MySQL 的 `sys.statement_performance_analyzer()` 支持 snapshot 和 delta，也可以由监控系统周期性采样原始计数器。

## 五、故障正在发生时先区分运行与等待

“SQL 挂了 10 秒”可能表示它一直在扫描，也可能 9.9 秒都在等待另一事务。两种情况的处理方向完全不同。

MySQL 8.4 的 [sys.processlist](https://dev.mysql.com/doc/refman/8.4/en/sys-processlist.html) 比传统 `SHOW PROCESSLIST` 提供更多字段，并基于 Performance Schema，访问时不需要旧 processlist 实现使用的全局互斥量：

```sql
SELECT conn_id,
       user,
       db,
       command,
       state,
       time,
       current_statement,
       statement_latency,
       lock_latency,
       rows_examined,
       rows_sent,
       tmp_disk_tables,
       last_wait
FROM sys.session
WHERE command <> 'Sleep'
ORDER BY time DESC;
```

如果现场只出现少数会话长时间等待锁，先找阻塞者。`sys.innodb_lock_waits` 已经把 `data_lock_waits`、事务和会话信息整理到一起：

```sql
SELECT wait_age_secs,
       locked_table_schema,
       locked_table_name,
       locked_index,
       waiting_pid,
       waiting_query,
       blocking_pid,
       blocking_query,
       sql_kill_blocking_connection
FROM sys.innodb_lock_waits
ORDER BY wait_age_secs DESC;
```

[data_lock_waits 文档](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-lock-waits-table.html)把等待关系描述为“哪个锁请求被哪个已持有锁阻塞”。上一篇锁与死锁文章已经展开锁范围；现场排查的重点是确认阻塞链、事务开始时间、未提交原因和影响范围。

不要看到 `sql_kill_blocking_connection` 就立刻执行。阻塞者可能正在提交一笔关键事务，直接断开会触发大事务回滚，使恢复时间更长。先确认事务内容、修改行数、是否仍在推进，以及应用能否安全重试。终止连接属于止血操作，不是根因修复。

### 没有锁等待时看资源和访问量

若大量会话都在运行，数据库 CPU 接近饱和，常见方向是 SQL 处理行数突然增加、流量放大或计划变化。若 CPU 不高而磁盘等待、读取吞吐和文件 I/O 延迟明显上升，需要检查工作集是否超出 Buffer Pool、是否发生大量随机回表、临时表是否落盘，以及宿主机存储是否异常。

sys schema 提供若干汇总入口：

```sql
SELECT * FROM sys.io_global_by_wait_by_bytes
ORDER BY total_latency DESC
LIMIT 20;

SELECT * FROM sys.schema_table_statistics_with_buffer
ORDER BY io_read_latency DESC
LIMIT 20;
```

[I/O 汇总视图文档](https://dev.mysql.com/doc/refman/8.4/en/sys-io-global-by-wait-by-bytes.html)说明，它按事件汇总读写字节和等待时间。这里看到的是实例或对象层面的资源现象，仍需通过时间窗口、表与 SQL Digest 关联，不能仅凭“磁盘读很多”断定某条查询有问题。

对于仍在执行且不是 Prepared Statement 的查询，可以在另一个会话运行：

```sql
EXPLAIN FORMAT=TREE FOR CONNECTION 12345;
```

[EXPLAIN FOR CONNECTION 文档](https://dev.mysql.com/doc/refman/8.4/en/explain-for-connection.html)指出，它返回指定连接当前实际采用的计划，适合诊断短暂的计划问题。目标查询结束后就无法再取；它也不支持 Prepared Statement，所以仍要准备慢日志与 Performance Schema 作为事后证据。

![一条慢 SQL 的时间可能花在四种不同位置](/images/posts/mysql-slow-query-latency-breakdown.svg)

图中四种路径可能产生相近的总耗时，但证据不同：锁等待有明确阻塞关系，I/O 等待会伴随文件读取延迟，CPU 执行通常对应高扫描或计算量，结果传输则表现为 `Rows_sent`、发送字节和应用取数时间偏大。

## 六、把候选 SQL 按影响排序

线上实例可能同时存在几百种慢 SQL，修复顺序应由影响决定。可以从四个维度排序：

| 维度 | 常用证据 | 它回答的问题 |
| --- | --- | --- |
| 总资源贡献 | `total_latency`、执行次数、CPU 与 I/O | 哪类 SQL 长期消耗最多 |
| 单次与尾延迟 | `max_latency`、p95/p99、慢日志 | 哪类请求让用户等得最久 |
| 访问效率 | `Rows_examined / Rows_sent`、实际计划行数 | 为得到结果做了多少无效工作 |
| 并发放大 | 锁等待数量、`loops`、连接池排队 | 单个问题怎样拖住其他请求 |

一条每天执行一次的 30 秒报表，可能不如每次 80 毫秒、每秒 2,000 次的点查值得优先处理。反过来，支付确认接口即使调用量低，只要尾延迟触发重试并可能放大业务风险，也应进入高优先级。

`Rows_examined / Rows_sent` 是很实用的筛选指标，但也不能机械设阈值。`COUNT(*)` 聚合本来就可能检查许多行只返回一个数字；批量导出需要读取并发送大量行。这个比例适合发现“结果很小却扫描很大”的在线查询，再结合业务语义判断。

## 七、订单深分页故障怎样一步步定位

假设 14:05 开始，运营后台订单列表 p99 从 180 毫秒升到 2.8 秒，平均耗时只从 45 毫秒变成 62 毫秒。MySQL CPU 保持在 35% 左右，没有明显锁等待，故障只集中在租户 `42` 的高页码请求。

接口 Trace 显示：连接池等待约 3 毫秒，数据库 Span 占 2.2 秒，返回结果反序列化约 8 毫秒。问题可以归到数据库执行阶段。

慢日志捕获到：

```sql
SELECT id, user_id, amount, status, created_at
FROM orders
WHERE tenant_id = 42
  AND status = 'PAID'
ORDER BY created_at DESC, id DESC
LIMIT 50 OFFSET 180000;
```

表上已经有联合索引：

```sql
KEY idx_tenant_status_created_id
    (tenant_id, status, created_at DESC, id DESC)
```

所以它没有全表扫描，也没有额外 filesort。问题来自 OFFSET 语义：为了找到第 180,001 条记录，执行器仍要沿有序索引读取并丢弃前 180,000 条，最后返回 50 条。传统 `EXPLAIN` 能显示索引访问，却不直观展示被丢弃的行；`EXPLAIN ANALYZE` 用真实高 OFFSET 参数会看到 Limit 节点下方读取了约 180,050 行。

Digest 汇总进一步解释了平均值为何正常。这个 SQL 模板一小时执行 60,000 次，其中 58,000 次在前十页；深分页只有几百次。平均耗时被大量快速调用稀释，`max_latency`、p99 和慢日志才能暴露长尾。

### 为什么加另一条索引解决不了

当前索引已经同时满足等值过滤与排序。增加同列不同顺序的索引不会改变 OFFSET 必须跳过前面结果的事实。扩大 `sort_buffer_size` 也无效，因为这条计划没有做 filesort。此时继续围绕执行参数调优，只会增加索引写入或实例内存风险。

可选方案取决于产品语义：

1. 连续翻页改为 Keyset Pagination，也叫游标分页。客户端携带上一页最后一条记录的 `(created_at,id)`。
2. 若运营人员必须随机跳到任意页，限制可跳范围，深页查询改成异步导出或专用搜索系统。
3. 业务确实需要精确页码时，可以维护更粗粒度的定位信息，但它引入额外状态与更新成本，不能当作普通列表的默认方案。

游标分页 SQL 可以写成：

```sql
SELECT id, user_id, amount, status, created_at
FROM orders
WHERE tenant_id = ?
  AND status = ?
  AND (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

联合索引可以直接定位到游标之后的区间，再顺序读取 50 行。扫描量从“OFFSET + page_size”降到接近 page_size，不再随页码线性增长。

游标字段必须形成稳定全序。`created_at` 可能重复，所以要追加唯一 `id`。若只用时间戳，翻页边界处可能重复或漏行。并发插入和删除下，游标分页提供的是沿某个排序边界继续读取，并不自动生成全程一致的历史快照；产品需要明确列表允许怎样变化。

## 八、不同根因对应不同修改

慢 SQL 没有统一解法。诊断证据应该直接约束修改方向。

### 扫描范围太大

表现通常是 `Rows_examined` 高、实际计划叶子节点读取大量记录、CPU 或 I/O 随流量上涨。可以检查谓词是否可索引、联合索引列序是否匹配等值与范围条件、是否发生隐式类型转换、函数是否包住索引列，以及深分页是否产生无效扫描。

索引只能减少可利用访问条件的读取。`LIKE '%keyword%'`、复杂跨列计算和大范围报表可能需要全文索引、预聚合、搜索引擎或离线计算。不能把所有慢查询都改造成一条更宽的 B+ 树索引。

### 估算错误导致计划不合适

`EXPLAIN ANALYZE` 中 estimated rows 与 actual rows 在早期节点出现数量级差距时，检查统计信息、数据倾斜、列相关性和参数分布。`ANALYZE TABLE` 可以更新表统计，直方图可以帮助部分非索引列常量条件的选择率估算。

如果同一 SQL 对不同租户的数据规模差异极大，强制一个固定索引可能只把问题从大租户转给小租户。可以考虑拆分查询路径、把租户规模纳入数据模型，或调整业务接口，使每次查询的范围有上限。

### 锁等待或长事务

执行计划可能完全正常，耗时来自阻塞事务。此时要缩短事务、统一加锁顺序、减少交互式事务中的停顿，并确认索引是否让 `UPDATE` 或锁定读扫描并锁住过大范围。

应用还要对死锁和超时提供有限重试，但重试不能替代根因修复。阻塞链已经占满连接池时，无退避重试会制造更多等待者。关于锁范围、死锁与事务重试，可回看[《MySQL 锁与死锁》](/posts/mysql-record-gap-next-key-lock-deadlock/)。

### 排序、临时表与结果集过大

排序或临时表慢时，先看输入行数和是否落盘。更早过滤、改变聚合粒度、使用能提供顺序的索引，往往比直接放大全局 buffer 更安全。全局提高每连接内存参数，在高并发下可能把单条查询优化成实例内存风险。

若 `Rows_sent` 很高，问题可能来自接口一次取数过多。即使数据库扫描高效，网络发送、JDBC 驱动缓存、对象映射和 GC 也会占用时间。分页、字段裁剪、流式读取或异步导出通常比继续改索引更有效。

### 实例资源已经饱和

所有主要 SQL 同时变慢，CPU、I/O 队列、连接数或 Buffer Pool 指标同步恶化时，要先处理容量和流量。单独优化一条低占比 SQL 不足以恢复服务。限流、降级、迁移批任务和扩容可以止血，之后仍要找到负载增长来源，否则容量只会再次被填满。

## 九、优化验证必须保持口径一致

SQL 改完且结果正确，只完成了一半。性能验证至少要覆盖查询自身、实例影响和业务链路。

先验证语义。游标分页和 OFFSET 分页对“跳页”、并发新增、删除与重复排序值的语义不同；加索引虽然不改变结果，但 SQL 重写、Join 顺序提示、预聚合表都可能改变空值、重复行和时间边界。需要用业务不变量和代表性边界数据检查，而不是只看返回行数相同。

再比较相同参数下的执行证据：

- 执行计划是否走预期索引，estimated rows 与 actual rows 是否接近；
- `Rows_examined`、`Rows_sent`、临时表和排序行数是否按预期变化；
- 同一深度请求的 p50、p95、p99 是否下降；
- 在大租户、小租户、空结果和高基数参数下是否都稳定；
- 冷热缓存与并发流量变化时，结论是否仍成立。

订单案例中，核心验收不是“2.184 秒降到 20 毫秒”这一个数字，因为单次时间受缓存和机器负载影响。更稳定的证据是深页请求不再出现随页码增长的扫描量：每页实际读取接近 50 条，Digest 的 `rows_examined_avg` 下降，高页码 p99 与第一页进入同一数量级。

### 不要把代价转移给写入和其他查询

新增联合索引会增加磁盘空间、Buffer Pool 压力和 DML 维护成本。SQL 从主库转到只读副本会引入复制延迟语义。建立汇总表会增加数据新鲜度和补偿逻辑。每个读优化都可能让另一个环节付费。

上线后要同时观察写入延迟、Redo 量、Buffer Pool 命中、复制延迟和其他 Digest。索引变更还可能让优化器为其他 SQL 选择新计划。对高风险修改采用灰度、可见性索引评估、Online DDL 能力和明确回滚步骤，避免一次性能修复演变成新的可用性故障。

### 用时间窗口比较而不是看累计总量

发布前保存 15 分钟或一小时的 Digest 快照，发布后用相同长度、相近流量的窗口比较。至少记录执行次数、总延迟、平均与最大延迟、检查行数、发送行数、临时磁盘表和错误数。

若发布后流量下降一半，总延迟下降并不能证明单次查询变快；若执行次数上升，总延迟持平反而可能说明单位成本降低。将总量、单次均值和分位数放在一起，才能分清优化收益与流量变化。

## 十、几种常见的错误处理方式

第一种是看到 `Using filesort` 就加索引。排序输入只有几十行时，它可能几乎不占时间；新索引反而增加写成本。先看 `EXPLAIN ANALYZE` 中排序节点的输入行数和时间。

第二种是看到 `ALL` 就判断慢。小表全扫可能是最低代价，分析型查询也可能本来就要读取大部分数据。访问类型要和表规模、实际行数、调用频率一起看。

第三种是直接扩大 Buffer Pool、`sort_buffer_size` 或临时表内存。实例资源确实不足时配置调整有价值，但它不能修复深 OFFSET、锁等待或错误 SQL。每连接 buffer 还会随并发放大内存占用。

第四种是拿一组无代表性的参数验证。用空租户或第一页运行，无法说明大租户深分页已经修复。参数分布属于复现条件的一部分。

第五种是只看单次执行变快。新增索引后一次查询降低 100 毫秒，却让高频写入每次多维护一棵宽索引，整体收益可能为负。验证必须覆盖实例层和业务层。

第六种是慢请求出现就无限重试。数据库已经饱和或连接池排满时，重试会增加查询数量；锁超时重试也可能再次撞上同一个阻塞事务。应先限制重试次数并加入退避，再处理等待根因。

## 十一、一份可执行的线上排查清单

遇到 MySQL 相关延迟告警时，可以按以下顺序推进：

1. 记录时间窗口、接口、租户或分片、数据库实例和最近变更。
2. 用 Trace 拆分连接池等待、MySQL Span、结果传输和应用处理时间。
3. 查看实例 CPU、I/O、连接数、Buffer Pool、复制延迟和错误率，判断是局部 SQL 还是全局饱和。
4. 从慢日志找单次样本，从 Digest 汇总找总耗时、长尾和调用量最大的 SQL 模板。
5. 保留真实参数，特别是租户、时间范围、IN 列表大小、OFFSET 和数据倾斜值。
6. 故障仍在发生时查看 `sys.session`、`sys.innodb_lock_waits` 和当前等待事件，区分运行与等待。
7. 用普通 `EXPLAIN` 控制风险，再在安全环境或可控查询上使用 `EXPLAIN ANALYZE` 比较估算与实际。
8. 把根因归到扫描、估算、锁、排序或临时表、结果集、资源容量中的一类或几类。
9. 选择最小可回滚修改，并提前定义语义、查询、实例和业务四层验收指标。
10. 灰度发布后用同长度窗口比较 Digest、尾延迟、扫描量和写入副作用，保留回滚观察期。

这套流程不会保证每次都由一条索引解决问题，它能保证结论有来源。慢查询排查的交付物应是一条完整证据链：哪类请求变慢，哪个 SQL 模板负责，时间消耗在哪，修改减少了什么工作量，以及上线后有没有把成本转移到别处。

## 参考资料

- [MySQL 8.4：The Slow Query Log](https://dev.mysql.com/doc/refman/8.4/en/slow-query-log.html)
- [MySQL 8.4：Performance Schema Statement Event Tables](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-statement-tables.html)
- [MySQL 8.4：Statement Summary Tables](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-statement-summary-tables.html)
- [MySQL 8.4：sys.statement_analysis](https://dev.mysql.com/doc/refman/8.4/en/sys-statement-analysis.html)
- [MySQL 8.4：Statements in the 95th Percentile](https://dev.mysql.com/doc/refman/8.4/en/sys-statements-with-runtimes-in-95th-percentile.html)
- [MySQL 8.4：sys.processlist](https://dev.mysql.com/doc/refman/8.4/en/sys-processlist.html)
- [MySQL 8.4：Performance Schema data_lock_waits](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-lock-waits-table.html)
- [MySQL 8.4：sys.innodb_lock_waits](https://dev.mysql.com/doc/refman/8.4/en/sys-innodb-lock-waits.html)
- [MySQL 8.4：EXPLAIN FOR CONNECTION](https://dev.mysql.com/doc/refman/8.4/en/explain-for-connection.html)
- [MySQL 8.4：sys.io_global_by_wait_by_bytes](https://dev.mysql.com/doc/refman/8.4/en/sys-io-global-by-wait-by-bytes.html)
