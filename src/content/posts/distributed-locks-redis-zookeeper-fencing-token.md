---
title: 分布式锁：Redis、ZooKeeper 与 Fencing Token 到底解决什么问题
description: 从多实例定时任务重复执行出发，讲清 Redis 锁的加锁、解锁、续期与故障窗口，以及 ZooKeeper、etcd 和 Fencing Token 怎样阻止过期持有者。
category: 后端
subcategory: 分布式
articleClass: flagship
seriesOrder: 70
publishedAt: 2026-07-21T23:12:00+08:00
tags: [分布式系统, Redis, ZooKeeper, etcd, 分布式锁, Fencing Token, Java]
---

一项“每分钟扫描超时订单”的任务部署在一台机器上时，`synchronized` 足以阻止两个线程同时处理同一批订单。服务扩成三个副本后，每个 JVM 都有自己的锁，也都会启动定时器。同一订单可能被关闭三次、释放三次库存，并发量越大，偶发问题越像随机故障。

分布式锁常被用来收住这类并发。Redis 的 `SET NX PX`、Redisson 的 `RLock`、ZooKeeper 的临时顺序节点都能选出当前持有者，区别在故障后的语义。持有锁的进程可能长时间暂停，租约可能过期，Redis 主节点可能在锁尚未复制时宕机。锁服务已经允许新进程接管，旧进程却仍能继续写数据库。两个进程都曾合法拿到锁，只是它们活在不同时间窗口里。

本文沿着同一个订单扫描任务展开，回答四个问题：Redis 锁怎样正确实现，TTL 和自动续期还留下哪些窗口，ZooKeeper 与 etcd 改善了什么，以及 Fencing Token 为什么需要由真正的业务资源校验。Redis 命令与复制语义以 [Redis 官方分布式锁文档](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)和[复制文档](https://redis.io/docs/latest/manual/replication/)为准；协调服务部分参照 [ZooKeeper Recipes](https://zookeeper.apache.org/doc/r3.8.4/recipes.html) 与 [etcd 3.6 文档](https://etcd.io/docs/v3.6/learning/why/)。

## 先看边界：锁协调执行权，业务系统决定结果是否有效

假设订单 `o-42` 在 10:00 到期，三个应用副本同时扫描到它。我们希望只有一个 Worker 执行关闭订单和释放库存。锁 Key 可以写成 `lock:expire-order:o-42`，成功创建 Key 的 Worker 进入临界区，其他 Worker 跳过或等待。

这个模型成立有两个前提。所有参与者都自觉先取同一个锁；持有者只在锁有效时操作资源。第一项说明它是 advisory lock，也就是协作式锁。绕过客户端直接更新数据库的脚本、另一个没有接入锁的服务、拿错 Key 的代码，都不会被 Redis 自动阻止。第二项在进程暂停和网络分区下更难满足：客户端可能认为自己仍持有锁，也可能根本没有机会检查锁是否已经失效。

因此要分开三层状态：

| 层 | 它知道什么 | 它不知道什么 |
| --- | --- | --- |
| 锁客户端 | 加锁是否返回成功、续期是否收到响应 | 业务写入是否已经提交、旧请求是否还在网络中 |
| 锁服务 | 当前 Key 或节点属于谁、租约是否到期 | 持有者是否仍在运行、数据库是否接受了旧写入 |
| 业务资源 | 订单版本、库存记录、任务 attempt | 调用方是否仍被锁服务视为持有者 |

分布式锁能减少并发执行，不能独自提供“业务效果只发生一次”。订单关闭还需要状态条件，例如 `UPDATE orders SET status='CLOSED' WHERE id=? AND status='PENDING'`；库存释放需要幂等记录或唯一约束；有新旧持有者竞争时，资源端还要比较 Fencing Token。锁把冲突概率和无效工作降下来，业务不变量负责最后一道验收。

### 本地锁、数据库锁和分布式锁保护的范围不同

`synchronized`、`ReentrantLock` 管理一个 JVM 内的线程。数据库行锁管理同一数据库事务中的并发访问，事务结束时释放。分布式锁把“当前执行权”放到所有实例都能访问的协调服务中，适合临界区跨进程、跨机器或持续时间超过单个数据库事务的场景。

范围越大，故障状态越多。数据库行锁随连接和事务释放，资源与锁通常位于同一个数据库；Redis 锁和订单库属于两个系统，加锁成功与更新订单之间没有原子提交；ZooKeeper Session 失效可以删除临时节点，却无法杀掉正在执行 SQL 的旧进程。选择锁之前，先写出它保护的资源、参与者和最终校验点。

## 一个可用的分布式锁需要说明哪些保证

“用了分布式锁”没有描述足够的行为。评审时至少要询问互斥、释放和故障恢复三类保证。

互斥要求同一个资源在约定时间窗口内最多有一个有效持有者。这里的“有效”需要定义：以锁服务中的记录为准，还是以业务资源接受写入的 Token 为准？只看 Redis Key 时，过期旧进程仍可能运行；以 Fencing Token 为准时，旧进程可以继续计算，但不能再提交结果。

释放需要所有权。客户端 A 的锁过期后，客户端 B 可能已经获得新锁。A 恢复后执行无条件 `DEL` 会删除 B 的锁。锁值必须包含本次持有者的唯一标识，释放操作在一个原子步骤中完成“值仍属于我”与“删除”。

故障恢复需要活性。持有者崩溃后，其他客户端最终要能继续工作，所以锁通常带 TTL 或依赖 Session。永久锁能避免因超时出现双持有者，却会在进程崩溃后永久阻塞；有限租约允许接管，也引入旧持有者问题。这个取舍无法靠一个更大的 TTL 消失。

生产实现还要定义以下行为：

- 获取锁最长等待多久，失败后是跳过、排队还是重试；
- 是否可重入，重入计数由线程、进程还是业务请求持有；
- 是否公平，等待最久的客户端是否优先；
- 锁的租约多长，谁负责续期，续期失败后业务代码怎样停止；
- 锁服务故障时选择拒绝工作，还是允许降级并接受并发风险；
- 怎样观测当前 owner、剩余 TTL、等待者和历史 Token。

Safety 和 liveness 往往互相拉扯。要求任何异常下都不出现双持有者，分区时就可能只能停止服务；要求锁服务短暂不可用时任务仍能推进，就要允许某些竞争并靠业务幂等吸收。锁库的默认参数不能替业务决定错误代价。

## Redis 单实例锁的最小正确实现

单个 Redis 实例上的常用获取命令是：

```text
SET lock:expire-order:o-42 7e9b4b9c-... NX PX 30000
```

`NX` 表示 Key 不存在时才写入，完成竞争；`PX 30000` 在同一条命令中设置 30 秒 TTL，避免客户端在创建 Key 后、设置过期时间前崩溃。分成 `SETNX` 和 `EXPIRE` 两条命令会留下永久锁窗口。Value 是每次获取动作生成的随机 owner token，不能只写固定服务名或机器 IP，因为同一进程的两次尝试也需要区分。

Redis 返回 `OK` 只说明这个实例执行了命令。客户端还应记录获取开始时间、返回时间和本地 deadline。若调用在网络中耗费 29 秒，即使 Key 的剩余 TTL 仍由 Redis 计算，留给业务的安全执行窗口已经很小。客户端不能拿到响应后无条件再工作 30 秒。

### 加锁超时也有结果未知

客户端发送 `SET NX PX` 后连接断开，无法仅凭异常判断 Redis 是否已经创建 Key。立即换一个 owner token 重试，可能看到 Key 已存在，却不知道它属于自己的上一次请求，还是另一个竞争者。直接开始业务有并发风险，等待 TTL 全部耗尽又会降低可用性。

同一次逻辑获取应复用 owner token。重连后读取 Key，值与本次 token 相同只能证明记录存在，还要扣除请求耗时，并确认剩余 TTL 足够覆盖下一步。若读取也失败，客户端应放弃进入临界区，稍后按同一业务任务重新竞争。锁获取不是必须“最终成功”的业务写，安全地放弃通常比持续猜测更合适。

释放操作同样可能结果未知。Lua 已经删除 Key，但响应在返回途中丢失；重试脚本会返回 0。这个 0 不能解释成“别人删了我的锁”，只能说明当前已经找不到匹配 owner。业务代码在 `finally` 中记录解锁 attempt 即可，不应因为解锁响应缺失重新执行临界区。

锁服务还要限制请求排队。Redis 客户端连接池耗尽时，加锁请求可能在本地等了很久才发出；应用看到的是一次慢 Redis 调用，实际上租约尚未开始。分别记录连接池等待、命令往返和成功后的剩余 TTL，才能判断时间花在了哪里。

### Key 设计决定锁的粒度

`lock:expire-orders` 会让所有过期订单串行处理，正确但吞吐很低；`lock:expire-order:{orderId}` 允许不同订单并行，只协调同一订单。粒度过粗形成热点，持有者故障会阻塞大量无关工作；粒度过细则可能保护不了跨资源不变量。例如一次批量转移需要同时修改两个账户，只锁单个账户仍可能与另一笔转移交错。

多资源锁还会引入死锁。任务 A 先锁订单再锁库存，任务 B 先锁库存再锁订单，双方都等待对方释放。可以统一资源排序后依次获取，使用带总 deadline 的 try-lock，并在部分失败时释放已经获得的锁。Redis MultiLock 把多个 Key 包装成一个 API，也无法消除资源排序、部分获取和租约同时到期的推理成本。

Key 必须包含租户和业务作用域。`lock:order:42` 在多租户系统中可能让两个租户无故互斥；只使用用户输入拼接 Key 还会造成命名碰撞和超长 Key。建议让服务端根据结构化资源标识生成固定格式，并对资源类型、租户和 ID 做编码。日志保留可读资源名，Redis Key 可以使用稳定哈希控制长度。

锁粒度还会影响 Fencing Token。按订单发出的 Token 只需在同一订单内单调；一个全局粗锁则需要全局序列。设计时先画出业务不变量涉及的资源集合，再决定锁和 Token 的作用域，不能从已有 Redis Key 命名反推业务边界。

### 解锁为什么必须比较 owner

释放锁需要比较并删除成为一个原子操作。Redis 8.4 增加了带条件的 `DELEX`；更早版本通常使用 Lua：

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
```

先 `GET`、再由客户端判断、最后 `DEL` 仍有竞态。两条命令之间锁可能到期并被 B 重建，A 随后的 `DEL` 就会删掉 B 的锁。Lua 脚本在 Redis 内原子执行，只有 Value 仍等于 A 的随机 token 才删除。

解锁返回 0 也不是可以忽略的“小异常”。它说明锁已经到期、被淘汰、被其他流程删除，或当前线程使用了错误 owner。此时临界区的操作可能已经越过租约边界，需要记录业务资源、owner、开始时间和当前 Token，用于判断有没有两个持有者交叠。

### 续期同样要校验 owner

长任务无法预先给出准确执行时间时，客户端会定期续期。续期脚本只允许当前 owner 延长 TTL：

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
```

续期频率必须给网络抖动和调度停顿留下余量。30 秒租约等到第 29 秒才续期，任意一次短暂停顿都可能让锁先过期；每 10 秒续期更常见，但它不是固定答案。频率越高，Redis 写流量越大；租约越长，崩溃后接管越慢。应基于业务耗时分布、可接受接管时间和基础设施尾延迟选择。

续期失败后的代码路径比续期成功更重要。Watchdog 线程发现 owner 不匹配或 Redis 持续不可达后，应设置取消标记，阻止任务开始新的不可逆步骤。正在执行的 JDBC 提交、已经发送到第三方的请求无法被瞬间撤回，所以资源端校验仍然必要。

## Redisson 把哪些细节封装起来了

Java 项目通常不会手写 Lua，而会使用 Redisson 的 `RLock`。它提供 `java.util.concurrent.locks.Lock` 风格的 API、可重入计数、等待通知和 Watchdog。一个简化用法是：

```java
RLock lock = redisson.getLock("lock:expire-order:" + orderId);
boolean acquired = lock.tryLock(200, 30, TimeUnit.MILLISECONDS);
if (!acquired) {
    return;
}

try {
    closeExpiredOrder(orderId);
} finally {
    if (lock.isHeldByCurrentThread()) {
        lock.unlock();
    }
}
```

显式传入 `leaseTime` 时，锁到期后自动释放。没有指定固定租期的模式下，Redisson Watchdog 会在客户端存活期间延长锁的过期时间；[Redisson 文档](https://redisson.pro/docs/data-and-services/locks-and-synchronizers/)给出的默认 Watchdog 超时为 30 秒，并允许通过 `lockWatchdogTimeout` 调整。

Watchdog 解决了“业务正常运行但偶尔超过初始 TTL”的问题。它无法覆盖进程长时间 Stop-the-world、宿主机被冻结、续期线程池饥饿、Redis 网络分区或客户端自身失去调度。进程恢复时，Java 调用栈仍停在临界区内部；新 owner 可能已经工作了一段时间。

### 可重入和公平性不是免费的

可重入锁需要记录 owner 线程和重入次数。同一线程第二次获取时增加计数，只有相同次数的 `unlock` 才真正删除锁。异步任务在线程池间切换时，线程身份不再等于业务身份；把 `RLock` 跨线程释放可能直接失败。响应式链路、协程和消息消费更适合显式传递 attempt ID，而不是依赖线程本地语义。

公平锁维护等待顺序，能减少某个客户端长期抢不到锁，但会增加状态和等待开销。短任务、大量竞争者更需要控制惊群和退避；长任务通常应改为队列或任务所有权模型。Spin Lock 用轮询和 backoff 换掉每个锁的 Pub/Sub 订阅，也会在竞争激烈时产生额外请求。锁类型应从等待规模与公平要求选择，不应因为 API 列表里存在就全部启用。

### tryLock 的等待时间和租约时间是两件事

`waitTime` 限制客户端愿意等多久，`leaseTime` 限制拿到锁后占用多久。把两者都设置成一个“经验值”容易制造反直觉行为：请求 deadline 只有 500 毫秒，锁却等待 5 秒；任务 p99 为 40 秒，锁租约只有 30 秒；失败重试没有随机退避，几十个实例每隔固定 100 毫秒同时冲击 Redis。

入口 deadline 应向锁等待传播。拿锁已经消耗大部分预算时，任务可以放弃而不是刚进入临界区就超时。后台任务没有用户请求 deadline，也要有调度周期和接管 SLO，避免上一轮还在排队，下一轮又创建一批等待者。

### 竞争失败后的退避也是协议的一部分

所有实例以固定间隔重试，会在锁释放瞬间一起请求 Redis，失败者再同步睡眠，形成周期性尖峰。应使用指数退避和 jitter 打散重试，并设置最大等待者数量。定时任务若下一轮很快到来，当前轮抢锁失败后直接跳过通常比排队更合理；用户请求则可以快速返回“处理中”，由状态查询确认结果。

公平性与吞吐也会冲突。普通 Redis 锁中，刚到达的客户端可能抢在等待很久的客户端前面；强制 FIFO 需要维护队列并处理离线等待者。批处理任务通常不关心哪台机器获胜，只关心最终有人处理，没必要支付公平锁成本。配额分配、租户调度等确实需要公平时，应该把队列位置和取消语义作为一等状态，而不是在无限重试上模拟排队。

竞争指标要按资源聚合。全局平均等待 5 毫秒可能掩盖某个热门账户持续等待数秒。对 Top-K 热锁记录获取次数、失败比例、持有时长和等待者数量，再检查是否能拆分资源、缩短临界区或改用分区队列。盲目扩容 Redis 只提高命令处理能力，无法让同一把互斥锁并行。

## TTL 到期后，旧持有者并不会自动停止

这个时间线展示最常见的安全窗口。Worker A 拿到 30 秒租约后发生 40 秒暂停；锁在第 30 秒过期，Worker B 获得新锁并提交；A 恢复后仍沿着原调用栈写数据库。

![Redis 锁过期后旧 Worker 与新 Worker 的执行时间线](/images/posts/distributed-lock-stale-owner-timeline.svg)

从 Redis 的视角，两个持有者没有同时拥有同一个 Key。A 的租约先结束，B 才成功 `SET NX`。从数据库的视角，两次写入可能交叠，因为 A 的进程不会随 Key 到期而终止。这也是“锁服务保证互斥”和“资源只接受当前 owner”之间的差别。

### 进程暂停比崩溃更棘手

进程彻底崩溃后不会继续提交副作用，TTL 只需让其他实例最终接管。暂停会保留内存、线程栈、数据库连接和待发送请求。暂停来源包括 Full GC、虚拟机挂起、容器 CPU 长时间饥饿、调试器断点、磁盘或网络调用卡住。应用无法给这些停顿统一设置可靠上界。

客户端在每次写入前查询 Redis，仍然关不住窗口：检查返回“仍持有锁”之后，线程可能再次暂停；恢复后写请求继续发出。把检查和资源写入放到同一个原子事务才有确定性，而 Redis 与业务数据库通常做不到跨系统原子提交。Fencing Token 把检查移到资源自己的写入条件中。

取消线程也只能改善资源消耗。Java interrupt 需要被业务代码和依赖库配合处理；已经提交的数据库事务不会回滚，第三方 HTTP 服务也可能已经收到请求。租约失效后要停止新步骤，同时仍按结果未知处理已经发出的步骤。

## Redis 锁还会在哪些地方失效

TTL 超时只是其中一条路径。部署拓扑、内存策略、持久化和错误处理都会改变锁的保证。

### 主从切换可能丢失刚写入的锁

Redis 默认异步复制。A 在主节点创建锁，主节点返回成功，但在命令复制到从节点之前宕机；从节点被提升为新主后没有该 Key，B 因此成功获取同一把锁。A 如果仍在执行，就出现两个持有者。[Redis 官方分布式锁文档](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)直接列出了这个 safety violation。

`WAIT numreplicas timeout` 可以等待指定数量的副本确认此前写入，缩小故障窗口。[Redis 复制文档](https://redis.io/docs/latest/manual/replication/)同时说明，`WAIT` 不会把 Redis 变成强一致 CP 系统；故障切换选择、持久化配置和多个节点同时失效仍可能丢失已经确认的写。它提高数据留存概率，不能替代资源端拒绝旧 owner。

Redisson 提供锁复制同步检查。启用后会等待锁到达已连接副本，超时则释放并让获取失败。这项机制比主节点一确认就返回更谨慎，但其保证仍依赖实际拓扑、需要确认的副本数量、持久化和故障切换策略。评审不能只看到 `RLock` 类型名，还要查看客户端与 Redis 集群配置。

### 淘汰策略可能提前删除锁

锁 Key 带 TTL，因此 `volatile-lru`、`volatile-lfu`、`volatile-random` 和 `volatile-ttl` 都可能把它选为淘汰对象；`allkeys-*` 同样可能删除它。Redis [Key eviction 文档](https://redis.io/docs/latest/develop/reference/eviction/)列出的 `noeviction` 会在达到上限后拒绝可能增加内存的写命令，才不会因淘汰策略主动删除已有锁。

锁与可重建缓存不应共享一个允许淘汰的实例。分到不同逻辑 DB 没有用，它们仍共享内存上限和淘汰策略。独立锁实例使用 `noeviction`，还要为连接、复制缓冲、AOF 和内存碎片留出余量，并监控 `evicted_keys`。这部分故障链在《[Redis 批量读取为何会触发 Key 淘汰](/posts/redis-read-trigger-key-eviction/)》中有更完整的内存分析。

### 持久化和重启决定锁会不会倒退

RDB 是时间点快照，AOF 按策略记录写命令；关闭持久化时，实例重启会丢失全部锁状态。锁本身是短租约，很多场景可以接受重启后重新竞争，但旧客户端仍可能执行。若系统依赖单调 Token，Token 状态的持久化要求高于普通临时 Key，重启后计数器不能回退。

Redis 的 [persistence 文档](https://redis.io/docs/latest/management/persistence/)说明 RDB 可能丢失最近一段写入，AOF 的风险取决于 fsync 策略。把锁写进磁盘不能阻止暂停客户端；它解决重启后的状态恢复，是另一层问题。锁、租约和 Fencing Token 可以存储在同一产品中，但三者的持久性要求不同。

### 时钟跳变会影响绝对过期时间

Redis 保存过期时间为绝对 Unix 时间戳，并依赖服务器时钟判断到期。[EXPIRE 文档](https://redis.io/docs/latest/commands/expire/)提醒，时钟大幅向前跳可能让 Key 立即过期。NTP、虚拟化环境和人工改时都需要受控。客户端还应使用单调时钟计算本地耗时，避免墙上时钟回拨让“剩余租约”变长。

时钟配置能减少意外，无法形成跨系统的共同真相。数据库不会因为 Redis 的时钟认为租约过期，就自动拒绝某条已经在路上的 SQL。资源端版本比较不依赖两个进程读到相同物理时间，更适合做最终裁决。

### Redis Cluster 改变路由，不会升级锁语义

Redis Cluster 将 Key 映射到 16384 个 hash slot，每个 slot 由一个主节点负责。单 Key 锁仍落在一个 slot 和一个主从复制组上，因此集群规模增大不会让这把锁自动获得多数派共识；对应主节点切换时仍要分析异步复制窗口。

单个 Lua 脚本访问多个 Key 时，这些 Key 必须位于同一 slot。[Redis Cluster 规范](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)允许使用 hash tag，把花括号中的内容作为路由部分。例如 `lock:{order-42}` 与 `fence:{order-42}` 会进入同一 slot，可以在一个脚本中创建锁并递增该资源的 Token。若 Key 分属不同 slot，脚本会遇到 `CROSSSLOT`，不能靠客户端连续执行两条命令声称原子性。

把所有 Key 都写成 `{locks}:...` 虽然方便多 Key 操作，却会把全部锁集中到一个 slot，失去集群分片能力。Hash tag 应与真正需要原子操作的资源范围一致。多数场景只需单 Key owner 记录；Token 可以由数据库版本或协调服务 revision 提供，不必为了一个全局计数器制造 Redis 热点。

扩容迁移期间，客户端可能收到 `MOVED` 或 `TRYAGAIN`。成熟客户端会更新 slot 路由并在 deadline 内重试，但写请求仍可能进入结果未知。集群客户端的自动重试不能绕开 owner token，也不能把暂时路由错误解释为锁没有创建。

## Redlock 提高了什么保证，又依赖哪些假设

Redlock 不使用一个主节点和它的异步副本，而是在 N 个相互独立的 Redis Master 上竞争同一个资源。官方示例取 N=5。客户端并行向各节点写入相同随机值，只有在租约时间内拿到至少三个节点才认为成功；实际有效期还要扣除获取所消耗的时间与时钟漂移余量。失败时客户端尝试清理所有节点上的部分锁。

多数派集合必然相交，所以在大多数 Key 同时有效的窗口内，另一个客户端不能再从多数节点获得 `SET NX`。独立节点也避免了单主异步复制的直接失锁窗口。获取超时要远小于总租约，失败重试加入随机延迟，续期也必须在有效期内得到多数节点确认。

代价是部署和推理复杂度。五个节点需要尽量独立的故障域；客户端要处理部分成功、清理失败、节点恢复后仍保存旧 Key、时钟变化和网络分区。可用性还受 TTL 影响：部分锁无法清理时，其他客户端只能等它们到期。

### 节点重启和残留 Key 影响下一轮多数派

一个 Redlock 节点崩溃后立刻以空数据重启，会忘记尚未到期的锁。若多个节点在一个租约窗口内依次重启，新的客户端可能从已经失忆的节点组成新多数派。开启持久化可以减少失忆，仍要结合 fsync 策略分析断电窗口。另一种做法是让故障节点延迟重新加入，等待时间超过可能存在的最长锁有效期，代价是恢复期间少一个可用节点。

部分获取失败也会留下残余 Key。客户端必须向所有节点发送释放请求，包括它认为写入失败的节点，因为失败可能只是响应丢失。网络分区阻止清理时，这些 Key 会一直占到 TTL 结束，后续竞争可能暂时凑不出多数派。这个可用性损失是有限租约换取安全窗口的结果。

节点独立性也要真实成立。五个 Redis 进程如果位于同一宿主机、共享同一个电源或依赖同一控制面，故障并不独立；一次暂停或错误自动化可能同时影响多数节点。Redlock 的 N 是协议角色数，不是简单的进程数。部署评审要列出机器、可用区、时钟源、网络和运维动作的共同故障域。

这些细节解释了为什么 Redlock 不适合作为“把一个 Redis 换成五个”即可完成的配置升级。它是一套客户端协议和部署假设。团队若没有相应的故障测试能力，使用共识协调服务或直接把正确性放到数据库条件写中，通常更容易形成可验证证据。

### Redlock 争议应该怎样落到工程选择

Martin Kleppmann 在《[How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)》中指出，进程暂停、消息延迟和时钟假设会让仅凭租约的正确性难以成立，并提出用单调 Fencing Token 保护资源。Redis 官方文档保留了 Redlock 的安全论证，也在一致性说明中明确建议实现 Fencing Token，提醒 TTL 过期依赖时钟。

这场讨论对业务开发者的实用结论不是背下一句“Redlock 安全”或“不安全”。先确定锁的用途：

| 用途 | 失败后果 | 合理策略 |
| --- | --- | --- |
| 防止缓存击穿时重复回源 | 多做几次查询，增加负载 | 单实例 Redis 锁通常已经够用，配合超时和兜底 |
| 避免重复发送低价值通知 | 用户可能收到两次 | Redis 锁加业务幂等，按风险选择复制确认 |
| 控制订单、库存、支付写入 | 可能破坏业务不变量 | 资源端条件写、幂等与 Fencing Token，锁只做协调 |
| 选举长期 Leader | 双 Leader 会持续产生冲突 | 使用共识协调服务与 epoch，工作结果仍校验任期 |

正确性依赖锁时，需要证明旧持有者无法写资源。Redlock 可以减少同时获得租约的概率，却不向外部数据库自动提供可验证的顺序。若资源不能校验 Token，又无法容忍双执行，系统设计本身缺少最后的强制边界。

## Fencing Token 怎样挡住恢复后的旧持有者

Fencing Token 是每次获得执行权时生成的单调递增编号。A 获得 Token 41 后暂停，租约到期；B 获得 Token 42，并把它随写请求提交给订单库；A 恢复后携带 41 写入，资源看到它小于已经接受的 42，拒绝旧请求。

![Fencing Token 在资源端拒绝旧持有者](/images/posts/distributed-lock-fencing-flow.svg)

随机 owner token 和 Fencing Token 作用不同。随机值证明“释放锁的人仍是创建这条锁记录的人”，适合 compare-and-delete；Fencing Token 建立新旧顺序，让资源判断哪个持有者已经过期。UUID 很难回答 41 与 42 谁更新，因此不能直接充当 fence。

### 校验必须发生在真正产生副作用的地方

订单表可以保存 `last_fence`：

```sql
UPDATE orders
SET status = 'CLOSED',
    last_fence = :token,
    updated_at = NOW()
WHERE id = :order_id
  AND status = 'PENDING'
  AND last_fence < :token;
```

受影响行数为 1 才表示提交成功。Token 41 在 Token 42 之后到达时，`last_fence < 41` 不成立。状态条件还会阻止已经支付的订单被关闭。两个条件分别保护持有者顺序和业务状态，不能互相替代。

对象存储、第三方支付或邮件服务未必提供自定义版本条件。此时可以在自己的权威数据库先写 intent 和最大 Token，再由 Outbox 发送幂等命令；也可以把不可校验的副作用设计成天然幂等。若下游既不支持幂等，也不接受版本，锁只能降低重复概率，接口契约中要承认这一限制。

### Token 的作用域和持久化需要明确

全局自增序列最容易比较，却可能成为热点。多数业务只需按资源或分区单调：订单 `o-42` 的 Token 不能拿来和订单 `o-99` 比较。ZooKeeper 顺序节点、etcd revision、数据库序列、任务表 version 都可以提供某种顺序，但必须确认它在故障恢复后不会回退，并且覆盖受保护资源的作用域。

资源端通常接受 `token >= last_fence` 还是 `token > last_fence`，取决于同一持有者是否允许重试。若同一次 attempt 的数据库写可能因响应丢失而重放，允许相等 Token 并配合幂等 operation ID 更合适；新持有者必须严格更大。Token 解决 owner 顺序，operation ID 解决同一 owner 的重复请求。

Redisson 提供 `RFencedLock`，获取锁时返回单调 Token；[官方文档](https://redisson.pro/docs/data-and-services/locks-and-synchronizers/)同样要求受保护的存储检查 Token。只把 `RLock` 换成 `RFencedLock`，但没有把 Token 传到 SQL 或下游接口，系统的业务语义没有变化。

### 生成 Token 与获得执行权要属于同一次状态迁移

先获取普通锁，再单独执行 `INCR fence:order-42`，中间任何超时都会让客户端难以判断自己是否拥有与 Token 对应的任期。更稳妥的接口一次返回 owner、lease deadline 和 fence，并把三者作为同一条协调记录提交。ZooKeeper 节点序号、etcd revision 和数据库 `attempt = attempt + 1` 都具备这种结构。

Redis Cluster 中可以让锁 Key 与计数器使用相同 hash tag，在一个 Lua 脚本中完成 `SET NX` 与 `INCR`。脚本成功但响应丢失时，客户端仍需用 owner token 查询本次结果，不能重新获取并猜测计数。计数器还要配置比租约更强的持久化；锁 Key 可以到期消失，已经发出的 Token 不能在重启后回退到更小值。

Token 不要求连续。获取失败、客户端崩溃或事务回滚都可能留下空洞，资源只关心严格递增。试图回收未使用编号会重新引入并发协调。监控可以检查倒退和异常跳跃，但业务逻辑不应假设第 42 个 Token 前面一定有 41 次成功写入。

批量资源操作还要决定比较规则。一个任务携带全局 fence 写入十个对象，资源可以分别保存最大值；若只成功更新五个后崩溃，接管者用更大 Token继续处理剩余对象。已经接受旧 Token 的对象也允许更大 Token 推进，任务状态机和幂等记录负责避免重复副作用。Fencing 解决新旧 owner 排序，不会自动提供跨对象事务。

## ZooKeeper 和 etcd 改善的是协调顺序

ZooKeeper 常用临时顺序节点实现锁。客户端在锁目录下创建 `EPHEMERAL_SEQUENTIAL` 节点，编号最小者成为持有者；其他客户端只 Watch 紧邻自己的前驱节点，前驱删除后重新检查。Session 失效时临时节点会被服务端删除，不依赖客户端主动解锁。

```text
/locks/order-42/
  contender-0000000041   <- 当前持有者
  contender-0000000042   <- 监听 41
  contender-0000000043   <- 监听 42
```

只监听前驱避免所有等待者同时被唤醒的 herd effect，也自然提供排队顺序。ZooKeeper 对更新建立全局顺序，节点序号或版本可用于派生 Fencing Token。它仍有“创建成功但响应丢失”的 UNKNOWN 窗口，官方 Recipes 使用 GUID 帮助客户端重连后识别自己创建的节点。

Session 过期也不能停止旧进程。客户端与 ZooKeeper 失联后，服务端经过超时删除临时节点并允许下一个客户端接管；旧客户端可能还在本地暂停。ZooKeeper 改善了锁记录的一致性和顺序，不会替外部数据库检查旧写入。

etcd 的 Lock API 基于 Lease。Key 附着 Lease，TTL 到期后服务端撤销；更新可以通过 revision、Lease ID 和事务条件进行 compare-and-swap。etcd 官方在[与其他 KV 的比较](https://etcd.io/docs/v3.6/learning/why/)中直接说明：物理时间租约本身不能独自保证外部资源互斥，服务端可能已经撤销 Lease，而客户端仍认为自己拥有它。访问 etcd 内部 Key 时可以用 revision 条件保护；访问外部系统时仍需把顺序凭证传出去。

### Redis、ZooKeeper 与 etcd 不是简单的性能排名

Redis API 简单、延迟低，团队通常已有运维经验，适合效率型协调和能容忍偶发重复的场景。ZooKeeper 和 etcd 通过共识维护协调状态，提供更清晰的 Session、revision 和顺序语义，适合 Leader 选举、配置和任务所有权；它们的部署、容量和客户端会话管理也更重。

选择时关注需要的语义：是否要求公平排队，是否需要可验证的递增版本，锁服务分区时能否停止业务，等待者规模多大，团队是否能正确运维共识集群。产品名不能替代这些答案。

## 很多场景不需要分布式锁

锁容易成为默认答案，因为它把并发代码包装成“先获取、再执行、最后释放”。然而不少业务已有更靠近资源的原子能力，直接使用它们更容易证明正确性。

### 数据库约束通常比外部锁更接近事实

防止重复创建订单，可以给 `(tenant_id, idempotency_key)` 建唯一索引；抢占待处理任务，可以执行带状态条件的 `UPDATE`；库存扣减可以要求 `available >= amount`；并发编辑可以比较 `version`。这些检查和数据更新发生在同一个数据库事务中，没有 Redis 成功而 SQL 失败的跨系统窗口。

```sql
UPDATE jobs
SET owner = :worker_id,
    attempt = attempt + 1,
    lease_until = :deadline
WHERE id = :job_id
  AND status = 'READY';
```

只有受影响行数为 1 的 Worker 获得任务。任务执行时间很长时仍需 lease、attempt 和接管逻辑，但不一定需要额外 Redis 锁。数据库是权威状态源，抢占和状态迁移可以一并提交。

### 队列、分区和 Actor 可以消除竞争入口

消息队列按业务 Key 分区后，同一订单的消息由一个分区顺序处理；消费者组负责实例间分配。Actor 模型把资源状态归属一个执行单元。Single-flight 只协调同一进程中的重复请求，适合缓存回源。它们把并发约束放到调度模型中，避免每次业务操作都单独竞争锁。

队列仍可能重复投递，消费者仍要幂等；分区重平衡期间旧消费者可能继续处理；Actor 迁移也需要 epoch。这些方案没有消灭分布式故障，但会让“谁负责什么”更稳定，减少高频锁竞争。

### 锁不能替代幂等和事务

获取锁后进程可能在业务提交之后、释放锁之前崩溃。新持有者接管时会再次执行；如果操作不幂等，锁无法判断上一任做到了哪一步。跨订单库与库存库的操作也不会因为外面包了一把锁就具有原子性，仍要使用本地事务、Outbox、Saga 或对账。

一个实用判断顺序是：先尝试唯一约束和条件写，再考虑把同一 Key 的动作串行化，同时让副作用幂等；只有需要跨进程协调昂贵或不可并发的工作时，再增加分布式锁。即使使用锁，前三项通常仍保留。

## Agent Worker 是典型的租约与 Fence 场景

长时间 Agent 任务很少能在固定 TTL 内稳定完成。多个 Worker 从队列领取任务，某个 Worker 在调用模型、浏览器或代码执行环境时失联，Scheduler 必须允许新 Worker 接管。若只使用 `task:{id}` Redis 锁，旧 Worker 恢复后可能继续调用工具、写共享文件或提交最终答案。

更完整的任务记录包含：

```text
task_id       = task-91          # 逻辑任务
attempt_id    = attempt-4        # 本次尝试
lease_owner   = worker-b
lease_until   = 10:03:30
fence         = 57
state         = RUNNING
checkpoint    = step-12
```

接管时事务地增加 `fence` 并创建新 `attempt_id`。模型调用可以继续完成，但保存 checkpoint、合并代码或写最终结果时必须携带 57；旧 attempt 的 56 被状态库拒绝。外部工具调用再使用稳定 idempotency key，避免接管重放导致重复发消息或重复部署。

锁只覆盖任务所有权，不适合包住整个 Agent 上下文。Worker 应周期性保存 checkpoint，在失去租约后停止启动新工具调用；已经发出的调用进入 UNKNOWN，由幂等键或查询接口确认。共享文件还要依赖版本、分支或独立工作目录，不能因为持有任务锁就无条件覆盖用户的新修改。

这种设计同样适用于视频转码、批量导入和工作流引擎。长任务的正确模型通常是“可过期所有权 + 可恢复状态 + 旧结果拒绝”，不是把 Redis TTL 设置成几个小时然后祈祷进程不会停顿。

## 怎样观察和验证一把分布式锁

平均加锁成功率不足以说明安全性。监控至少要区分逻辑资源、获取 attempt、owner 和 fence，并记录：

- 获取等待时间、成功率、超时与重试次数；
- 当前 TTL、续期耗时、续期失败原因；
- 锁持有时长与业务执行时长的分位数；
- 解锁时 owner 不匹配的次数；
- Redis 主从切换、复制确认失败和 `evicted_keys`；
- 资源端拒绝 stale fence 的数量；
- 同一业务 Key 同时运行的 attempt 数；
- 锁已丢失但任务仍继续工作的持续时间。

高竞争锁需要单独报警。大量等待者可能说明锁粒度太粗，例如所有订单共用 `lock:orders`；也可能说明临界区中包含慢 I/O。日志应能回答谁持有、何时获取、续期到何时、谁接管、哪个 Token 被资源拒绝。只打印“获取锁失败”无法重建事故。

### 故障注入要命中租约边界

普通并发测试只能证明顺利运行时 `SET NX` 有效。更有价值的测试会控制时间点：

1. A 获取锁并停在数据库提交前；
2. 暂停 A，等待 TTL 到期；
3. 让 B 获取新锁并提交更大 Token；
4. 恢复 A，确认数据库拒绝旧 Token；
5. 检查 A 的解锁不会删除 B 的锁。

还要覆盖获取成功但响应丢失、续期响应丢失、Redis 主节点在复制前退出、锁 Key 被内存策略淘汰、ZooKeeper Session 过期、客户端时钟跳变和网络单向中断。每个测试都验证业务不变量，而不是只看锁库日志。

测试结束后的最终数据库状态也不够。若 A 和 B 都成功调用过不可逆外部 API，后来补偿成相同终态，重复副作用已经发生。记录 invocation、completion、operation ID、attempt 和 fence，才能判断执行历史是否合法。

## 选型时先判断错误代价

选型可以从错误代价开始：

| 问题 | 首选机制 | 分布式锁的位置 |
| --- | --- | --- |
| 防止同一请求重复创建记录 | 唯一索引、幂等键 | 通常不需要 |
| 多实例缓存回源 | Single-flight + Redis 短锁 | 降低重复计算，允许偶发双执行 |
| 定时任务只希望一台实例扫描 | Scheduler/租约/数据库抢占 | 协调扫描者，任务本身仍幂等 |
| 更新订单或库存 | 条件更新、事务、版本号 | 减少竞争，不能作为最终正确性依据 |
| Leader 选举 | ZooKeeper/etcd/共识系统 | 用 Session 和 epoch 管理任期 |
| 长任务接管 | Lease + checkpoint + fence | 控制当前 owner，拒绝旧结果 |
| 调用不支持幂等的第三方 | 对账、业务唯一号、人工恢复 | 只能降低重复概率，无法给出绝对保证 |

如果一次双执行只会多做一遍可丢弃计算，Redis 单实例锁通常足够。若双执行会造成重复扣款、资源损坏或权限越界，资源端必须参与校验，锁服务分区时通常选择停止写入。高风险场景的复杂度来自业务后果，不是来自某个锁库的 API 数量。

## 上线前检查清单

1. 锁保护的业务资源是什么，Key 是否精确到正确作用域？
2. 所有写入者都会经过这套协议吗，有没有脚本或旧服务绕过？
3. 获取等待是否受入口 deadline 限制，失败后会不会形成固定频率重试风暴？
4. TTL 根据什么数据确定，任务超过 TTL 或 Watchdog 停止时会发生什么？
5. Value 是否唯一标识一次获取，解锁和续期是否原子校验 owner？
6. Redis 是否与可淘汰缓存隔离，`maxmemory-policy` 和持久化怎样配置？
7. 主从切换可能丢锁吗，客户端是否等待复制，业务能否接受剩余窗口？
8. 旧持有者恢复后，真正的资源会检查 Fencing Token 吗？
9. Token 的作用域、递增来源和重启持久化是否明确？
10. 同一 attempt 的重复请求怎样幂等，不同 attempt 的旧结果怎样拒绝？
11. 是否可以用唯一约束、条件更新、队列分区或任务表替代外部锁？
12. 故障测试是否覆盖暂停、过期、接管、旧进程恢复和主从切换？

分布式锁适合回答“当前由谁尝试工作”。业务系统还要回答“这次结果是否仍然有效”。Redis 的 `SET NX PX` 与 owner 校验构成实用的短租约；Watchdog 延长正常任务的执行窗口；ZooKeeper 和 etcd 提供更清晰的顺序与会话语义。旧进程能在租约结束后恢复，因此高风险资源仍需版本条件、幂等和 Fencing Token。

## 参考资料

- Redis, [Distributed Locks with Redis](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
- Redis, [SET](https://redis.io/docs/latest/commands/set/)
- Redis, [Replication](https://redis.io/docs/latest/manual/replication/)
- Redis, [Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)
- Redis, [Persistence](https://redis.io/docs/latest/management/persistence/)
- Redisson, [Locks and synchronizers](https://redisson.pro/docs/data-and-services/locks-and-synchronizers/)
- Apache ZooKeeper, [Recipes and Solutions](https://zookeeper.apache.org/doc/r3.8.4/recipes.html)
- etcd, [Why etcd?](https://etcd.io/docs/v3.6/learning/why/)
- Martin Kleppmann, [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- Cary G. Gray, David R. Cheriton, [Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency](https://www.cs.cmu.edu/afs/cs.cmu.edu/academic/class/15712-s12/www/papers/gray89.pdf)
