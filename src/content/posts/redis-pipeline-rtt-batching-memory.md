---
title: Redis Pipeline 为什么能提速：RTT、批处理与内存边界
description: 从 Redis 的请求响应协议出发，解释 Pipeline 怎样减少网络往返和系统调用，以及它与批量命令、事务、Lua 的区别和使用边界。
category: 后端
subcategory: Redis
articleClass: field-note
seriesOrder: 30
featured: true
publishedAt: 2026-07-14T21:09:00+08:00
updatedAt: 2026-07-14T21:09:00+08:00
tags: [Redis, Pipeline, RTT, 批处理, 网络延迟, 客户端缓冲区]
---

假设一个接口要读取 500 个 Redis Key。循环调用 500 次 `GET`，代码很简单，耗时却不一定花在 Redis 查找数据上。客户端每发出一条命令，都要等请求到达 Redis、命令执行、回复再穿过网络回来，然后才能发送下一条。即使每条命令只执行几十微秒，500 次网络往返仍会依次累加。

Pipeline 改变的是这段等待方式：客户端连续发送多条命令，不逐条等待回复，Redis 按收到的顺序执行，再让客户端批量读取结果。它主要减少 Round Trip Time（RTT）和 Socket 读写次数，并没有创造新的执行线程，也没有给多条命令增加事务语义。

这篇文章只回答一个问题：Pipeline 为什么能提速，以及批次开得太大时，成本会转移到哪里。

## 一、单条请求为什么会被 RTT 限制

Redis 使用请求—响应协议。最普通的同步调用遵循下面的顺序：

```text
客户端发送 GET user:1
客户端等待
Redis 读取、执行并返回结果
客户端收到结果
客户端发送 GET user:2
……
```

一次往返耗时可以粗略拆成：

```text
单次调用耗时 ≈ 请求网络时间 + 排队时间 + 命令执行时间 + 回复网络时间
```

前后两段加起来就是通常所说的 RTT。若连续执行 `N` 条彼此独立的同步命令，总耗时大致包含 `N` 次 RTT：

```text
Tserial ≈ N × RTT + 所有命令的执行与传输时间
```

这不是严格的性能公式，连接复用、TCP 缓冲、调度、负载和 Value 大小都会影响结果。它仍然揭示了主要问题：下一条命令必须等待上一条回复时，网络等待无法重叠。

即使客户端和 Redis 在同一台机器，调用也不是一段普通的内存函数。客户端进程要写 Socket，内核调度 Redis 进程读取并处理，Redis 再写回 Socket，客户端重新获得运行机会。Redis 的[官方 Pipeline 文档](https://redis.io/docs/latest/develop/using-commands/pipelining/)也专门说明，本机回环网络依然包含系统调用和进程调度成本。

## 二、Pipeline 把多次等待合并成少量批次

使用 Pipeline 后，时序变成：

```text
客户端发送 GET user:1
客户端发送 GET user:2
客户端发送 GET user:3
客户端开始读取回复

Redis 执行 GET user:1 -> reply 1
Redis 执行 GET user:2 -> reply 2
Redis 执行 GET user:3 -> reply 3
```

如果一批包含 `B` 条命令，`N` 条命令大致只需要 `ceil(N / B)` 轮批次往返：

```text
Tpipeline ≈ ceil(N / B) × RTT + 所有命令的执行与传输时间
```

Pipeline 并没有减少命令数量。Redis 仍要解析和执行全部命令，网络也仍要传输全部请求与回复。它省掉的是逐条“发送—等待—再发送”造成的空档，同时让客户端和服务端有机会用更少的 `read()`、`write()` 系统调用处理更多数据。

![普通请求与 Redis Pipeline 的往返和缓冲差异](/images/posts/redis-pipeline-rtt-batching.svg)

图里的命令仍按顺序进入 Redis。Pipeline 提升的是一批独立命令的端到端吞吐，而不是让单条 `GET` 本身执行得更快。只发一条命令，或者后一条命令必须依赖前一条的结果时，Pipeline 没有可合并的等待。

## 三、回复顺序稳定，不代表整批具有原子性

Redis 会按照命令发送顺序返回 Pipeline 结果。客户端可以用第 `i` 个回复对应第 `i` 条命令，不需要在协议里给每条回复额外附一个请求 ID。

但顺序不能推导出原子性。假设客户端 A 通过 Pipeline 发送：

```text
GET balance
SET balance 90
```

客户端 B 的命令可能在两条命令之间执行。A 先读到 `100`，B 把余额改成 `80`，A 又按旧结果写入 `90`，B 的更新就被覆盖了。Pipeline 只负责批量传输，没有把“读取—计算—写回”封装成不可插入的操作。

需要一组命令连续执行时，应评估 `MULTI/EXEC`；需要读取当前值后在服务端完成判断和写入时，通常应使用已有原子命令、条件写入、Lua 或 Redis Functions。Redis 的[事务文档](https://redis.io/docs/latest/develop/using-commands/transactions/)明确说明，事务中的命令会作为一个隔离单元连续执行，这项保证不属于普通 Pipeline。

Pipeline 也不是并行执行。Redis 可以一次收到许多命令，处理命令的核心路径仍遵循 Redis 自身的执行模型。一批里如果夹着一个耗时很长的命令，排在它后面的回复仍要等待。把慢命令放进 Pipeline，不会把它变快，反而可能一次制造更明显的排队。

## 四、批量命令、Pipeline、事务与 Lua 怎样区分

这几种方式都能减少客户端与 Redis 的交互，因此经常被混在一起。

| 机制 | 发送的 Redis 命令数 | 是否减少 RTT | 是否保证中间不插入其他客户端命令 | 能否使用前一步结果继续计算 |
| --- | ---: | --- | --- | --- |
| `MGET`、`MSET` 等批量命令 | 1 | 是 | 单条命令执行期间不会插入 | 只支持命令本身定义的逻辑 |
| Pipeline | 多条 | 是 | 否 | 发送时通常还没有前序回复 |
| `MULTI/EXEC` | 多条并排队后执行 | 可结合客户端 Pipeline | 是 | 事务队列中的后续命令不能直接读取前序回复后再组装 |
| Lua / Functions | 通常一次调用 | 是 | 脚本执行具有原子性 | 可以在服务端读取、判断和写入 |

如果要读取一批明确的 String Key，`MGET` 比发送多个 `GET` 更直接，也省去重复命令解析。若操作类型不同，例如同时读取 String、Hash 与 ZSet，或者每条命令参数不同，Pipeline 更灵活。

若下一步依赖上一步结果，例如“先取库存，判断大于零，再扣减”，不能先把所有命令盲目塞入 Pipeline。此时真正需要的是服务端原子操作，而不是单纯减少 RTT。

在 Redis Cluster 中还要考虑路由。一个 Pipeline 中的 Key 可能属于不同 Slot 和不同节点，Cluster 客户端通常需要先按节点分组，再分别发送子 Pipeline；具体能力取决于客户端实现。`MGET` 等单条多 Key 命令则通常要求相关 Key 位于同一个 Slot。Pipeline 不能绕过 Cluster 的 Slot 约束。

## 五、批次越大，回复缓冲区占用越多

Pipeline 的速度收益来自“不等回复继续发送”，这也意味着回复必须暂时放在某个地方。客户端还没开始或来不及读取时，Redis 会把待发送内容放进该连接的输出缓冲区。

假设一次 Pipeline 读取 10,000 个 Key，每个 Value 平均 20 KB，仅 Value 就可能产生约 200 MB 回复，协议字段和对象管理还会增加额外开销。若多个应用实例同时重建缓存，Redis 需要为多条连接保留回复，瞬时内存和网络压力会一起上升。

这正是“只读请求也可能带来内存峰值”的原因。Pipeline 不修改 Value，但它产生的待发送回复属于客户端连接内存。Redis 官方建议把大量命令拆成有限批次，读完一批结果再发送下一批；文档中的批次数量只是示例，不能当成适用于所有 Value 大小和并发量的固定配置。

站内的[《只读请求为什么也会触发 Redis Key 淘汰》](/posts/redis-read-trigger-key-eviction/)复盘了这条故障链：多个实例并发执行大 Pipeline，输出缓冲区增长，实例越过内存边界，随后触发数据集淘汰。那篇文章处理故障排查，本文只保留设计结论：批次要按**回复字节数和并发连接数**估算，不能只数命令条数。

需要重点观察的信号包括：

- 每批命令数、请求与回复总字节数、整批耗时；
- Pipeline 并发数以及客户端连接池等待；
- Redis 的客户端输出缓冲区和总客户端内存；
- 实例内存、网络吞吐、`evicted_keys` 与连接断开；
- 单批中是否包含复杂度过高或返回结果过大的命令。

Redis 还支持通过客户端输出缓冲区限制和 `maxmemory-clients` 管理客户端连接内存，具体行为见官方的[客户端处理文档](https://redis.io/docs/latest/develop/reference/clients/)。这些保护措施负责止损，不能代替应用控制批次和并发。

## 六、超时以后，不能假设整批都没执行

Pipeline 通常会一次返回与命令数量对应的回复数组，其中某一条命令失败，并不表示其他命令没有执行。应用必须检查每个回复，而不是只判断“本次 Pipeline 调用有没有抛异常”。

更麻烦的是连接中断：客户端可能已经把整批命令写入内核，Redis 执行了其中一部分或全部，但回复没有完整到达客户端。此时应用看到的是结果未知，而不是确定失败。若直接重试一批 `INCR`、`LPUSH` 或扣减命令，可能产生重复效果。

因此，Pipeline 适合两类操作：重复执行没有副作用的读取；或者本身具备幂等边界的写入。非幂等写入需要业务 ID、去重状态或原子脚本保证重试安全。即使不用 Pipeline，远程调用也存在相同的不确定性；Pipeline 只是让一次失败可能覆盖更多命令。

还要避免把返回顺序当成业务成功列表。下面这种处理是不完整的：

```java
// 伪代码：具体类型与方法名取决于客户端
List<PipelineReply> replies = pipeline.execute(commands);
if (replies != null) {
    markAllSucceeded();
}
```

更合理的做法是保存命令与业务对象的稳定对应关系，逐项解析回复，对可重试错误和永久错误分别处理。客户端若提供异步 Pipeline，还要把批次超时、连接关闭和调用取消的语义确认清楚。

## 七、怎样选择批次大小

没有一个通用的 `pipelineSize = 1000`。批次应在吞吐、单批延迟、内存峰值和失败范围之间取平衡。

可以从一个保守值开始，并同时记录命令数和回复字节数。逐步增大批次，观察吞吐是否仍然明显增长。如果吞吐已经接近平台期，而单批 P99、输出缓冲区或实例内存继续上升，就没有必要再扩大。

一个实用的控制方式是给批次设置双重边界：

```text
达到最大命令数 -> 发送
预计请求或回复字节达到阈值 -> 提前发送
```

对于 Value 大小差异很大的读取，仅用命令数控制尤其危险。读取 500 个几十字节的计数器和读取 500 个大 JSON，连接内存与网络成本完全不同。可以根据历史分布估算回复大小，或把明显的大对象放到独立批次。

批次控制之外还要限制并发。10 个实例各发一批 1,000 条，与 1 个实例发同样一批，对 Redis 的瞬时压力不是一回事。缓存预热、全量同步和定时任务应加入并发上限与抖动，避免所有实例同时启动。

## 八、什么时候值得使用 Pipeline

Pipeline 适合下面这些场景：

- 一次需要执行许多彼此独立的小命令；
- 网络 RTT 在总耗时中占比较高；
- 没有合适的单条批量命令；
- 应用能够限制批次、并发，并逐条处理回复；
- 写操作能够安全重试，或者失败后可以逐项确认。

若只有少量命令，Pipeline 增加的代码复杂度可能没有收益。若结果之间有依赖，优先寻找原子命令、Lua 或 Functions。若单条命令本身很慢，应先处理数据结构、命令复杂度和 Big Key，而不是把更多慢命令塞进同一批。

判断 Pipeline 是否有效也不应只看客户端平均耗时。至少同时比较总吞吐、单批 P99、Redis CPU、网络吞吐、客户端内存和服务端输出缓冲区。真正理想的结果是：减少等待以后吞吐上升，而内存与尾延迟仍处于可控范围。

Pipeline 的机制很小：先连续发送，再批量读取。用好它需要记住两条边界。第一，它优化通信，不提供并行和原子性；第二，它把逐条 RTT 换成了批次内存、批次延迟和更大的失败范围。只要围绕回复大小和并发量设置上限，Pipeline 就能成为一种简单且稳定的吞吐优化手段。

## 参考资料

- [Redis 官方文档：Pipelining](https://redis.io/docs/latest/develop/using-commands/pipelining/)
- [Redis 官方文档：Transactions](https://redis.io/docs/latest/develop/using-commands/transactions/)
- [Redis 官方文档：Client handling](https://redis.io/docs/latest/develop/reference/clients/)
- [Redis 官方文档：Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
