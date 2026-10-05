---
title: Redis 为什么快，也为什么会突然变慢
description: 从一次命令的完整路径解释 Redis 的低延迟来源，再拆解慢命令、Big Key、过期淘汰、Fork、Copy-on-Write、磁盘与系统抖动造成的尾延迟。
category: 后端
subcategory: Redis
articleClass: flagship
seriesOrder: 50
featured: true
publishedAt: 2026-07-01T21:07:00+08:00
updatedAt: 2026-07-01T21:07:00+08:00
tags: [Redis, 性能, 延迟, Event Loop, Slowlog, Fork, Copy-on-Write, Big Key, 故障排查]
---

“Redis 为什么快”常见的回答只有三个词：内存、单线程、IO 多路复用。这三个词都沾边，却解释不了生产环境里更重要的问题：平时几百微秒的请求，为什么会在某个时间点一起涨到几十甚至几百毫秒？

原因要沿着请求路径找。客户端的一条命令要经过网络往返、Socket 读写、服务端排队、命令执行、回复编码和发送。Redis 缩短了其中大多数环节：工作集主要在内存，事件循环避免为每条连接阻塞等待，核心命令路径较短，常见数据结构经过专门优化，命令执行大多串行又省去了大量锁竞争。但只要某个环节突然占住主执行路径，后面的请求就会一起排队。

所以，“快”描述的是正常路径很短，“突然变慢”通常来自某段工作不再短小、可增量或可后台化。本文先建立一次命令的运行模型，再按命令、后台任务、持久化、操作系统和客户端五个层次分析延迟，最后用一条故障链说明怎样从现象定位到根因。

## 一、先说清楚我们在比较什么

Redis 的“快”至少有三种含义：单条命令执行时间短、一个实例每秒处理的命令多、应用端观察到的响应时间低。它们有关联，却不能互相替代。

一条请求的端到端延迟可以粗略写成：

```text
应用耗时
≈ 连接池等待
+ 请求网络与调度
+ Redis 内部排队
+ 命令执行
+ 回复编码与发送
+ 客户端反序列化
```

Redis Slow Log 只统计命令在服务端真正执行的时间，不包含与客户端通信的 I/O。应用监控看到 80 ms，而 `SLOWLOG GET` 里没有慢命令，完全可能成立：延迟可能发生在网络、连接池、Redis 内部其他事件或操作系统调度上。

吞吐也不能只看总 CPU。大多数普通命令由一条主执行路径依次处理，一个核接近饱和时，机器总 CPU 可能只有 15%。反过来，开启 I/O 线程、执行后台持久化或异步释放时，Redis 进程与子进程可以使用多个核。“单线程”不是观察指标，真正需要看的是主执行路径是否出现排队。

本文讨论 Redis Open Source 的常见 Key-Value 命令路径。Redis 版本、模块、托管产品和 Query Engine 可能引入额外线程与执行模型。线上结论应以目标版本配置、`INFO` 与实际延迟数据为准。

## 二、一次命令怎样穿过 Redis

客户端复用 TCP 连接发送 RESP 请求。内核把就绪事件通知 Redis，Redis 读取并解析命令，在核心执行路径中访问数据结构，生成回复，最后把回复写回 Socket。一个连接暂时没有数据时，事件循环不会停在那里等待，而是继续处理其他已经就绪的连接。

![Redis 一次命令从网络进入事件循环再返回客户端的路径](/images/posts/redis-fast-command-path.svg)

这张图要区分四类工作：

- **网络 I/O**：接收字节、解析协议、编码并发送回复。现代 Redis 可以把部分客户端 Socket 读写交给 I/O 线程；
- **命令执行**：普通 Key-Value 命令主要在核心执行路径中依次运行，这是命令原子性和队头阻塞的来源；
- **后台线程**：AOF `fsync`、惰性释放等慢 I/O 或内存回收工作可以下放；
- **子进程**：`BGSAVE` 和 AOF Rewrite 会通过 `fork()` 创建子进程完成大部分持久化工作。

因此，“Redis 6 以后有 I/O 多线程”和“命令执行大多串行”并不冲突。I/O 线程减少网络读写与协议处理对主路径的占用，却不会自动把同一个 Keyspace 上的所有命令并行执行。若瓶颈是一个巨大的集合运算，增加 I/O 线程通常帮不上忙。

Redis 8 的 `INFO threads` 可以展示各 I/O 线程处理的客户端、读事件和写事件，`INFO stats` 也有 I/O 线程相关累计值。是否开启线程应由 CPU Profiling 和吞吐瓶颈决定。请求量不高时，多线程的协调成本可能没有收益。

## 三、Redis 的低延迟来自一条很短的正常路径

### 1. 工作集主要驻留内存

读取一个 String 或查找一个 Hash Field，通常不需要像磁盘数据库那样先等待随机页从存储设备进入 Buffer Pool。持久化文件仍然重要，但普通命令操作的是内存中的数据结构。少一次数量级更高的存储等待，是 Redis 低延迟的基础。

“内存数据库”不代表完全不碰磁盘。AOF、RDB、主从全量同步和启动加载都与磁盘或文件系统交互。Redis 的设计是让这些工作尽量脱离普通命令路径，而不是让磁盘消失。

如果操作系统把 Redis 的内存页换到 Swap，下一次访问会触发缺页并从磁盘调回，正常路径就被破坏了。此时一条看似普通的 `GET` 也可能停顿很久。因此物理内存余量、Swap 活动和容器内存限制属于 Redis 延迟配置的一部分。

### 2. Event Loop 不为每条空闲连接占一条线程

IO 多路复用让一个事件循环观察大量 Socket，只处理当前可读、可写或已经触发的事件。连接数量很多而活跃连接只占一部分时，Redis 不必为每个连接长期保留一条阻塞线程，也少了线程切换和大规模线程栈开销。

多路复用解决的是“怎样等待许多连接”，不等于许多命令会并行完成。事件就绪后仍要进入命令处理过程。一个事件循环能支撑高并发，前提是每个事件的处理足够短，或者昂贵工作能拆成增量步骤、后台任务。

### 3. 串行执行省掉大量同步，但把慢操作暴露给所有请求

普通命令大多沿一条主路径依次执行，对数据结构的单次修改天然具有原子边界。实现不需要在每次访问 Hash、List 或 ZSet 时都围绕共享数据加锁，也减少了锁竞争、缓存失效与线程调度。

这是一种明确的取舍：正常命令很短时，排队速度快，串行执行简单且高效；某条命令运行 100 ms 时，这 100 ms 内到达的其他普通命令都只能等。Redis 没有因为“单线程”而天然更快，它是靠让绝大多数工作尽快归还执行权来维持低延迟。

### 4. 数据结构与编码针对常见操作优化

String 使用 SDS，Hash 和 ZSet 会在紧凑编码与通用结构之间切换，List 使用 Listpack 或 Quicklist，ZSet 用 Dict 负责 member 定位、Skiplist 负责顺序和排名。上一章[《Redis 数据结构与内部编码》](/posts/redis-data-structures-internal-encodings/)已经展开这些实现。

这里保留一个性能结论：命令复杂度取决于实际数据结构与数据规模。`GET` 的查找路径很短，`HGETALL` 却必须返回所有 Field，`SINTER` 要处理参与集合，`ZRANGE` 的成本还包含返回元素数。Redis 的速度来自许多经过约束的操作，不是所有命令都能忽略 N。

### 5. 长连接、批量命令与 Pipeline 减少通信空档

命令执行只占端到端耗时的一部分。连接复用避免反复握手，`MGET` 等批量命令减少命令与协议开销，Pipeline 让客户端不必逐条等待 RTT。它们提升的是通信效率，不能消除服务端实际工作量。

站内[《Redis Pipeline 为什么能提速》](/posts/redis-pipeline-rtt-batching-memory/)详细说明了 RTT、批次内存和结果未知问题。本文关注另一个边界：过大的 Pipeline 会让一批命令在服务端集中排队，生成大量回复，慢命令还会拖住同批后续结果。

## 四、一条慢命令怎样拖住一批快命令

假设队列里依次到达 `GET A`、一次大型 `SINTER`、`GET B` 和 `INCR C`。第一条 `GET` 很快完成，`SINTER` 占住主执行路径 120 ms，后两条即使各自只需几十微秒，也要先等待这 120 ms。

![Redis 串行命令执行中的队头阻塞](/images/posts/redis-head-of-line-blocking.svg)

这就是 Head-of-Line Blocking（队头阻塞）。应用看到许多不同命令同时变慢，根因可能只有队首的一条命令。常见来源包括：

- 对大集合执行 `SUNION`、`SINTER`、`SORT`、全量范围查询等 O(N) 或 O(N log N) 操作；
- `KEYS *` 扫描整个 Keyspace，而不是用 `SCAN` 渐进遍历；
- 对 Big Key 使用 `HGETALL`、`SMEMBERS`、`LRANGE 0 -1`，执行和回复都很大；
- `DEL` 一个包含大量成员的复合结构，在主路径同步释放许多对象；
- Lua Script 或 Redis Function 做长循环，原子执行期间迟迟不归还控制权；
- Module 命令或业务自定义逻辑在主线程执行重 CPU 工作。

Big Key 不只在读取时危险。删除、过期、淘汰、复制、迁移和持久化都会放大它的成本。对于无需同步释放的删除，可以评估 `UNLINK`：它先把 Key 从 Keyspace 解除关联，再把实际内存回收交给后台线程。它降低主线程释放成本，但后台释放队列、内存下降速度与总资源消耗仍要观察。

返回数据量也要单独考虑。一个命令在 Slow Log 中执行很快，却生成了 100 MB 回复，应用端仍会等待网络传输，Redis 还要维护客户端输出缓冲区。算法复杂度没有把所有序列化和传输成本写进一个 `O(1)` 标签。

## 五、没有业务慢命令，Redis 也会出现内部停顿

### 1. 过期键集中在同一时刻

Redis 会在访问 Key 时惰性检查过期，也会主动抽样清理已过期 Key。主动过期必须在释放内存和占用主线程之间取平衡，因此以有时间预算的增量循环运行。

如果大量缓存使用完全相同的 TTL，并在同一秒过期，主动过期会发现样本中有很高比例已经失效，于是投入更多时间继续清理。若 Key 自身很大，删除成本还会叠加。业务上通常给批量缓存 TTL 加随机抖动，让过期压力分散到一个窗口，而不是集中到单个时点。

### 2. 到达 maxmemory 后持续淘汰

内存超过 `maxmemory` 后，Redis 需要根据策略选择 Key 并回收空间，才能继续处理需要分配内存的命令。淘汰包含采样、选择和删除；大对象或高写入速率会使这段工作持续出现。

`evicted_keys` 增长说明实例已经在用数据换空间。此时只调淘汰策略往往不够，还要查数据集增长、客户端缓冲区、复制/AOF 缓冲、碎片率和流量突增。站内的[只读请求触发 Key 淘汰复盘](/posts/redis-read-trigger-key-eviction/)给出了一条客户端输出缓冲区推高内存的完整故障链。

### 3. 渐进式 Rehash、主动碎片整理与惰性释放

Redis 把不少大工作拆成小步：Hashtable 扩缩容使用渐进式 Rehash，主动碎片整理逐步扫描，异步删除把真实释放放到后台。增量化能限制一次停顿，却不会让总工作量归零。

当实例同时承受高 QPS、扩容、过期、淘汰和碎片整理时，每轮事件循环可用于业务命令的预算会被多个内部任务瓜分。`INFO stats`、`INFO memory`、延迟监控事件和 CPU Profiling 比“Redis 平时很快”的经验更可靠。

## 六、Fork、Copy-on-Write 和磁盘为什么会影响内存数据库

RDB 快照和 AOF Rewrite 需要创建后台子进程。子进程负责遍历数据并写文件，父进程继续服务请求。这个设计避免父进程长时间同步写盘，但 `fork()` 本身要在父进程主路径上完成，数据集越大，复制页表等准备工作越重，Fork 停顿就可能越明显。

父子进程最初通过 Copy-on-Write（COW）共享内存页。后台任务运行期间，父进程修改某个共享页，内核才复制该页，让父子进程分别看到新旧版本。

![Redis 后台持久化中的 Fork 与 Copy-on-Write](/images/posts/redis-fork-copy-on-write.svg)

图中有两种成本：

1. **Fork 停顿**：创建子进程、复制页表时，父进程短暂停止处理命令；
2. **COW 放大**：后台保存期间写流量越大，被修改的共享页越多，额外内存带宽与物理内存占用越高。

大 Key 高频局部更新不一定只复制“几个字段”的字节，成本以操作系统内存页为单位。Transparent Huge Pages（THP）会把页变大，Fork 后轻微写入也可能触发更重的复制，Redis 官方生产配置建议禁用 THP。

AOF 还涉及 `write()` 与 `fdatasync()`。Redis 可以把 `fsync` 交给后台线程，但磁盘拥塞、文件系统卡顿和其他进程的写入仍可能通过缓冲区、调度或资源竞争影响 Redis。`appendfsync always`、`everysec` 和 `no` 在持久性与延迟之间有不同取舍，下一篇持久化文章会单独展开；这里的排障结论是：延迟尖峰与 RDB/AOF 时间线重合时，不能因为命令数据在内存就排除磁盘。

## 七、操作系统与部署环境决定最低延迟

即使 Redis 没有任何慢命令，进程也必须等操作系统给它 CPU 时间。虚拟机的 Hypervisor、同宿主机的 Noisy Neighbor、CPU 降频、NUMA 跨节点访问、容器 CPU Throttling、Swap 和磁盘拥塞都能制造延迟。

Redis 提供了一个容易被忽略的基线工具：

```bash
redis-cli --intrinsic-latency 100
```

这条命令必须在 Redis 所在机器执行，而且不会连接 Redis。它持续运行 CPU 密集循环，测量内核有多长时间没有调度该进程。如果机器自身的最坏调度停顿已经达到 8 ms，就不可能要求 Redis 所有请求稳定低于 1 ms。由于测试会占满一个核，不应在不了解影响时直接在繁忙生产节点长时间运行。

Swap 是另一类断崖式变化。数据在内存时访问很快，某页被换出后，命中它的请求要等待磁盘换入。此时延迟可能只发生在少数 Key，CPU 也未必高。排查要结合 `vmstat` 的 `si/so`、Major Page Fault、Redis RSS 与容器工作集，而不是只看 Redis QPS。

## 八、客户端和网络也会制造“Redis 变慢”

应用记录的 Redis 耗时通常从借连接或发请求开始，到解析完回复结束。以下问题都可能发生在 Redis 进程之外：

- 连接池过小，请求先在应用内部等待可用连接；
- 连接反复创建，TCP/TLS 握手与认证进入热路径；
- 跨可用区或跨地域访问，RTT 本身已经高于命令执行时间；
- 客户端 Event Loop 被业务回调阻塞，回复到达后没有及时读取；
- 大回复占满网卡或 Socket 缓冲，服务端输出缓冲区继续增长；
- 超时设置过短触发大量重试，额外流量又让排队更严重。

因此需要同时测应用端和服务端。`redis-cli --latency` 通过循环 `PING` 观察客户端到 Redis 的往返，`SLOWLOG` 观察命令执行，二者边界不同。如果应用耗时高、同位置运行的 `redis-cli --latency` 也高，而 Slow Log 平静，优先查网络、服务端排队和系统事件。只有某个应用实例变慢时，则先查它自己的连接池、GC、CPU 与网络路径。

超时重试尤其容易形成反馈循环：实例变慢，客户端超时；客户端立即重试，QPS 增加；排队更长，更多请求超时。读请求也需要退避、并发上限和整体 Deadline。对写请求，还要处理“命令已执行、回复未到达”的结果未知状态与幂等问题。

## 九、一次“每隔几分钟 P99 尖峰”的排查

假设一个 Redis 主节点平时 P99 为 2 ms，每隔五分钟跳到 150 ms，持续一两秒后恢复。业务监控显示各种命令一起变慢，QPS 没有明显上涨。

### 第一步：确认应用端现象是否来自单个客户端

按应用实例、可用区、命令和连接池等待拆分。所有实例几乎同时抖动，说明问题更可能位于共享网络、Redis 或宿主机；只有一台应用异常，则先处理该实例。

同时在与应用相近的网络位置运行：

```bash
redis-cli -h redis.example --latency-history
```

若 `PING` 也按同样周期尖峰，可以排除大部分业务序列化逻辑。

### 第二步：查 Slow Log，不把“没有记录”当结论

```text
CONFIG GET slowlog-log-slower-than
CONFIG GET slowlog-max-len
SLOWLOG GET 20
```

Slow Log 没有记录，只能说明没有命令执行时间超过当前阈值，不能排除 Fork、系统调度、网络、大回复或过期循环。还要确认阈值不是设置得比故障窗口更高，日志长度没有把现场快速覆盖。

### 第三步：看 Redis 自己记录的延迟事件

先按业务可接受阈值启用延迟监控，例如 20 ms：

```text
CONFIG SET latency-monitor-threshold 20
LATENCY LATEST
LATENCY DOCTOR
LATENCY HISTORY fork
LATENCY GRAPH fork
```

假设 `LATENCY LATEST` 中 `fork` 每五分钟出现一次，峰值与应用 P99 对齐，而 `command` 事件平静，调查方向就从“哪条命令慢”转向后台持久化。

### 第四步：把 Fork 与持久化、内存修改率对齐

检查 `INFO persistence` 中最近 RDB/AOF 状态、Fork 耗时与 COW 指标，再对齐 `BGSAVE` 或 Rewrite 时间。如果每五分钟触发快照，写入高峰期间 COW 内存也显著增加，故障链可以写成：

```text
定时触发 BGSAVE
→ 主进程 fork，复制页表时短暂停顿
→ 后台保存期间大量写入触发 COW
→ 内存带宽与 RSS 上升
→ 主执行路径获得 CPU/内存资源变慢
→ 多类命令 P99 同时尖峰
```

![Redis 延迟排查从应用现象到操作系统证据的路径](/images/posts/redis-latency-diagnosis-path.svg)

解决方案要对应证据：调整快照频率或时机，给节点预留内存，限制保存期间的写突发，检查 THP 与磁盘，把 Redis 数据集控制在 Fork 可接受的规模。若真正瓶颈是单个大命令，这些动作都不会解决问题。

## 十、排查工具分别能证明什么

| 工具或指标 | 观察范围 | 能回答的问题 | 不能直接证明 |
| --- | --- | --- | --- |
| 应用 Trace / Timer | 连接池到反序列化 | 哪些调用者、命令和时间窗变慢 | Redis 内部具体卡点 |
| `redis-cli --latency` | 客户端到 Redis 的 `PING` 往返 | 同一路径是否存在整体延迟 | 业务大 Value 与具体命令成本 |
| `SLOWLOG GET` | 命令执行阶段 | 哪些命令占用主执行路径过久 | 网络、连接池、Fork 等等待 |
| `INFO commandstats` | 按命令累计 CPU 时间与调用数 | 哪类命令贡献 CPU、失败和拒绝 | 单次故障完整时间线 |
| `INFO latencystats` | 按命令的延迟分位 | 哪些命令的 P50/P99/P999 上升 | 命令以外的系统事件 |
| `LATENCY LATEST/DOCTOR` | Redis 内部延迟事件 | Fork、Command、Expire 等事件是否尖峰 | 应用连接池与跨网 RTT |
| `--bigkeys` / `--memkeys` | Keyspace 抽样扫描 | 哪些 Key 在元素数或内存上很大 | 哪个 Key 当前最热 |
| `--hotkeys` | LFU 策略下的访问频率 | 哪些 Key 可能形成热点 | 非 LFU 策略下的完整热度 |
| OS 与容器指标 | 调度、内存、Swap、磁盘、网络 | Redis 所在环境是否失去 CPU 或发生 I/O 等待 | 业务命令语义 |

`INFO commandstats` 中的 `usec_per_call` 是累计平均值，尖峰很容易被平均。Redis 8 的 `INFO latencystats` 默认可提供按命令的 P50、P99、P999；具体字段与可用性仍要以部署版本为准。排障时保存时间序列，事故后只看一次当前值很难还原现场。

扫描工具也要控制影响。`redis-cli --bigkeys`、`--memkeys` 会遍历 Keyspace，生产环境应在低峰限速执行，或使用平台已有的离线采样能力。为了找性能问题而制造新的扫描压力，得不偿失。

## 十一、优化动作必须对应瓶颈

**命令或 Big Key 阻塞。**

把全量操作改为 `SCAN`、`HSCAN`、`SSCAN`、`ZSCAN` 等渐进迭代，限制单次范围返回数量。拆分无法在延迟预算内处理的 Big Key，删除时评估 `UNLINK` 和 `lazyfree-*` 配置。Lua 和 Function 要有明确输入上限，避免把批处理程序塞进原子脚本。

**网络与协议处理成为瓶颈。**

复用连接，优先使用合适的批量命令，再按回复字节与并发控制 Pipeline。只有 Profiling 证明网络读写、协议解析占据大量 CPU，才考虑开启 I/O 线程并压测线程数。I/O 线程不能修复 O(N) 命令。

**单核命令吞吐已经饱和。**

先减少无效请求、优化命令和 Key 模型。确实需要横向扩展时，通过 Redis Cluster 或应用分片把 Keyspace 分散到多个主节点，让不同分片使用不同 CPU 核。分片带来 Multi-Key 限制、扩容迁移和热点问题，不能只按总 QPS 平均切分。

**过期与淘汰造成周期尖峰。**

给批量 TTL 添加随机抖动，控制同一时刻创建和过期的缓存数量，避免大 Key 集中过期。持续淘汰时先查容量与内存构成，再决定扩容、缩短 Value、调整 TTL 或改变策略。`evicted_keys` 长期增长不应被当成正常容量管理。

**Fork、COW 或 AOF 造成停顿。**

预留 Fork 与 COW 所需内存，禁用 THP，避免与重 I/O 任务共盘或共核，按恢复目标调整持久化配置。大实例 Fork 成本无法接受时，要评估缩小单实例数据集，而不是只继续调参数。

**宿主机基线差。**

处理 CPU Throttling、Noisy Neighbor、Swap、NUMA 与磁盘延迟。应用 SLO 比机器能提供的 Intrinsic Latency 还低时，Redis 配置无法突破物理基线，需要更换部署规格或隔离方式。

## 十二、五个常见误区

**误区一：数据在内存，所以不会卡磁盘。**

普通读写主要访问内存，但 RDB、AOF、全量同步、Swap 和文件系统资源竞争仍会进入延迟链路。内存描述数据访问位置，不能推导整个进程与存储无关。

**误区二：Redis 是单线程，所以只能用一个核。**

普通命令的核心执行路径大多串行，进程还会使用 I/O 线程、后台线程和持久化子进程。机器需要为这些工作留出 CPU。总 CPU 低也不能证明主执行核没有饱和。

**误区三：Slow Log 为空，Redis 就没问题。**

Slow Log 不统计网络 I/O，也不会把所有 Fork、过期、淘汰和系统调度事件记成一条慢命令。它是命令执行证据，不是完整延迟日志。

**误区四：把慢命令放到 Pipeline 就会更快。**

Pipeline 减少 RTT，不减少命令复杂度。慢命令仍然占用执行路径，后续命令和回复继续排队。批次过大还会增加查询与输出缓冲区。

**误区五：平均延迟正常就代表 Redis 健康。**

周期性 Fork、集中 TTL 和偶发 Big Key 操作主要伤害尾延迟。平均值可能几乎不变，P99.9 和超时率已经影响用户。监控至少要保留分位、最大值、超时数和与内部事件对齐的时间线。

## 十三、把“Redis 快”变成可验证的运行条件

上线前可以用下面这组问题检查设计：

1. 每条命令的复杂度和最大输入规模是多少？会不会读取或删除 Big Key？
2. 客户端是否复用连接，Pipeline 是否限制命令数、回复字节与并发？
3. TTL 是否集中，实例接近 `maxmemory` 时会发生什么？
4. RDB/AOF 的 Fork、COW、磁盘与恢复目标怎样取舍？
5. 是否同时记录应用端延迟、Slow Log、Latency Monitor、命令分位与 OS 指标？
6. 主执行核饱和后，是优化请求、拆 Key，还是需要分片扩展？

Redis 的低延迟建立在一组条件上：数据页留在内存，单次命令有界，事件循环持续获得 CPU，内部维护能增量或后台执行，网络与回复规模受控。当其中一项失效，原本短小的路径就会出现长任务，串行执行又把这次停顿传播给后续请求。

面对一次延迟尖峰，先确定时间花在应用、网络、排队、命令还是系统事件，再选择工具取证。把“内存、单线程、IO 多路复用”换成这条可观测的请求路径，才真正回答了 Redis 为什么快，以及它什么时候不会快。

## 参考资料

- [Redis 官方文档：Diagnosing latency issues](https://redis.io/docs/latest/management/optimization/latency/)
- [Redis 官方文档：Latency monitoring](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency-monitor/)
- [Redis 官方文档：SLOWLOG](https://redis.io/docs/latest/commands/slowlog/)
- [Redis 官方文档：INFO](https://redis.io/docs/latest/commands/info/)
- [Redis 官方文档：Redis CLI latency tools](https://redis.io/docs/latest/develop/tools/cli/)
- [Redis 官方文档：Persistence](https://redis.io/docs/latest/management/persistence/)
- [Redis 官方文档：Administration](https://redis.io/docs/latest/operate/oss_and_stack/management/admin/)
- [Redis 官方配置示例：redis.conf](https://github.com/redis/redis/blob/unstable/redis.conf)
