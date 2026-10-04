---
title: 多台机器怎样确保定时任务只执行一次：任务调度、租约与幂等
description: 从一次续签补偿扫描出发，拆开定时触发、任务抢占、租约续期、超时接管、Fencing Token 与业务幂等，说明多实例调度怎样避免漏跑和重复副作用。
category: 后端
subcategory: 分布式
articleClass: flagship
seriesOrder: 130
publishedAt: 2026-10-04
tags: [分布式任务, 定时任务, 租约, Leader Election, 幂等, Fencing Token, 调度系统]
---

续签支付系统每分钟扫描一次 `PROCESSING` 流水，查询钱包结果并推进状态。服务只有一个实例时，进程里的 cron 足够；扩成十个实例后，同一个 cron 会触发十次。给其中一台机器加“主节点”标记可以暂时止住重复，但发布、宕机和网络分区会不断改变谁是主节点。

多机定时任务常被概括成“抢一把分布式锁”。这句话漏掉了三个时间窗口：获得执行权的进程可能暂停到租约过期；任务可能已经产生副作用，却在记录成功前崩溃；新执行者接管后，旧执行者可能恢复并继续写。锁只能协调谁先进入，无法单独证明最终副作用只有一次。

本文回答的问题是：**多个调度器会同时触发、执行进程可能随时失联时，怎样让每个计划任务不漏跑、允许安全接管，并把重复执行限制在业务可接受的范围内？** 分布式锁的 Redis、ZooKeeper 与 Fencing Token 细节见[分布式锁文章](/posts/distributed-locks-redis-zookeeper-fencing-token/)，RPC 结果未知和幂等协议见[超时、重试与幂等](/posts/timeouts-retries-idempotency-exactly-once/)。这里关注完整的调度与执行生命周期。

## 先区分四个“一次”

| 承诺 | 含义 | 常见实现 | 单独使用的缺口 |
| --- | --- | --- | --- |
| 触发一次 | 一个计划点只创建一个任务实例 | 唯一键、Leader 调度 | 创建响应超时后结果未知 |
| 同时一个执行者 | 某时刻只有一个 Worker 持有资格 | 租约、CAS 抢占 | 旧 Worker 恢复后仍可能写 |
| 至少执行一次 | 失败或超时后会被重新投递 | 超时接管、消息重投 | 业务代码可能重复执行 |
| 副作用一次 | 重试不会重复扣款、发券或发消息 | 幂等键、唯一约束、状态机 | 需要业务存储参与判断 |

生产系统通常选择“至少执行一次 + 业务幂等”。若要求调度系统在任意进程崩溃、网络超时和存储故障下仍天然做到 exactly-once，就必须把任务状态与所有业务副作用放入同一个原子提交域。跨数据库、RPC 和消息队列后，这个条件很快消失。

![计划点、任务实例、租约与业务副作用之间的关系](/images/posts/scheduled-task-lease-flow.svg)

图中的两层唯一性不能合并。`job_name + scheduled_at` 标识“2026-10-04 12:01 这一轮扫描”，用于阻止调度器重复创建实例；`business_key` 标识“订单 T1001 的补偿动作”，用于阻止一次扫描重试或下一轮扫描重复推进同一订单。

## 一、先把 cron 表达成持久化任务实例

内存 cron 只有一个时间判断：时钟到点便调用函数。进程在触发前重启，这个计划点可能消失；触发后崩溃，下一台机器也不知道工作执行到了哪里。可恢复调度器会把“计划”与“本次运行”分开保存：

```sql
CREATE TABLE job_instance (
  id              BIGINT PRIMARY KEY,
  job_name        VARCHAR(128) NOT NULL,
  scheduled_at    TIMESTAMP(3) NOT NULL,
  status          VARCHAR(32) NOT NULL,
  owner           VARCHAR(128),
  lease_until     TIMESTAMP(3),
  fencing_token   BIGINT NOT NULL DEFAULT 0,
  attempt         INT NOT NULL DEFAULT 0,
  next_retry_at   TIMESTAMP(3),
  last_error      VARCHAR(1024),
  created_at      TIMESTAMP(3) NOT NULL,
  updated_at      TIMESTAMP(3) NOT NULL,
  UNIQUE KEY uk_job_slot (job_name, scheduled_at)
);
```

计划表达“每分钟执行”；任务实例表达“12:01 这一轮是否已经创建、由谁执行、执行结果怎样”。多台调度器即使同时计算出相同计划点，也只能有一个插入成功。唯一约束比“先查有没有，再插入”可靠，因为两个事务可以同时查到不存在。

### 时间槽必须使用确定性规则

`scheduled_at` 不能直接取每台机器执行代码时的 `now()`。实例 A 在 `12:01:00.003` 触发，实例 B 在 `12:01:00.021` 触发，两个值不同，唯一键挡不住。调度器应把当前时间归一到同一计划槽，例如 UTC 分钟边界 `12:01:00.000`，或者由 cron 解析器计算明确的上一触发点。

时区与夏令时也要进入协议。每天当地时间 02:30 的任务，在夏令时切换日可能不存在或出现两次。计划应保存时区、原始表达式与最终 UTC 触发时间，并明确缺失时间是跳过、顺延还是补跑，重复时间是否生成两个带不同偏移量的实例。

### 调度 Leader 减少竞争，唯一键负责兜底

所有实例都计算计划并抢唯一键可以工作，但会制造持续的重复写冲突。更常见的做法是选一个 Scheduler Leader，由它创建任务实例；Leader 故障后，其他候选者接管。Leader election 降低平时竞争，数据库唯一约束仍保留，因为切换窗口里可能短暂存在两个自认为是 Leader 的进程。

[Kubernetes Lease](https://kubernetes.io/docs/concepts/architecture/leases/)就是一种轻量协调记录。高可用的 `kube-controller-manager` 和 `kube-scheduler` 使用 Lease 做 Leader election。Lease 保存持有者身份、续约时间和租期；候选者通过带资源版本的更新竞争所有权。这个机制适合选出控制循环的主动实例，不会替控制循环完成业务幂等。

## 二、租约表达一段有期限的执行资格

普通锁只有“持有”和“未持有”。持有者崩溃后若没有释放，其他 Worker 永远无法接管。租约给执行权加上期限：Worker 必须周期续期；超过期限没有成功续约，其他 Worker 可以获得新的资格。

```sql
UPDATE job_instance
SET owner = :worker,
    lease_until = DB_TIMESTAMP + INTERVAL 30 SECOND,
    fencing_token = fencing_token + 1,
    status = 'RUNNING',
    attempt = attempt + 1,
    updated_at = DB_TIMESTAMP
WHERE id = :id
  AND status IN ('READY', 'RETRY', 'RUNNING')
  AND (owner IS NULL OR lease_until < DB_TIMESTAMP);
```

这条 CAS 的判断和更新必须在同一个权威存储中完成。若 Worker 使用自己的本地时间判断过期，机器时钟偏差会让两个进程对租约是否有效得出不同结论。数据库时间不能消除暂停和网络延迟，但能让“记录何时过期”由一个时钟域解释。

租期 30 秒、每 10 秒续一次只是参数示例。租期至少覆盖一次正常续期延迟的高分位数和短暂停顿；续期间隔要留下多次重试机会；接管延迟大致受租期上界约束。租期太短容易因 GC、CPU 抢占或网络抖动频繁换主，太长则让真实故障迟迟不能接管。

### 获得租约不等于拥有永久执行权

Worker A 获得租约后发生 40 秒 Stop-The-World。30 秒时租约过期，Worker B 接管并开始工作；40 秒后 A 恢复，它的线程会从暂停位置继续执行。此时 A 和 B 都可能调用钱包或写数据库。TTL 只让协调记录过期，不会中止旧进程。

因此 Worker 要在关键阶段检查取消信号和剩余租期，续约失败后停止获取新任务。对于正在进行的外部 RPC，进程未必能及时取消，资源端还需要 Fencing Token 或业务幂等拒绝旧执行者。

## 三、Fencing Token 阻止过期执行者继续写

每次成功获得任务租约时，`fencing_token` 单调递增。Worker 把 token 带给接受副作用的资源端，资源端只接受不小于已见最大值的请求：

```sql
UPDATE account_reconcile_progress
SET cursor = :new_cursor,
    last_fencing_token = :token
WHERE job_name = :job_name
  AND last_fencing_token < :token;
```

A 获得 token 41 后暂停，B 接管得到 42。B 的写入把资源端 token 推进到 42；A 恢复后携带 41，更新影响行数为 0。旧执行者仍然活着，但已失去产生新副作用的资格。

Fencing 只有在副作用落点执行校验才有效。调度库生成 token，业务数据库完全不看它，旧 Worker 仍能覆盖新数据。第三方 API 若不支持 token，可以使用业务幂等键、条件更新或把副作用代理到能执行校验的本地服务。某些不可撤销外部动作无法 fence，只能依赖对方幂等接口和事后对账。

Token 的作用域也要与资源一致。一个全局计数器简单却形成热点；每个任务实例自增只保护该实例的写入。若多个不同任务都会修改同一账户进度，它们必须共享能够比较的版本域，或者由业务状态机决定合法迁移。

## 四、任务实例需要一套可恢复状态机

任务表不能只有 `running` 布尔值。一次执行可能等待、运行、明确失败、结果未知、待重试、成功或进入人工处理。状态迁移必须带 owner、token 或 version 条件，防止旧 Worker 覆盖接管者的结果。

![任务实例从创建到接管、重试和完成的状态机](/images/posts/scheduled-task-state-machine.svg)

一次典型迁移如下：

```text
READY -> RUNNING(token=41, owner=A)
RUNNING -> RETRY       明确可重试失败
RUNNING -> UNKNOWN     外部调用结果未知
RUNNING -> SUCCEEDED   所有完成条件已有证据
RUNNING(lease expired) -> RUNNING(token=42, owner=B)
RETRY -> DEAD          超过次数或业务截止时间
```

`UNKNOWN` 值得单独存在。Worker 调用钱包成功后，在更新任务表之前崩溃，调度器无法从超时推断钱包是否执行。接管者要用业务号查询钱包结果，或者用同一个幂等键再次调用。把它直接标成 `FAILED` 会让补偿逻辑误以为没有副作用。

### 完成条件要基于业务证据

扫描任务读取 1,000 条订单并处理，不应因为循环正常返回就标记成功。完成条件可以是“游标推进到本轮水位线，且所有已领取订单进入终态或独立重试队列”。批处理中途崩溃后，新 Worker 从持久化游标继续；每条订单仍使用自己的幂等状态机。

任务成功记录与业务更新若在同一个数据库，可以放入同一事务。跨服务后只能保留可恢复证据：业务请求号、已处理游标、远端查询键和待补偿记录。调度器负责再次给它运行机会，业务协议负责判断该继续、跳过还是查询。

## 五、任务抢占要避免长事务和锁扫描

多个 Worker 可以通过数据库领取 READY 任务。直接 `SELECT ... FOR UPDATE` 后在事务里执行业务，会让行锁持续几秒甚至几分钟，连接断开时回滚边界也难以判断。领取事务应很短：选中一批任务，原子写 owner、lease 和 token，立即提交，再在事务外执行。

支持 `SKIP LOCKED` 的数据库可以让 Worker 跳过已被其他事务领取的行：

```sql
BEGIN;
SELECT id
FROM job_instance
WHERE status IN ('READY', 'RETRY')
  AND next_retry_at <= DB_TIMESTAMP
ORDER BY scheduled_at
LIMIT 20
FOR UPDATE SKIP LOCKED;

UPDATE job_instance
SET owner = :worker, status = 'RUNNING', ...
WHERE id IN (...);
COMMIT;
```

`SKIP LOCKED` 解决并发领取时的等待，不负责租约超时、重复副作用或公平性。热点任务长期失败时可能反复占据队首，需要 `next_retry_at`、最大尝试次数和死信状态。领取查询还要有匹配索引，例如 `(status, next_retry_at, scheduled_at)`，否则定时扫描会变成数据库周期性全表压力。

任务量很大时可以用消息队列分发执行，数据库保留任务事实和恢复游标。消息可能重复投递，consumer 仍以 `job_instance_id` 和业务键做幂等；消息确认必须发生在任务结果持久化之后。队列改善吞吐和削峰，没有改变至少一次语义。

## 六、并行任务要定义重叠策略

一次任务运行 90 秒，而 cron 每分钟触发一次，12:02 的实例创建时 12:01 仍在执行。系统必须选择一种策略：

| 策略 | 行为 | 适用情况 |
| --- | --- | --- |
| 禁止重叠 | 新实例等待或跳过 | 全量快照、不可并行维护任务 |
| 合并 | 多个计划点合成一次 | “刷新最新状态”类任务 |
| 排队 | 每个计划点都保留 | 财务批次、必须逐期执行 |
| 并行 | 多实例同时执行 | 分片独立、资源容量充足 |

禁止重叠时，锁的粒度是 `job_name`，任务实例唯一键仍是 `job_name + scheduled_at`。跳过一轮是否算成功必须写进业务定义。库存日结不能因为上一轮慢就悄悄跳过，缓存刷新往往可以只保留最新一轮。

### 分片任务把并发度变成显式配置

扫描一亿行数据不适合由一个 Leader 串行处理。调度器可以为同一计划点创建 N 个 shard：

```text
unique(job_name, scheduled_at, shard_id)
shard_id = hash(business_key) mod N
```

每个 shard 独立租约和重试，Worker 并行领取。分片数决定最大并发度，也影响扩缩容和数据倾斜。若按连续 ID 范围切分，新增数据和热点可能集中在尾部；按哈希更均匀，却不适合范围扫描。还可以动态创建 chunk，但必须持久化边界，避免接管者重新切分后漏数据。

## 七、调度错过与补跑需要明确水位线

调度 Leader 停机十分钟后恢复，系统要决定补齐十个分钟实例、只创建最新一个，还是从业务数据推导待处理项。这个策略通常叫 misfire policy。固定周期报表可能需要逐轮补跑；状态扫描只需从持久化游标继续，补十个空计划点没有价值。

可靠做法是保存调度水位线 `last_generated_at`。新 Leader 读取水位线与当前时间，按 misfire 规则生成缺失实例，再用唯一键提交。不能只依赖进程启动时的“当前 cron 下一次时间”，否则宕机期间的计划点永久消失。

补跑也要限速。十小时积压若瞬间生成 600 个扫描实例，会与在线流量竞争数据库。调度器应为 recovery backlog 设置独立并发和速率上限，优先级也应低于有业务截止时间的实时任务。

## 八、一次续签补偿任务怎样完整运行

假设 `longsign-reconcile` 每分钟扫描结果未知的续签订单，每轮处理创建时间早于 `now - 30s` 的记录，避免与在线请求争抢刚创建的数据。

1. Scheduler Leader 计算 UTC 计划点 `12:01:00`，插入唯一任务实例。若提交响应超时，它查询唯一键确认结果，不换一个计划点重试。
2. Worker A 用 CAS 领取实例，得到 token 41 和 30 秒租约。它每 10 秒续期，并记录本轮水位线上界。
3. A 分批读取 `PROCESSING` 订单。对订单 T1001，它使用原 `trade_order_no` 查询钱包；已扣款便用 `status=PROCESSING AND version=v` 条件推进到 `PAID`。
4. A 更新批次游标后暂停。租约过期，Worker B 领取相同实例并得到 token 42，从已提交游标继续。
5. A 恢复后续约失败，停止读取新批次。即使残留写到达，任务游标存储也会拒绝 token 41；订单状态机和业务号阻止重复扣款或重复推进。
6. B 处理到本轮水位线，确认每条异常订单已有终态或独立重试记录，再用 `owner=B AND token=42` 把任务标为成功。

这里允许 A 和 B 在短窗口内都运行，系统仍能保持正确。调度层减少重复工作，token 保护任务进度，订单幂等保护资金副作用。追求“任意时刻绝无两个线程执行”既难证明，也不是业务正确性的必要条件。

## 九、Leader election 和任务租约是两层协调

Scheduler Leader 决定谁创建计划实例；Worker lease 决定谁执行某个实例。把两者混成一把全局锁会限制吞吐，也会让 Leader 切换中所有运行任务失去身份。调度 Leader 可以切换，已领取的 Worker 继续按各自租约执行。

如果任务规模很小，也可以只保留 Leader election，由 Leader 自己执行所有任务。但长任务会阻塞调度，Leader 退出又使所有工作一起重试。生产调度器通常将控制面和数据面分开：控制面生成、派发和回收；数据面由可横向扩展的 Worker 执行。

Kubernetes 的 client-go Leader election 在续约失败后会结束 leading context，业务循环应监听该 context 并停止。进程退出前主动释放 Lease 可以缩短切换时间，但只有在进程能够确定自己不会继续产生副作用时才安全；崩溃场景仍要等待租约过期。业务不能把 `OnStartedLeading` 当成永久身份。

## 十、故障处理先判断结果是否可证明

Worker 的错误至少分四类：

- 明确未执行，例如参数校验失败或在发送前拿不到连接，可以按策略重试；
- 明确执行失败，例如远端返回可识别的业务拒绝，通常直接记录终态；
- 结果未知，例如调用超时或进程在响应前崩溃，要查询或复用幂等键；
- 本地资格失效，例如续约失败或 token 落后，应停止并由新 owner 接管。

重试次数不能作为正确性边界。三次都超时不代表远端没有执行，第一百次重试也不能修复一个永久参数错误。任务状态需要保存规范化错误码、下一次重试时间和业务查询依据，退避与 jitter 用于控制恢复流量。

对于无法自动判定的任务，应进入 `MANUAL` 或死信队列并报警。人工处理同样要携带业务键和版本条件，不能绕过状态机直接改成成功。

## 十一、怎样观察和验证调度系统

运行指标要同时覆盖计划、领取、执行和业务结果：计划实例创建延迟、misfire 数量、READY 队列年龄、领取冲突、租约续期延迟、过期接管次数、同一任务并发 owner 数、各状态停留时间、重试与 UNKNOWN 数量、幂等命中和 fencing 拒绝次数。

仅看“cron 今天触发了多少次”无法证明任务完成。每类任务应有业务完成指标，例如已处理订单水位线、仍处于 `PROCESSING` 的最老订单年龄、任务输出记录数与源数据差异。调度成功而业务积压上涨，依然是故障。

故障演练要命中协议窗口：

1. 在任务实例插入提交后、响应返回前断开连接，确认唯一键能恢复结果。
2. Worker 产生外部副作用后、更新任务状态前 `kill -9`，确认接管者查询或幂等重试。
3. 暂停 Worker 超过租期，再让它恢复，确认旧 token 被资源端拒绝。
4. 中断 Lease 存储连接，确认现任 owner 在无法续约时停止取新工作。
5. 停止 Scheduler Leader 十分钟，恢复后检查 misfire 和补跑限速。
6. 制造一个持续失败的热点任务，确认不会饿死后续任务或无限占据队首。

测试通过的标准应写成不变量：同一计划槽最多一个任务实例；同一时刻最多一个有效租约；任何低于资源端已见 token 的写都被拒绝；相同业务键不会产生第二次不可逆副作用；满足补跑策略的计划点最终进入成功或可见的人工状态。

## 十二、什么时候不需要自建调度器

单实例工具、允许偶尔漏跑的缓存刷新，用系统 cron 足够。任务已经由消息或业务数据变化驱动时，事件消费通常比周期扫描更及时。Kubernetes CronJob、云任务服务和成熟调度平台已经提供计划生成、并发策略、重试与可观测性，团队没有特殊协议需求时应优先使用。

采用平台也不会消除业务幂等。Kubernetes CronJob 文档明确提醒某些情况下可能创建两个 Job 或没有创建 Job，任务应具备幂等性。托管产品能负责触发与投递，跨数据库和外部 API 的副作用仍由应用协议收敛。

评审一个多机定时任务时，可以按下面顺序提问：计划槽怎样唯一标识；调度中断后哪些槽要补；谁可以领取，租约多久；旧 owner 恢复后谁拒绝它；执行结果未知时如何查询；重试是否复用业务键；任务完成有什么业务证据；积压恢复是否有容量上限。回答清楚这些问题后，“只执行一次”会变成一组可以实现和测试的承诺。

## 参考资料

- [Kubernetes：Leases](https://kubernetes.io/docs/concepts/architecture/leases/)
- [Kubernetes client-go：Leader Election](https://github.com/kubernetes/client-go/blob/master/tools/leaderelection/leaderelection.go)
- [Kubernetes：CronJob limitations](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/#job-creation)
- [Jepsen History：操作的 ok、fail 与 info 语义](https://github.com/jepsen-io/history)
