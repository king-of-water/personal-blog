---
title: 只读请求为什么也会触发 Redis Key 淘汰
description: 从一次本地缓存重建异常出发，拆解 Pipeline、客户端输出缓冲区、maxmemory 与淘汰策略之间的连锁反应。
category: 系统工程
subcategory: Redis
featured: true
publishedAt: 2026-09-30
tags: [Redis, 缓存, 稳定性, Java, 故障排查]
---

Redis 里的 Key 突然少了，很多人的第一反应是 TTL 写错、同步任务漏数据，或者某段代码执行了删除。还有一种更绕的情况：数据写入完全正常，过期时间也正确，一批看起来只读的请求却让 Redis 开始淘汰 Key。

读请求不会直接修改 Value，但 Redis 为返回数据分配的客户端输出缓冲区同样占内存。大批量 Pipeline 与并发缓存重建叠加时，回复产生速度可能超过客户端读取速度，缓冲区持续增长。实例接近 `maxmemory` 后，配置的淘汰策略便可能删除数据集中的 Key。

本文用一个合成场景复盘完整的排查路径。示例里的数据量、实例数、Key 和时间均为演示值，不对应任何真实业务或生产环境。

## 一、问题从本地缓存少了数据开始

假设一个 API 服务需要在本地维护一份用户集合。离线任务每天生成最新快照，同步程序把数据拆进数百个 Redis Set，再通知所有 API 实例重建本地缓存。

流程大致如下：

```text
离线数据源
    ↓
同步任务写入 Redis Set
    ↓
更新快照版本
    ↓
多个 API 实例收到通知
    ↓
批量读取全部 Set，重建本地缓存
```

为了防止当天快照尚未生成，读取端会同时加载今天和昨天的数据，最后取并集。这个设计本身合理：新快照失败时，旧快照还能兜底。

一次发布后的第二天，监控显示本地缓存元素量从预期值突然降到三分之一。重建没有整体失败，接口仍能工作，只是缓存内容明显不完整。

这类问题麻烦在于症状出现在链路末端。缓存变小可能来自上游少产数据、同步任务漏写、Redis 丢 Key、读取失败，或者本地合并逻辑错误。若从代码末端开始逐行看，很容易耗掉几个小时。

## 二、按证据逐层排除

### 1. 数据源有没有少

先核对离线任务的输出记录数、去重后的主键数和分区时间。只看任务状态“成功”不够，成功可能意味着程序正常退出，不代表产物数量正确。

假设数据源数量和前几天一致，抽样内容也正常，那么问题位于同步或读取链路。

### 2. 写入 Redis 的命令有没有完整执行

同步任务应记录每个批次的输入数、成功响应数、失败数和目标快照版本。如果只打印“任务结束”，很难区分提交了多少命令，以及服务端实际确认了多少。

在合成场景中，所有 `SADD` 都返回成功，每个 Set 的成员数量也大致符合预期。写入阶段暂时没有异常证据。

### 3. TTL 是否符合设计

对缺失 Key 执行 `TTL`：

```text
TTL snapshot:2026-09-30:42
```

Redis 的常见返回含义是：

| 返回值 | 含义 |
| ---: | --- |
| 大于等于 0 | 剩余生存时间 |
| `-1` | Key 存在，但没有过期时间 |
| `-2` | Key 不存在 |

如果业务设置了几天 TTL，Key 却在写入后十几分钟就返回 `-2`，自然过期不成立。还要检查代码是否在后续流程里重复设置了更短 TTL，但不能把所有 `-2` 都归因于过期。

### 4. 是否查了同一个节点和同一条读链路

代理集群、主从架构和多可用区环境里，排查工具可能默认连接到另一条链路。某处能读到 Key，只能证明那条链路存在数据，不能证明应用正在读取的节点也有。

因此每条证据都要带上实例、角色、数据库编号、路由方式和时间。若主节点上的 Key 已经消失，副本或另一套集群仍然完整，用错误入口查询会把调查引向业务代码。

### 5. 检查淘汰计数

当 TTL 与显式删除都解释不了 Key 消失时，应查看：

```bash
redis-cli INFO stats | grep -E 'evicted_keys|expired_keys'
redis-cli INFO memory | grep -E 'used_memory:|used_memory_peak|maxmemory|mem_clients_normal'
```

`expired_keys` 增长说明 Key 因 TTL 到期删除；`evicted_keys` 增长说明 Redis 因 `maxmemory` 策略主动淘汰。两者是不同的删除路径。

如果缓存重建期间 `evicted_keys` 快速上升，调查重点应转向内存峰值。此时继续盯着 `SADD` 数量或本地集合并集，已经偏离根因。

## 三、为什么内存明明不高，还是超过了 maxmemory

Redis 的几个内存指标很容易混在一起：

| 指标 | 说明 |
| --- | --- |
| `used_memory` | Redis 分配器统计的内存，包括数据与多种运行开销 |
| `used_memory_dataset` | 数据集自身占用的内存 |
| `used_memory_peak` | 进程启动以来 `used_memory` 的峰值 |
| `used_memory_rss` | 操作系统看到的常驻内存 |
| `maxmemory` | Redis 用于限制缓存数据与触发策略的配置值 |
| `mem_clients_normal` | 普通客户端连接使用的内存 |
| `mem_not_counted_for_evict` | 淘汰判断时排除的内存，主要是复制与 AOF 临时缓冲区 |

`maxmemory` 不是机器物理内存，也不等于容器上限。节点可能有几 GB 物理内存，Redis 的 `maxmemory` 只配置了其中一部分。反过来，即使 `used_memory` 已经下降，RSS 也可能因为分配器尚未把页归还操作系统而保持较高。

排查瞬时问题时，当前值往往比峰值低。事故发生后只看 `used_memory`，可能得到“内存很充足”的错觉。应把 `used_memory_peak`、`evicted_keys` 的增量和同一时间窗的客户端内存一起看。

还有一个边界需要说清：复制与 AOF 的部分缓冲内存在淘汰判断中会通过 `mem_not_counted_for_evict` 排除，防止淘汰操作本身制造更多复制数据并形成反馈循环。普通客户端的查询与输出缓冲区不是同一类豁免项。

## 四、只读请求怎样制造内存峰值

Redis 客户端使用请求/响应协议。普通的串行调用大致是：

```text
客户端发送 GET
Redis 执行并返回结果
客户端读取结果
客户端再发送下一个 GET
```

Pipeline 会一次发送多条命令，再批量读取回复：

```text
客户端：GET key:1
客户端：GET key:2
客户端：GET key:3
...
Redis：reply:1
Redis：reply:2
Redis：reply:3
...
```

它减少了网络往返和系统调用，吞吐通常更高。代价是 Redis 必须暂存还没有被客户端读取的回复。Redis 官方文档明确提醒，大 Pipeline 会迫使服务端排队回复并使用额外内存，建议拆成合理大小的批次，读取一批结果后再发送下一批。

每个连接至少可能涉及：

- 查询缓冲区，保存客户端已经发送但尚未处理的命令；
- 输出缓冲区，保存已经生成但尚未发送完的回复；
- 参数解析和连接对象等其他内存。

当客户端发送命令的速度高于 Redis 把回复送出的速度，或者客户端暂时没有读取，输出缓冲区就会增长。`CLIENT LIST` 中可以观察：

| 字段 | 含义 |
| --- | --- |
| `qbuf` | 查询缓冲区长度 |
| `obl` | 固定输出缓冲区长度 |
| `oll` | 输出列表中的回复数量 |
| `omem` | 输出缓冲区使用的内存 |
| `tot-mem` | 该客户端连接消耗的总内存 |

普通客户端的输出缓冲区限制在很多版本中默认是 0，也就是不主动限制。大批量读取返回的数据越多，单连接峰值越高。

### 并发缓存重建如何放大一次读取

单个 API 实例分批读取数百个 Set，通常问题不大。如果所有实例收到同一个版本通知后同时重建，本来的一次读取会乘上实例数。

可以粗略估算命令数：

```text
总命令数 = 应用实例数 × 快照份数 × shard 数
```

再估算回复量：

```text
总回复字节 ≈ 应用实例数 × 每份快照的序列化大小
```

假设有 120 个应用实例，每个实例读取两份快照，每份拆成 600 个 Set：

```text
120 × 2 × 600 = 144,000 条读取命令
```

如果所有实例在几秒内集中执行，代理和 Redis 会同时看到明显的 QPS、入流量与出流量峰值。更重要的是，每条 `SMEMBERS` 可能返回大量成员，响应字节通常远大于请求字节。

这就是“读也可能导致 Key 淘汰”的完整链路：

```text
统一通知触发并发重建
    ↓
每个实例提交深 Pipeline
    ↓
Redis 产生回复的速度暂时高于客户端读取速度
    ↓
普通客户端输出缓冲区增长
    ↓
Redis 内存越过 maxmemory
    ↓
allkeys-lru 等策略开始淘汰数据 Key
    ↓
后续读取遇到缺失 Key，本地缓存变小
```

读请求本身没有删除 Key。它制造了连接内存峰值，淘汰策略随后删除 Key。两者之间隔着内存判断，所以从业务日志看起来会很诡异。

## 五、Set 编码为什么不是根因

排查过程中很容易被 Redis 底层编码吸引。只包含整数且成员较少的 Set，可以使用紧凑的 `intset`；超过阈值或出现非整数成员后，会转换为哈希表编码。

`intset` 通过连续内存节省空间，插入时需要保持有序，某些位置的插入会移动后续元素。若每个 Set 有几百个成员，确实应该评估写入成本和编码转换。

但它无法解释两个关键证据：

1. Key 是在批量读取阶段消失，而不是写入阶段；
2. `evicted_keys` 与客户端内存峰值同时增长。

底层编码是合理的性能假设，却不是当前证据支持的根因。排障时应该允许假设被证伪。看到一个听起来复杂的内部机制后继续深挖，很容易错过监控里更直接的信号。

## 六、怎样在本地复现

复现实验需要让数据集接近 `maxmemory`，再制造一个产生大量回复但暂时不读取的客户端。测试只能在本地或隔离环境执行，不要对共享 Redis 运行。

### 1. 启动一个受限 Redis

```bash
docker run --rm --name redis-buffer-lab -p 6380:6379 redis:7.2-alpine \
  redis-server \
  --maxmemory 32mb \
  --maxmemory-policy allkeys-lru \
  --client-output-buffer-limit 'normal 0 0 0'
```

这里故意关闭普通客户端输出缓冲区限制，让现象更容易出现。不同 Redis 版本、操作系统 socket 缓冲区和数据规模会改变复现阈值。

### 2. 准备测试数据

写入几百个较大的 Value，让 `used_memory_dataset` 接近但不要超过 `maxmemory`。保留足够余量启动连接和执行命令。

```bash
redis-cli -p 6380 INFO memory
redis-cli -p 6380 CONFIG GET maxmemory
redis-cli -p 6380 CONFIG GET maxmemory-policy
```

### 3. 创建一个只发命令、暂时不读回复的客户端

下面的 Python 使用原始 RESP 协议，不依赖 Redis 客户端库。它重复查询测试 Key，发送完后等待十秒才开始读回复：

```python
import socket
import time


def resp_get(key: str) -> bytes:
    raw = key.encode("utf-8")
    return b"*2\r\n$3\r\nGET\r\n$" + str(len(raw)).encode() + b"\r\n" + raw + b"\r\n"


sock = socket.create_connection(("127.0.0.1", 6380))
payload = b"".join(resp_get(f"blob:{i % 400}") for i in range(20_000))
sock.sendall(payload)

# 故意不读，让回复在服务端和内核缓冲区积累。
time.sleep(10)

while sock.recv(64 * 1024):
    pass
```

若本机 socket 很快吸收了回复，可以增加 Value、命令数或并发连接。目标是观察机制，不是追求固定数字。

### 4. 从另一个连接观察

```bash
redis-cli -p 6380 INFO memory
redis-cli -p 6380 INFO stats | grep evicted_keys
redis-cli -p 6380 CLIENT LIST TYPE NORMAL
redis-cli -p 6380 DBSIZE
```

重点看 `used_memory_peak`、`mem_clients_normal`、客户端的 `omem`/`tot-mem`、`evicted_keys` 和 `DBSIZE`。若输出缓冲区增长并伴随淘汰计数上升，实验就复现了同一机制。

复现失败也有信息价值。可能是客户端读取太快、数据离 `maxmemory` 太远、普通客户端缓冲区限制提前断开连接，或者当前版本对客户端内存有新的保护。不要为了“证明文章正确”随意降低系统保护后忘记恢复。

## 七、第二个问题：为什么还会超时

即使容量足够，不受约束的批量读取也可能造成超时。

一次 `SMEMBERS` 请求很小，回复可能包含成百上千个成员。多个实例同时读取完整快照时，代理出流量、Redis 网络带宽和客户端反序列化都会成为瓶颈。日志里看到的是连接超时，Redis 慢日志却可能没有明显的慢命令，因为单条命令执行不慢，拥塞发生在总流量、排队与传输阶段。

排查这类超时要同时看：

- Redis 与代理的入流量、出流量；
- 客户端连接池等待时间；
- 命令 QPS 与返回字节；
- 单次 Pipeline 的命令数和总响应大小；
- 应用实例开始重建的时间分布；
- 客户端反序列化与本地缓存构建耗时。

只看慢查询会漏掉“每条都快，但同一秒来了太多条”的问题。

缓存重建失败时，还要保留上一份成功快照。正确的切换顺序是：读取新数据，完整校验，在独立对象里构建成功，然后原子替换引用。不要边读边清空旧缓存，否则一次 Redis 超时就会把可用数据一起丢掉。

## 八、修复方案

### 1. 给重建任务加抖动

所有实例收到通知后立即执行，会形成惊群。可以根据实例 ID 计算稳定延迟，或在一个时间窗口内加入随机抖动，让流量从几秒摊到几十秒。

```java
Duration jitter = Duration.ofSeconds(
        Math.floorMod(instanceId.hashCode(), 60));
scheduler.schedule(this::rebuildCache, jitter);
```

稳定散列比每次完全随机更容易排查，同一实例的行为可预测，同时仍能打散整体流量。

### 2. 限制 Pipeline 深度

不要一次把全部 shard 放进一个 Pipeline。按固定批次发送，读取并处理结果后再进入下一批：

```java
Set<Long> result = new HashSet<>();

for (List<String> batch : partition(keys, 100)) {
    List<Set<String>> replies = redis.pipeline(batch, pipeline -> {
        List<Response<Set<String>>> pending = new ArrayList<>();
        for (String key : batch) {
            pending.add(pipeline.smembers(key));
        }
        return pending;
    });

    replies.stream()
            .flatMap(Set::stream)
            .map(Long::parseLong)
            .forEach(result::add);
}
```

批次大小不能只按命令数设定。读取大 Set 时，应同时限制预计回复字节。100 个小 Key 和 100 个大 Key 的内存峰值完全不同。

### 3. 控制重建并发

实例内使用 single-flight，避免配置通知、定时刷新和人工刷新同时触发三次构建。集群层面可以设置并发上限，或由少量加载器生成压缩快照，再让其他实例从对象存储或分发服务获取。

集中加载会引入新的可用性与分发成本，适合快照较大、实例很多的场景。小规模服务通常先做抖动与分批已经足够。

### 4. 为 Redis 留瞬时内存余量

容量规划不能只装下稳定状态的数据集。客户端连接、复制、AOF、fork 写时复制、重哈希和碎片都会占用额外内存。

`maxmemory` 应给运行开销留下空间。提高阈值或扩容可以止损，但如果并发读取模式不变，峰值仍会随实例数继续增长。

### 5. 配置客户端内存保护

Redis 支持按客户端类型配置输出缓冲区硬限制和软限制。达到限制后连接会被关闭，避免单个慢客户端无限占用内存。限制太低会让合法的大响应频繁断连，需要基于真实返回大小设置。

Redis 7.0 起还提供 `maxmemory-clients`，限制所有客户端连接的总内存。超过阈值时，Redis 会优先断开占用内存较多的客户端。它把故障形态从“删除缓存数据”转成“部分重建请求失败”，配合上一份缓存兜底通常更可控。

```text
maxmemory-clients 5%
```

这不是统一推荐值。应结合连接数、Pipeline 大小与数据集容量压测后确定。

### 6. 重新审视淘汰策略

`allkeys-lru` 适合数据可重新生成的纯缓存。当 Redis 中的数据承担状态或快照源角色时，淘汰任意 Key 可能直接造成不完整结果。

这里还有一个容易被忽略的风险：同一实例里可能不只有缓存，还放着分布式锁。典型的 Redis 锁会通过下面的命令写入一个带过期时间的 Key：

```text
SET lock:order:123 6f19c8... NX PX 30000
```

假设线程 A 拿到锁后开始处理订单，锁的租约是 30 秒。5 秒后，大批量读取产生的客户端缓冲区把实例推过 `maxmemory`，锁 Key 被淘汰。线程 B 此时再次执行 `SET ... NX` 会成功，因为从 Redis 看，这个 Key 已经不存在。A 并不知道自己的锁提前消失，仍会继续执行，于是两个线程同时进入临界区。

这和“业务执行超过 30 秒，锁自然过期”不是一回事。后者属于租约设计问题，前者则是内存淘汰绕过了原本约定的有效期。排查时可以用 `expired_keys` 与 `evicted_keys` 区分两条路径：前者增长表示 TTL 到期，后者增长表示 Key 因内存压力被主动删除。

不同淘汰策略对锁的影响如下：

| 策略 | 锁 Key 是否可能被淘汰 | 原因 |
| --- | --- | --- |
| `allkeys-lru` | 会 | 所有 Key 都在候选集合中 |
| `allkeys-lfu` / `allkeys-random` | 会 | 策略不同，但同样允许淘汰任意 Key |
| `volatile-lru` | 会 | 正确的锁通常带 TTL，恰好属于 `volatile` Key |
| `volatile-lfu` / `volatile-random` / `volatile-ttl` | 会 | 只要锁带过期时间，就可能进入候选集合 |
| `noeviction` | 不会因内存策略被删除 | 内存不足时，可能增加内存的写命令会失败 |

因此，把锁改成带 TTL 后再使用 `volatile-lru`，并不能保护它。LRU 中的“最近使用”也不是生存承诺；Redis 使用近似 LRU，内存持续紧张时，即使锁刚被访问过，也不能把正确性建立在它“大概率不会被选中”上。

更稳妥的做法是把锁与可淘汰缓存放在不同的 Redis 实例中，而不是只分到不同逻辑 DB。逻辑 DB 仍共享同一份内存上限和淘汰策略。锁实例使用 `noeviction`，预留足够内存余量，并对写入失败、`used_memory`、`evicted_keys` 做报警。普通缓存实例则可以根据数据是否可重建选择 LRU 或 LFU。

`noeviction` 只消除了“锁被淘汰”这一条故障路径，并不会让分布式锁自动变得可靠。业务执行超过 TTL、续期失败、主从切换丢失尚未复制的锁状态，都可能破坏互斥。释放锁时还必须校验随机值，不能直接 `DEL`，否则一个执行缓慢的旧线程可能删掉后来线程刚获得的新锁。对于订单、支付、库存等不能接受重复提交的操作，还应在数据库或下游资源中加入幂等键、版本号或 fencing token。

选择淘汰策略前，先把 Redis 中的 Key 分成两类：丢失后能够重建的缓存，以及丢失会破坏业务正确性的状态。两类 Key 混在同一个会淘汰数据的实例里，容量问题最终可能变成一致性问题。

## 九、监控应该覆盖哪些信号

仅监控内存百分比和 QPS，不足以还原这类问题。建议按五个维度建立观察面：

| 维度 | 指标或证据 |
| --- | --- |
| 数据集 | `used_memory_dataset`、Key 数、各类型数量、大 Key |
| 总内存 | `used_memory`、`used_memory_peak`、RSS、碎片率 |
| 客户端 | `mem_clients_normal`、连接数、`omem`、`tot-mem` |
| 淘汰 | `evicted_keys`、`expired_keys`、淘汰超限持续时间 |
| 流量 | 请求/响应字节、Pipeline 深度、超时、连接池等待 |

应用侧还应记录每次缓存重建的版本、开始时间、完成时间、批次数、读取 Key 数、结果元素数和失败原因。这样可以把 Redis 峰值与具体重建批次对应起来。

建议把下面几种报警拆开：

- `used_memory` 接近 `maxmemory`；
- `mem_clients_normal` 在短时间快速增长；
- `evicted_keys` 出现增量；
- 单客户端 `omem` 过大；
- 多个实例在同一时间窗口启动重建；
- 新缓存规模相较上一版本异常下降。

最后一项很重要。底层监控没有及时报警时，业务不变量仍能发现异常：完整快照不应该无原因地从几十万条降到几万条。检测到规模异常后，应拒绝用坏快照替换当前缓存。

## 十、这类问题为什么容易误判

故障链跨越了四层：应用通知制造并发，客户端 Pipeline 放大批量，Redis 缓冲区产生内存峰值，淘汰策略删除数据。任何一层单独看都符合预期。

开发者容易先查代码，因为缓存内容变少通常像业务逻辑错误。Redis 当前内存又可能在事故后迅速下降，让“内存不足”显得不合理。若排查工具连接的是另一条链路，还会得到“Key 明明都在”的相反证据。

排查时要保持证据链完整：

1. 先确认数据在哪一步开始减少；
2. 区分过期、显式删除和 `maxmemory` 淘汰；
3. 查看事故时间窗的峰值，不只看当前值；
4. 把请求数量换算成返回字节与客户端内存；
5. 用隔离实验复现，再逐项验证优化。

Pipeline 是一个很好用的吞吐工具。批次大小、并发实例数和响应体积没有边界时，它也能制造很陡的瞬时峰值。把缓存重建当作一次受预算约束的数据传输任务，通常比把它当作“循环读几个 Key”更接近真实成本。

### 公开资料

- [Redis pipelining](https://redis.io/docs/latest/develop/using-commands/pipelining/)
- [Redis client handling 与输出缓冲区](https://redis.io/docs/latest/develop/reference/clients/)
- [Redis key eviction](https://redis.io/docs/latest/develop/reference/eviction/)
- [Redis distributed locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
- [CLIENT LIST 字段说明](https://redis.io/docs/latest/commands/client-list/)
- [Redis INFO 指标说明](https://redis.io/docs/latest/commands/info/)
- [Redis replication 与副本 maxmemory 行为](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
