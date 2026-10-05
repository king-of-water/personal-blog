---
title: Redis 持久化：RDB、AOF 与数据丢失边界
description: 从一次写入经过内存、页缓存与磁盘的路径出发，拆解 RDB 快照、AOF 刷盘与重写、混合持久化、恢复优先级、性能代价和可验证的数据丢失边界。
category: 后端
subcategory: Redis
articleClass: flagship
seriesOrder: 70
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Redis, RDB, AOF, 持久化, fsync, 数据恢复, Copy-on-Write, WAITAOF]
---

客户端收到 `SET order:42 paid` 的 `OK`，随后机器突然断电。Redis 重启以后，这条记录还在吗？

答案取决于 `OK` 返回时数据走到了哪一层：只修改了 Redis 内存，已经写进 AOF 的进程缓冲区，已经交给操作系统页缓存，还是已经由 `fsync` 推到持久介质。若节点没有重启而是发生 Failover，还要继续问副本复制和落盘到了哪个位置。把这些状态都称为“写成功”，就无法给业务说明真正的数据丢失边界。

本文回答一个问题：怎样根据业务能接受的数据丢失量和恢复时间，选择并验证 Redis 的 RDB、AOF 或组合方案？讨论对象是 Redis Open Source 的本地持久化。复制、Sentinel 与 Cluster 会在后续文章展开；这里仅说明它们与持久化相交的边界。主要依据是 Redis 官方文档、配置说明和公开源码，托管版产品的实现与承诺应以各自文档为准。

## 一、先定义持久化到底要承诺什么

持久化配置背后是一组恢复承诺。设计前至少要写清四个问题。

第一，进程、操作系统、整机或机房故障时，最多允许丢多少已确认写入，也就是恢复点目标 RPO。纯缓存可以接受从源数据库重建，RPO 甚至可以等于缓存全部数据；会话、幂等结果和任务进度往往只能接受几秒；资金事实通常不该只保存在 Redis。

第二，故障后多久必须恢复服务，也就是恢复时间目标 RTO。加载几十 GB 的 AOF、从对象存储下载 RDB、校验文件、预热热点和让客户端重新建连都占用时间。文件存在不代表服务已经恢复。

第三，需要恢复到“最新状态”，还是需要找回某个历史时间点。当前节点上的 AOF 适合重建较新的状态，却不能替代异地历史备份。一次误执行 `FLUSHALL` 也会被忠实追加并持久化；若 AOF 已重写，错误操作之前的历史可能已经不在文件里。

第四，谁负责证明备份能恢复。`rdb_last_bgsave_status:ok` 只说明本次快照成功生成，无法证明备份已经离开故障域、加密密钥可用、目标版本能加载、恢复后的业务不变量成立。持久化文件、备份副本和恢复演练属于同一条链上的不同环节。

| 目标 | 关心的问题 | Redis 机制能提供什么 | 仍需额外建设 |
| --- | --- | --- | --- |
| 进程重启恢复 | 本机进程退出后数据是否回来 | RDB 或 AOF 启动加载 | 文件校验、启动监控 |
| 控制数据丢失窗口 | 已确认写最多丢多久 | AOF `appendfsync`、`WAITAOF` | 业务确认协议、故障测试 |
| 节点故障接管 | 本机完全损坏后是否可用 | 复制可保存另一份实时状态 | Sentinel/Cluster、复制 Lag 治理 |
| 历史回滚与灾备 | 误删、勒索或机房丢失后能否恢复 | RDB 适合制作不可变备份 | 异地保存、版本保留、恢复演练 |

Redis 的持久化主要解决前两项的一部分。复制提高可用性，备份提供历史版本和故障域隔离。三者组合后才可能满足一份完整的灾难恢复方案。

## 二、一次写入从 `OK` 到真正落盘经过哪些层

Redis 执行写命令时先改变内存数据集。开启 AOF 后，命令还会编码后追加到 AOF 缓冲区，在事件循环的合适阶段通过 `write` 交给操作系统。`write` 成功通常只表示数据进入内核页缓存，并不等于存储设备已经完成持久化。`fsync` 或 Linux 上常用的 `fdatasync` 才请求操作系统把相应内容同步到持久介质。

![Redis 写入从内存到持久介质的确认边界](/images/posts/redis-persistence-write-ack-boundaries.svg)

图里最重要的是四条故障线。同样一个客户端 `OK`，在不同配置下可能只跨过内存更新，也可能已经跨过本地 `fsync`。讨论“Redis 会不会丢数据”时，必须先说故障发生在进程、内核、机器还是整个存储故障域，再说明确认点在哪里。

RDB 走的是另一条路径。写命令持续修改当前内存数据，后台子进程保存某个时刻的数据快照。客户端返回与某次 RDB 是否完成没有逐请求关系。因此只开启 RDB 时，`OK` 表示命令已经在当前进程生效，不表示它已进入最近一份可恢复快照。

关机方式也会改变结果。正常 `SHUTDOWN` 可以按配置执行保存和关闭流程；`kill -9`、进程崩溃、内核 Panic、断电不会给 Redis 同样的收尾机会。用优雅重启测试出的“零丢失”不能代表突然故障。

## 三、RDB 保存的是某个时间点的数据集

RDB 是 Redis 数据集的紧凑二进制快照。自动规则可以表达为“至少经过 N 秒且发生 M 次变更后触发”，也可以用 `BGSAVE` 手动发起。生产环境通常避免 `SAVE`，因为它在主进程同步保存，数据量大时会阻塞客户端。

```ini
# 示例，不是通用推荐值
save 900 1
save 300 100
save 60 10000
dbfilename dump.rdb
dir /var/lib/redis
```

多条 `save` 规则是“任一满足即可触发”，不是层层同时满足。最终是否适合，应根据写入速率、允许 RPO、Fork 成本和磁盘吞吐压测。频繁快照会缩短理论丢失窗口，也会更频繁地付出 Fork、Copy-on-Write 和全量写文件的成本。

### `BGSAVE` 怎样得到一致快照

Redis 主进程调用 `fork()` 后，父子进程起初共享同一批物理内存页。子进程遍历它看到的数据集并写临时 RDB 文件；父进程继续服务请求。某个共享页被父进程修改时，操作系统才复制该页，让子进程仍能看到 Fork 时刻的旧内容，这就是 Copy-on-Write（COW）。

子进程写完并校验成功后，Redis 用新文件替换旧 RDB。生成中途崩溃通常不会把半份临时文件当作正式快照。RDB 适合复制、归档和跨区域保存，也常比长 AOF 更快加载。

但“后台保存”不表示主进程没有成本：

- `fork()` 要复制页表。数据集很大、内存碎片严重或宿主机 CPU 紧张时，主线程会出现停顿；
- 保存期间写得越多，被复制的内存页越多，COW 额外内存越高；
- 子进程顺序读取内存并写盘，会与主进程争用内存带宽、CPU 和磁盘；
- 容器只按稳态 `used_memory` 配额，未给 COW 留余量时，后台保存可能触发 OOM；
- Transparent Huge Pages 等内存配置可能放大页复制成本，应结合目标环境验证。

`INFO persistence` 中的 `rdb_bgsave_in_progress`、`rdb_last_bgsave_status`、`rdb_last_bgsave_time_sec`、`rdb_last_cow_size` 和当前 COW 字段能描述这些代价。它们需要做成时间序列，单次登录查看很难捕捉高峰。

### RDB 的数据丢失窗口怎样计算

假设 12:00 的 RDB 成功完成，下一次快照计划在 12:05。实例在 12:04:59 突然丢失，能够恢复的通常仍是 12:00 快照，之后近五分钟写入都可能丢失。触发规则只决定何时开始保存，快照完成还需要时间；严格的恢复点应以成功完成并可读取的文件为准。

RDB 中保存的是绝对过期时间。恢复旧快照时，加载阶段会跳过已经到期的 Key。于是“文件里有这个 Key”和“恢复后能读到这个 Key”并不矛盾。站内[《Redis 过期与淘汰》](/posts/redis-expiration-eviction-key-disappearance/)详细解释了这条时间边界。

当 RDB 后台保存失败且 `stop-writes-on-bgsave-error yes` 生效时，Redis 会拒绝可能修改数据集的命令，防止系统在快照长期失败而无人察觉时继续扩大风险窗口。直接把它改成 `no` 只能恢复写入流量，不能解决磁盘满、权限、只读文件系统或 I/O 故障。若业务选择继续写，必须有其他耐久路径和明确报警。

## 四、AOF 记录的是能够重放的写命令

开启 AOF 后，Redis 把改变数据集的操作以 Redis 协议格式记录下来。重启时按顺序重放这些操作，就能重建最终状态。读取命令不会写入 AOF；无效或已经被整理掉的中间历史也不必永远保留。

```ini
appendonly yes
appenddirname "appendonlydir"
appendfilename "appendonly.aof"
appendfsync everysec
```

以 `INCR counter` 为例，AOF 记录可重放命令，不记录内存页差异。过期处理、脚本、事务和某些内部传播会转换成适合重放的形式。AOF 也不是完整业务审计日志：重写会压缩历史，文件内容服务于恢复数据集，不负责保存调用者身份、请求上下文和每次读取。

### 三种 `appendfsync` 给出三种确认边界

`appendfsync always` 在新命令追加后执行同步。Redis 会对同一事件循环批次中的多条写做 Group Commit，但写延迟仍会直接受到存储 `fsync` 影响。它把本地崩溃的数据丢失窗口压得最小，却没有覆盖磁盘控制器谎报落盘、文件系统或硬件损坏、整机丢失和副本切换。

`appendfsync everysec` 通常把 `fsync` 放到后台线程，每秒推进一次。官方文档将其描述为性能与安全性的折中，灾难故障下通常可能丢失约一秒数据。真实上界还受调度、I/O 卡顿与实现细节影响，不能把“一秒”写成绝对 SLA。`INFO persistence` 的 `aof_pending_bio_fsync` 与 `aof_delayed_fsync` 可以暴露积压和延迟。

`appendfsync no` 仍然调用 `write`，但不由 Redis 主动要求同步，交给操作系统自行刷盘。丢失窗口取决于内核与文件系统配置，通常更大且更难对业务解释。它和“关闭 AOF”仍有区别：进程异常但操作系统存活时，页缓存中的 AOF 可能仍被刷盘；整机断电则不应依赖这件事。

| 策略 | `OK` 前的主要工作 | 典型风险窗口 | 主要代价 | 适合前提 |
| --- | --- | --- | --- | --- |
| `always` | 追加并等待本地同步 | 最小，但仍非跨节点零丢失 | 写延迟受磁盘同步影响 | 极低本地 RPO，已压测尾延迟 |
| `everysec` | 追加，后台周期同步 | 约秒级，卡顿时可能扩大 | 平衡吞吐与耐久性 | 能接受并量化秒级丢失 |
| `no` | 追加到 OS，刷盘交给内核 | 由 OS 决定，难做严格承诺 | 同步开销低 | 数据可重建或另有事实源 |

磁盘慢时，后台 `fsync` 可能与新一轮 AOF `write` 互相影响。Redis 会尽量避免主线程长时间卡在 I/O 上，但缓冲和延迟不能无限增长。观察平均延迟还不够，需要把 AOF 相关 Latency Monitor 事件、P99/P999、磁盘队列深度和 `aof_delayed_fsync` 放在同一时间轴。

## 五、AOF 为什么必须重写

命令日志会不断增长。对同一个 Key 执行一百万次 `INCR`，恢复最终状态并不需要永远重放一百万条历史命令，可以用一条能表达当前值的写入代替。AOF 重写根据当前内存数据集生成一份等价而更紧凑的基础状态，不是简单逐行压缩旧文件。

Redis 7.0 起使用 Multi-Part AOF（MP-AOF）：一个 Base 文件表示某次重写时的数据集，后面跟一个或多个 Incremental AOF 文件，Manifest 记录加载顺序。默认 `aof-use-rdb-preamble yes` 时，Base 通常使用更紧凑、加载更快的 RDB 格式；增量部分仍是 AOF 命令。

![Redis 7 Multi-Part AOF 重写与切换过程](/images/posts/redis-multipart-aof-rewrite.svg)

重写开始后，子进程基于 Fork 时刻的数据生成新 Base；父进程继续把新写入追加到新的 Incremental 文件。新 Base 完成后，Redis 原子更新 Manifest，使恢复链切换为“新 Base + 对应增量”。旧文件确认不再被 Manifest 引用后才可清理。这样避免了旧版重写末尾合并巨大内存缓冲并长时间暂停写入的一部分问题。

`BGREWRITEAOF` 启动或安排后台重写。若 RDB 保存正在进行，AOF 重写会排队而非与其同时 Fork；`INFO persistence` 的 `aof_rewrite_in_progress`、`aof_rewrite_scheduled`、`aof_last_bgrewrite_status`、`aof_current_size` 与 `aof_base_size` 能说明状态。自动触发通常由当前大小、上次重写基线和配置阈值共同决定。

重写仍然要承担 Fork、COW、全量扫描和磁盘写入。高写入率下，Incremental AOF 增长很快；磁盘空间至少要容纳现有文件、新 Base、重写期间增量与临时空间。只根据最终 AOF 大小配置磁盘，很容易在重写中途耗尽空间。

## 六、RDB 与 AOF 同时开启时如何恢复

同时开启两者不是“启动时把 RDB 和 AOF 合并”。常规启动中，Redis 会选择 AOF 恢复，因为它通常包含比 RDB 更新的数据。Redis 7 的 AOF Base 又可以本身采用 RDB 编码，因此“文件格式是 RDB”与“它属于 AOF 恢复链”需要分开理解。

恢复时可把顺序简化为：

1. 读取配置和目标目录，判断 AOF 是否启用；
2. 若启用 AOF，读取 Manifest，依次加载 Base 与 Incremental 文件；
3. AOF 未启用或不存在时，才按 RDB 路径加载 `dump.rdb`；
4. 加载失败是否终止，取决于文件错误类型、版本和相关配置；
5. 加载完成后才对外提供正常数据服务。

这也解释了一个危险现场：磁盘里有一份看起来完好的新 RDB，但 Redis 重启后数据更旧或启动失败。实际加载的可能是另一目录中的 AOF Manifest，或配置的 `dir`、`appenddirname` 与操作者想象不同。恢复前必须记录生效配置、绝对路径、文件列表、大小、校验值和日志，不能只盯着 `dump.rdb` 文件名。

组合方案通常很实用：AOF 缩短本地 RPO，RDB 便于制作历史备份和更快恢复。它也叠加了两类后台任务的资源压力。Redis 会协调 RDB 保存和 AOF 重写，避免两个重型子进程同时运行，但长时间的一个任务会推迟另一个任务，必须监控“最后成功时间”和排队状态。

## 七、`WAIT`、`WAITAOF` 与 `appendfsync always` 分别保证什么

`WAIT` 等待此前由当前连接产生的写入被指定数量副本确认处理。它关注复制 Offset，不等于副本已经将 AOF `fsync`。`appendfsync always` 约束本地 AOF 同步策略，不证明副本收到写入。

Redis 7.2 提供 `WAITAOF numlocal numreplicas timeout`，可以等待当前连接此前写入被本地 AOF 和指定数量副本的 AOF 确认 `fsync`：

```text
SET payment:42 confirmed
WAITAOF 1 1 1000
# 返回 [local_count, replica_count]
# 客户端必须检查两个数字是否达到自己的门槛
```

如果一秒超时，命令仍会返回实际已经完成同步的数量，不会因为超时自动回滚前面的 `SET`。业务必须把“门槛达成”“超时但之后可能落盘”和“连接断开结果未知”设计成不同结果。盲目重试又会回到幂等问题。

`WAITAOF` 提高真实故障下的数据安全，却不把 Redis 变成强一致数据库。未等待所有可能被提升的节点、网络分区后选择了落后副本、磁盘同时损坏、操作者恢复了旧备份，都仍可能丢失数据。它给特定写入增加可观测的持久化确认点，不是跨所有故障的事务提交证明。

## 八、持久化、复制和备份不能互相替代

持久化保护“这个节点重启后能否恢复”；复制保护“一个节点失效时另一节点能否接管”；备份保护“当前状态已经错误或整个在线故障域丢失时能否回到历史版本”。

一个没有持久化的主从集群，在所有节点短时间内依次重启时可能整组变空。一个只有本地 AOF 的单节点，磁盘损坏后没有第二份状态。一个实时复制但没有历史备份的集群，会把 `DEL`、`FLUSHALL` 和业务写错值快速复制到所有节点。

反方向也成立：每天一份 RDB 备份不能提供秒级 Failover，AOF 每秒刷盘不能提供三十天前的恢复点，副本数量多也不能证明文件可被目标版本加载。

因此业务承诺应写成具体组合。例如：“主节点 AOF `everysec`，至少一个副本跨宿主机；每天生成并验证 RDB，保留 30 天且跨区域保存；季度执行全量恢复演练；支付事实保存在数据库，Redis 只保存可重建状态。”这比“Redis 开了持久化和主从”更容易审查。

## 九、文件损坏、截断与磁盘满时怎么处理

进程可能在写 AOF 的半条命令时退出，得到尾部截断文件。新版本 Redis 在 `aof-load-truncated yes` 下可丢弃最后一条不完整命令并继续加载，同时记录警告。它处理的是意外 EOF，不代表可以忽略文件中间损坏。

若 AOF 中部出现非法字节，Redis 通常拒绝启动。官方建议先备份原文件，再用 `redis-check-aof` 检查；只有理解损坏 Offset 和可能丢弃的范围后才考虑 `--fix`。修复工具可能从损坏点截去后续内容，损坏发生得早时会造成大量数据丢失。对生产文件直接执行 `--fix`，等于在没有回退副本的情况下改写事故证据。

RDB 可以使用 `redis-check-rdb` 做格式与校验检查。工具通过只说明文件结构可读取，仍不能替代业务校验。例如总 Key 数相同，也可能有一批 Key 过期、一批 Key 被错误覆盖，恰好数量抵消。

磁盘满会同时影响 AOF 追加、重写临时文件和 RDB 保存。现场应先保存 Redis 日志、`INFO persistence`、文件系统剩余空间与 Inode、挂载状态、内核日志和文件列表，再决定扩容、清理或切换。删除“看起来旧”的 MP-AOF 文件前必须确认 Manifest 引用关系；按文件名猜测并手工清理，可能删掉启动必需的 Base 或 Incremental 文件。

## 十、性能成本主要出现在哪里

持久化带来的性能成本有四种主要来源，不能全部归到“磁盘 I/O 变多”。

Fork 延迟发生在创建后台子进程时，主要受数据集大小、页表规模、内存状态和 CPU 影响。COW 内存发生在后台任务运行期间，受写入比例和页面分布影响。顺序写文件会消耗磁盘吞吐，并可能与 AOF `fsync`、日志和同机其他服务竞争。启动恢复则受文件大小、命令数量、CPU 解码和磁盘读取影响。

观察这些成本时，可建立如下关联：

| 现象 | 首先检查 | 可能的持久化链路 |
| --- | --- | --- |
| 周期性延迟尖峰 | `latest_fork_usec`、Latency Monitor | Fork 页表复制 |
| 后台保存时 RSS 暴涨 | `current_cow_size`、`rdb_last_cow_size` | 高写入率触发 COW |
| 写延迟与磁盘抖动同步 | `aof_delayed_fsync`、磁盘延迟 | AOF 同步阻塞或积压 |
| AOF 一直变大 | `aof_current_size/base_size`、重写状态 | 重写未触发、失败或长期排队 |
| 重启耗时超出 RTO | `loading_*`、文件大小、启动日志 | AOF 重放或 RDB 加载过慢 |
| 后台任务失败 | `*_last_*_status`、磁盘空间、权限 | 临时文件创建或写入失败 |

压测必须覆盖稳态和后台任务。只在刚启动、AOF 很小且没有 `BGSAVE` 时测出的 P99，不代表生产重写窗口。至少要模拟目标数据量、真实写入比例、Fork、重写、磁盘限速和恢复加载，并为内存、磁盘空间与恢复时间保留余量。

## 十一、一次断电事故怎样确定丢了哪些写入

假设订单状态缓存使用 Redis 7.2，开启 AOF `everysec` 和每五分钟 RDB。15:20:10 机器断电，15:24 新机器从原磁盘副本启动。业务发现 15:20:09 附近少了部分状态，想知道 Redis 是否违反了配置承诺。

![Redis 断电后确认恢复边界的证据时间线](/images/posts/redis-persistence-recovery-timeline.svg)

### 第一步：确定实际加载了什么

先保存启动日志和生效配置，确认 `dir`、`appendonly`、`appenddirname`、`appendfilename`、Manifest 以及每个 Base/Incremental 文件。日志显示 Redis 加载了 MP-AOF，而非旁边 15:20:00 的 `dump.rdb`。因此恢复点应从 AOF 判断。

### 第二步：把业务确认语义与 AOF 同步点对齐

事故前使用 `appendfsync everysec`，业务收到普通 `SET` 的 `OK` 后立即对外返回，没有调用 `WAITAOF`。`OK` 只能证明命令已经在当时主进程执行并进入 AOF 处理链，不能证明每条请求已经单独 `fsync`。断电前最近一个完成的同步点之后，存在可预期的丢失窗口。

如果某类关键请求在同一连接随后执行 `WAITAOF 1 1 1000`，且保存了返回 `[1,1]`，就能得到更强证据：本地和一个副本均已把此前 Offset 同步到 AOF。若只保存“调用成功”而未保存返回计数，仍无法知道门槛是否达成。

### 第三步：区分未持久化、文件截断和加载失败

启动日志显示最后一个 Incremental AOF 尾部短读，并在 Offset X 截断后继续加载。将被截断尾部、最后成功同步时间、请求日志与稳定业务 ID 对齐，可以列出候选丢失集合。若日志显示文件中部损坏或某个 Incremental 缺失，影响就不再是简单的秒级窗口，需要停止自动拉起，保全文件并从副本或备份恢复。

### 第四步：用事实源校验业务状态

订单数据库是事实源，Redis 只是加速读取与保存短期处理状态。恢复任务按订单版本重建缺失 Key，并核对“数据库已支付但 Redis 未确认”“Redis 状态领先数据库”等不变量。只比较恢复前后 Key 总数，无法判断具体哪些订单错误。

最终结论应写成：“普通写在 `everysec` 未完成同步的窗口内可能丢失，现有日志确认 AOF 尾部在 Offset X 截断；关键请求是否属于该集合，以请求 ID、AOF 可恢复 Offset 和数据库版本交叉确认。”不要把所有缺失都概括为“Redis 断电丢一秒”，因为路由切换、未复制写、过期和恢复源选错也可能制造相同表象。

## 十二、怎样设计可验证的持久化方案

先按数据等级拆实例或至少拆清职责。纯缓存、可重建派生状态、幂等结果、任务租约和资金事实不能共用一句“允许少量丢失”。数据价值不同，RPO、淘汰策略、备份保留和故障处理也不同。若一份状态丢失后无法从权威事实重建，应认真评估 Redis 是否适合作为唯一存储。

再把承诺落到写协议。普通请求收到 `OK` 后可承诺什么？关键请求是否需要 `WAITAOF`，超时返回什么状态，客户端能否幂等查询？复制切换后允许回退多少 Offset？这些问题要写进 API 和状态机，不能只留在 Redis 配置里。

容量规划至少覆盖：稳态内存、COW 峰值、AOF 与 RDB 同存、一次重写临时空间、文件增长到告警与人工响应之间的余量，以及恢复机下载和加载文件所需空间。生产磁盘不应在自动重写成功时才刚好够用。

备份流程要得到一个一致的文件集合。RDB 完成后文件不会再被原地修改，适合复制；Redis 7 的 MP-AOF 备份需要保证 Manifest 与它引用的 Base、Incremental 文件属于同一一致时刻，不能在重写切换途中逐个随意复制。应按目标版本官方流程暂停自动重写或使用版本提供的备份能力，并保存校验值与元数据。

最后建立恢复验收：

1. 在隔离环境加载指定 RDB 或 AOF，记录加载时间和错误；
2. 检查 Redis 版本、模块、配置和 ACL 兼容性；
3. 比较 Key 数、按类型采样 Value、TTL 分布和关键业务版本；
4. 运行不变量检查，而非只执行 `PING`；
5. 测量热点预热后达到 SLO 的时间；
6. 记录实际 RPO、RTO 与手册偏差，反向修正配置和容量。

## 十三、上线前应监控哪些信号

基础监控可以从 `INFO persistence` 开始：

```text
INFO persistence

rdb_bgsave_in_progress:0
rdb_last_save_time:...
rdb_last_bgsave_status:ok
rdb_changes_since_last_save:...
rdb_last_cow_size:...
aof_enabled:1
aof_rewrite_in_progress:0
aof_rewrite_scheduled:0
aof_last_bgrewrite_status:ok
aof_last_write_status:ok
aof_current_size:...
aof_base_size:...
aof_pending_bio_fsync:0
aof_delayed_fsync:...
```

报警不要只看 `status != ok`。还应关注距上次成功 RDB 的时间是否超过 RPO、AOF 当前大小相对 Base 的增长率、重写长期排队、Delayed Fsync 增量、COW 峰值逼近内存余量、磁盘空间和 Inode、Fork 延迟、恢复加载时间，以及备份最近一次异地复制和恢复验证时间。

每个指标都要带实例身份和重启信息。累计计数重启后可能重置；Failover 后观察对象改变；Cluster 各分片有独立文件和状态。只展示集群汇总的“全部正常”，可能掩盖某一个分片两天没有成功持久化。

## 十四、用故障实验验证数据丢失边界

配置评审只能推导理论窗口，故障实验才能暴露文件系统、存储和运维流程里的真实边界。测试环境应使用接近生产的数据量和存储类型，并为每条写入携带单调序号与时间戳。

第一组实验验证 RDB。持续写入带序号数据，在 `BGSAVE` 前、进行中和完成后分别强制终止进程，检查正式 RDB 是否完整、恢复到哪个序号、COW 峰值和 Fork 延迟是多少。再把写入比例提高到生产高峰，确认容器不会因 COW 被杀。

第二组验证 AOF。分别使用三种 `appendfsync`，在高写入和磁盘限速下终止进程或虚拟机，记录客户端最后确认序号、最后可恢复序号、AOF 截断日志和恢复时长。对 `everysec` 的测试不能用正常 `SHUTDOWN` 代替突然断电。

第三组验证重写。让 AOF 达到触发阈值，在 `BGREWRITEAOF` 的不同阶段终止实例，确认 Manifest 始终指向可加载组合；同时观察磁盘峰值、Incremental 增长和 P99。不要在生产首次验证 MP-AOF 文件清理脚本是否理解 Manifest。

第四组验证灾备。模拟本机文件全部不可用，从异地备份在空环境恢复，测量下载、校验、加载、业务校验与流量恢复总耗时。再模拟误删已经被 AOF 和副本同步，确认能否选择正确历史备份，而不是把错误状态恢复得更快。

## 十五、选择方案时可以落到这张表

| 数据特征 | 建议起点 | 必须验证的风险 |
| --- | --- | --- |
| 可从数据库重建的普通缓存 | 可不持久化，或周期 RDB 加速冷启动 | 重建流量是否压垮源站，RTO 是否可接受 |
| 能接受分钟级丢失的派生数据 | RDB + 异地备份 | 快照完成间隔、Fork/COW、备份可加载 |
| 能接受秒级丢失的状态 | AOF `everysec` + RDB 备份 + 副本 | Fsync 卡顿、Failover Offset、恢复时长 |
| 少数写要求更强本地与副本落盘确认 | AOF + 针对关键写使用 `WAITAOF` | 超时结果未知、门槛检查、幂等重试 |
| 不能接受业务事实丢失 | 先选择能提供所需事务与一致性保证的事实存储 | Redis 只作为派生状态时的重建与一致性 |

选择 RDB 或 AOF，要让业务承诺与写入确认点匹配。RDB 把一段时间内的状态压成快照，适合备份和快速恢复，但两次成功快照之间的写入没有逐条落盘承诺。AOF 把写命令变成恢复日志，`appendfsync` 决定本地同步节奏，重写负责控制文件规模；它仍然需要历史备份、复制和业务幂等配合。

判断一套方案是否可靠，可以追问五个时间点：命令何时执行，何时进入 OS 页缓存，何时 `fsync`，何时被其他故障域确认，何时形成经过验证的备份。只有把客户端 `OK` 放到这条时间线上，数据丢失边界才从配置名变成可以测试的工程承诺。

## 参考资料

- [Redis 官方文档：Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis 官方文档：WAITAOF](https://redis.io/docs/latest/commands/waitaof/)
- [Redis 官方文档：WAIT](https://redis.io/docs/latest/commands/wait/)
- [Redis 官方文档：BGSAVE](https://redis.io/docs/latest/commands/bgsave/)
- [Redis 官方文档：BGREWRITEAOF](https://redis.io/docs/latest/commands/bgrewriteaof/)
- [Redis 官方文档：INFO](https://redis.io/docs/latest/commands/info/)
- [Redis 官方文档：Latency](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/)
- [Redis 官方配置示例：redis.conf](https://github.com/redis/redis/blob/unstable/redis.conf)
- [Redis 源码：rdb.c](https://github.com/redis/redis/blob/unstable/src/rdb.c)
- [Redis 源码：aof.c](https://github.com/redis/redis/blob/unstable/src/aof.c)
