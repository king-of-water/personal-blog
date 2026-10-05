---
title: 多台机器怎样生成不重复的 ID：UUID、Snowflake 与 Leaf
description: 从短链接创建请求出发，区分主键、业务 ID 与全局 ID，拆解 UUID、Snowflake、号段模式和美团 Leaf 的生成机制、故障边界与选型方法。
category: 后端
subcategory: 分布式
articleClass: flagship
seriesOrder: 80
publishedAt: 2026-08-20T09:10:00+08:00
tags: [分布式系统, 分布式 ID, UUID, Snowflake, Leaf, MySQL, Java]
---

一个短链接服务最初只有一台应用和一张 MySQL 表，`AUTO_INCREMENT` 足以生成主键。服务扩成多个实例后，自增仍然可用，因为所有写入共用一台数据库。数据被拆到多个库时，条件才发生变化：每个库都能生成 `1、2、3`，这些数字放到一起会重复；若改用一个中心发号器，每次创建又多了一次远程调用和一个故障点。

这篇文章讨论的问题是：多台机器怎样持续生成全局唯一 ID，同时兼顾长度、顺序、吞吐、可用性和数据库写入特征。短链接只承担一个具体案例。系统创建记录时向发号器申请数字 ID，再把它保存到数据库；如何通过短码选择分片、怎样缓存跳转结果，留给后续的分库分表和短链接系统设计文章。

UUID 部分以 [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html) 为准，Snowflake 参照 Twitter 的[原始设计说明](https://blog.x.com/engineering/en_us/a/2010/announcing-snowflake)与[归档实现](https://github.com/twitter-archive/snowflake)，Leaf 部分以美团技术团队的[开源文章](https://tech.meituan.com/2019/03/07/open-source-project-leaf.html)、[Leaf 仓库](https://github.com/Meituan-Dianping/Leaf)和当前 `SegmentIDGenImpl` 源码为依据。

## 先分清主键、业务 ID 与全局 ID

“给订单生成一个 ID”可能同时指四个问题：数据库用什么定位一行，业务接口用什么标识一张订单，多台机器怎样避免撞号，以及请求凭什么找到数据所在的分片。一个字段可以承担多项职责，但这些职责不会自动互相推出。

| 名称 | 负责什么 | 例子 | 保证范围 |
| --- | --- | --- | --- |
| 数据库主键 | 在一张表中唯一定位一行，并参与 InnoDB 的数据组织 | `id BIGINT PRIMARY KEY` | 由表结构和数据库约束决定 |
| 全局唯一 ID | 让多个进程、库表或机房生成的值不重复 | UUID、Snowflake ID、Leaf ID | 由生成算法和部署边界决定 |
| 业务 ID | 让接口、用户和上下游识别一个业务对象 | 订单号、支付单号、短码 | 由业务域和生命周期决定 |
| 分片键 | 决定数据写到哪个库表，以及查询访问哪里 | `user_id`、`tenant_id` | 由路由规则决定 |

![主键、全局 ID、业务 ID 与分片键的职责边界](/images/posts/distributed-id-responsibility-map.svg)

例如，一张分片后的订单表可以保留单表自增主键，用 `order_no` 保存 Leaf 生成的全局业务编号，再按 `user_id` 路由：

```sql
CREATE TABLE orders_07 (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_no    BIGINT UNSIGNED NOT NULL,
    user_id     BIGINT UNSIGNED NOT NULL,
    amount      DECIMAL(18, 2) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_no (order_no),
    KEY idx_user_id (user_id)
) ENGINE = InnoDB;
```

这里的 `id` 只要求在 `orders_07` 内唯一；`order_no` 承担跨分片唯一性；`user_id` 决定访问 `orders_07`。拿到 `order_no` 不一定能推出 `user_id`，所以“ID 全局唯一”和“ID 可以路由”是两项不同能力。

另一种设计会让 Snowflake 或 Leaf 生成的值直接成为主键。字段少了，跨分片归档也更方便，但数据库主键开始依赖外部发号规则。究竟是否合并职责，要看查询路径和故障成本，不能从“分布式系统都应该用雪花 ID”反推表结构。

## 一、唯一只是最低要求

一个合格的选型问题至少包含以下约束：唯一性覆盖哪些系统，峰值每秒生成多少个，能否接受依赖数据库或协调服务，ID 是否需要按时间大致排序，以及调用方是否能容忍暂时发不出新 ID。

顺序也要准确命名：

- 严格单调递增要求后生成的每个值都大于先生成的值，通常需要全局协调。
- 单节点递增只约束一个生成器内部，两个节点的结果可能交错。
- 趋势递增表示时间越晚，ID 整体越大，但短时间窗口里不保证请求顺序。
- 可排序只说明编码后的字节或数字适合排序，不代表排序结果等于真实业务先后。

ID 是否允许空洞是另一个常被误写的要求。数据库事务回滚、进程领取一段号码后崩溃、Snowflake 在同一毫秒没有用满序列，都会留下没有对应业务记录的数字。唯一性要求已经发出的两个业务对象不能共享一个 ID；连续性要求中间一个数字也不能缺。后者会显著增加协调和回收难度，订单、短链接和日志记录通常没有这个必要。

还要决定 ID 会不会暴露给不可信用户。递增数字会泄露大致创建量，也便于枚举相邻资源。把十进制数字改成 Base62 只改变表示形式，不会让序列变得不可预测。若资源授权依赖“别人猜不到 ID”，即使换成 UUID 也属于脆弱设计；服务端仍要检查访问权限。

### 唯一性承诺必须写出作用域和寿命

“全局唯一”里的“全局”经常没有定义。一个 worker ID 在生产集群内唯一，不代表预发环境、异地灾备和离线导入不会生成相同数字。两套系统使用相同 Snowflake epoch、机器编号和时间区间，生成空间就会重叠；两个 Leaf 环境从复制出来的同一行 `max_id` 开始，也会分配同样的号段。

设计文档至少要写清四项边界：哪些环境共享一个 ID 空间，唯一性要维持多久，系统合并历史数据时是否仍要求唯一，以及灾备站点是否会在主站仍存活时独立发号。租户 ID 或业务类型如果只是数据库中的另一列，并不会自动进入 ID 唯一性的作用域。

长期寿命还会反过来影响位宽。订单只在线保存三年，不代表订单 ID 三年后就能复用，因为账单、日志、消息和用户截图可能继续引用它。很多系统需要的是“业务存在期间绝不复用”，而不是“主表里查不到就可以回收”。号码空间足够大时，永久不复用通常比建立安全回收协议简单。

### 先算容量，再决定各字段占多少 bit

Snowflake 设计经常直接照搬 41、10、12 的经典划分，号段模式则随手设置一个 `step=1000`。更稳妥的做法是先算三个峰值：活跃发号节点数、单节点每个时间单位的峰值生成量、ID 格式预期使用年限。

假设系统最多有 256 个节点，单节点峰值为每毫秒 1500 个 ID，希望格式使用 30 年：

```text
节点位：ceil(log2 256) = 8 bit
序列位：ceil(log2 1500) = 11 bit，可表达 2048 个/ms
时间位：30 年毫秒数约需 40 bit
总计：1 + 40 + 8 + 11 = 60 bit
```

剩余 bit 可以留作增长空间、机房编号或格式版本。若峰值来自极少数热点节点，平均 QPS 没有参考价值；序列位应覆盖单节点短时间峰值。号段的 `step` 也要由消费速率反推。例如希望数据库故障后每个 Leaf 节点至少维持 20 分钟，节点峰值是 2000 ID/s，已缓存容量至少要达到 240 万，双 Buffer 是否都已装满还会改变实际缓冲时间。

容量计算不能只看生成器。Java 的 `long` 是有符号 64 bit，JavaScript `Number` 的安全整数只有 53 bit，数据库列可能使用有符号 `BIGINT`，日志系统也可能把大整数转换为浮点数。最窄的传输或存储环节决定了端到端可用空间。

## 二、数据库自增为什么够用，又在哪里失效

MySQL 的 `AUTO_INCREMENT` 给单表提供了直接的唯一编号。应用不用提前取 ID，也不用维护时钟和节点身份。InnoDB 通常把主键作为聚簇索引，二级索引记录中还会保存主键列，因此短且稳定的整数主键具有实际价值。MySQL 的[聚簇索引说明](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)也建议在没有自然主键时增加自增列，并提醒过长主键会放大所有二级索引。

只要多个应用实例仍写入同一张表，自增 ID 不会因为应用扩容而冲突。很多系统只需要“多实例”，还没有到“多个独立发号域”。这时直接使用数据库能力通常比部署一个发号服务可靠。

问题出现在数据被水平拆分之后：

```text
orders_00: 1, 2, 3, 4 ...
orders_01: 1, 2, 3, 4 ...
orders_02: 1, 2, 3, 4 ...
```

如果主键只在单表内使用，重复仍然无害；跨分片合并、事件传递或对外接口把 `id` 当作唯一标识时，重复才成为错误。这个判断解释了为什么有的分库系统继续保留本地自增主键，另建一列全局业务 ID。

### 步长和中心序列把冲突集中到一个位置

多库可以配置不同起点和固定步长。两个库分别生成奇数和偶数，四个库按模 4 分配余数。它避免了当前规模下的冲突，却把库数量写进 ID 规则；扩容、合库和环境复制都要小心维护起点。一个错误配置就可能让两个节点进入同一数列。

中心 sequence 表或 Redis `INCR` 更直观。所有调用方对同一个计数器做原子加一，唯一性由一个串行点保证：

```text
应用 A ─┐
应用 B ─┼──> INCR short_link:id ──> 300001, 300002, 300003
应用 C ─┘
```

这类方案能满足不少中等规模系统。代价也很明确：每个 ID 都需要一次远程协调；计数器所在系统的延迟、持久化和故障切换直接进入创建链路；计数器成功而业务写入失败时，号码会空缺。批量取号可以把每次协调摊薄，这正是号段模式的起点。

中心序列还有一个常被忽略的恢复问题。主节点刚执行 `INCR`，复制尚未到达副本就故障切换，新主上的计数器可能落后。若旧值已经返回给业务并写入数据库，新主再次发出同一值就会冲突。持久化、同步复制、故障转移和业务唯一约束共同决定它是否安全，“命令是原子的”只覆盖单实例执行时刻。

如果一次从 Redis 申请 1000 个号码，协调频率下降了，但应用已经开始实现号段分配。此时应该把区间的持久化边界、节点崩溃和恢复流程明确设计出来，避免在客户端里维护一个没有监控的本地缓存。Leaf 在批量取号之外，还把号段状态、预取、动态步长和监控变成一个可运维的服务。

## 三、UUID 用足够大的空间换掉中心协调

UUID 是 128 bit 标识符，不需要中心注册。RFC 9562 定义了多个版本，其中 UUIDv4 和 UUIDv7 最适合这篇文章的比较。

UUIDv4 把版本位和变体位之外的 122 bit 填充为随机或伪随机数据。它的唯一性属于概率保证。生成 `n` 个 UUIDv4 时，生日碰撞概率可以近似为：

```text
p ≈ n × (n - 1) / (2 × 2^122)
```

即使生成十亿个，近似概率仍在 `10^-19` 数量级。不过实现仍然依赖可靠随机源；错误的随机数生成器、克隆后重复的内部状态或人为截断，都会改变这个结论。

UUIDv4 的高位没有时间顺序。把它直接作为 InnoDB 聚簇主键时，插入位置分散在索引空间中，缓存局部性和页维护通常不如递增整数。它还是 128 bit；若应用把标准文本形式直接存进 `CHAR(36)`，空间会进一步放大。需要 UUID 时，应根据数据库能力考虑紧凑的二进制存储，而不是把展示格式等同于存储格式。

### UUIDv7 把毫秒时间放到高位

RFC 9562 在 2024 年标准化 UUIDv7。它使用 48 bit Unix 毫秒时间戳作为高位，剩余部分由版本、变体以及 74 bit 随机数据或可选的亚毫秒时间和计数器构成。按字节排序时，较晚时间生成的值大致排在后面。

```text
| 48 bit Unix 毫秒时间 | version | rand_a | variant | rand_b |
```

UUIDv7 改善了时间局部性，但规范允许剩余部分采用多种单调性方法。不能只看到“v7”就断言同一毫秒内严格有序，也不能假定不同实现对时钟回拨采取相同策略。跨语言系统若依赖排序特征，需要核对具体库的实现和存储字节序。

UUID 的优势是调用方可以本地生成，服务之间不共享计数器，也不需要分配 worker ID。代价是 128 bit、展示较长，并且随机或时间有序仍不等于业务提交顺序。请求 ID、文件 ID、离线数据合并很适合 UUID；希望得到紧凑 64 bit 整数并按时间大致排列时，Snowflake 更有针对性。

### UUID 的碰撞概率不能替代数据库约束

概率极低与错误不可处理是两回事。若一次碰撞只会让日志关联到错误请求，风险和资金订单撞号完全不同。高价值写入仍应建立唯一约束，并在冲突时生成新 UUID 或返回明确错误。唯一索引还能捕获实现缺陷，例如所有容器在镜像启动时恢复了同一伪随机状态。

同一个业务对象也不应在每次重试时生成新 UUID。请求第一次已经写入，响应丢失后，客户端若换一个 UUID 再请求，服务端会把它识别为新对象。UUID 解决不同生成者撞号的概率，稳定的幂等键负责把多次 attempt 绑定到同一业务意图。

有些系统会截取 UUID 的前 8 个字符作为短码。标准文本的每个十六进制字符只有 4 bit，8 个字符只剩 32 bit 空间；生成十万级数据时，生日碰撞已经不再可以忽略。任何截断、Base62 压缩或哈希取模都会重新定义有效空间，不能继续沿用完整 122 bit UUIDv4 的碰撞结论。

## 四、Snowflake 把时间、节点和序列装进 64 bit

Twitter 在 2010 年公开 Snowflake 时，需要高可用地生成每秒数万个、能大致排序并装进 64 bit 的 Tweet ID。它选择让每个 worker 本地发号，把协调缩小到 worker 身份分配。

经典实现使用如下布局：

![Snowflake 的 64 bit 布局](/images/posts/distributed-id-snowflake-layout.svg)

```text
0 | 41 bit timestamp | 5 bit datacenter | 5 bit worker | 12 bit sequence
```

最高位保持为 0，使结果落在有符号 64 bit 正数范围。41 bit 毫秒差值大约覆盖 69 年；数据中心和 worker 共 10 bit，可表达 1024 个节点组合；12 bit 序列允许一个 worker 在同一毫秒生成 4096 个 ID。位宽是工程配置，不是 Snowflake 名称自带的标准。换一个实现，epoch、机器位和序列位都可能不同。

### 一次发号只修改本地内存

最小 Java 实现可以写成：

```java
public final class SnowflakeIdGenerator {
    private static final long EPOCH = 1704067200000L;
    private static final long WORKER_BITS = 10L;
    private static final long SEQUENCE_BITS = 12L;
    private static final long MAX_WORKER = (1L << WORKER_BITS) - 1;
    private static final long SEQUENCE_MASK = (1L << SEQUENCE_BITS) - 1;

    private final long workerId;
    private long lastTimestamp = -1L;
    private long sequence = 0L;

    public SnowflakeIdGenerator(long workerId) {
        if (workerId < 0 || workerId > MAX_WORKER) {
            throw new IllegalArgumentException("invalid workerId");
        }
        this.workerId = workerId;
    }

    public synchronized long nextId() {
        long now = System.currentTimeMillis();
        if (now < lastTimestamp) {
            throw new IllegalStateException("clock moved backwards");
        }

        if (now == lastTimestamp) {
            sequence = (sequence + 1) & SEQUENCE_MASK;
            if (sequence == 0) {
                now = waitNextMillis(lastTimestamp);
            }
        } else {
            sequence = 0L;
        }

        lastTimestamp = now;
        return ((now - EPOCH) << (WORKER_BITS + SEQUENCE_BITS))
            | (workerId << SEQUENCE_BITS)
            | sequence;
    }

    private long waitNextMillis(long previous) {
        long now = System.currentTimeMillis();
        while (now <= previous) {
            Thread.onSpinWait();
            now = System.currentTimeMillis();
        }
        return now;
    }
}
```

同一毫秒内递增 `sequence`；序列绕回 0 时等待下一毫秒。时间推进后，序列重新从 0 开始。最终值通过移位和按位或拼接，不需要访问数据库。锁只保护一个生成器实例内的 `lastTimestamp` 和 `sequence`，不能替代跨节点唯一的 `workerId`。

Snowflake 保证的是趋势递增。节点 A 和 B 在同一毫秒生成的值会按机器位形成不同区间，调用完成顺序也可能与数字顺序不同。经典 Twitter 说明把这种性质称为 roughly sortable，并把目标描述为一个有限时间窗口内的近似排序，而非全局严格单调。

### 位布局是一份需要版本化的数据协议

设定 10 bit worker 并不等于系统能安全运行 1024 个进程。若按 5 bit 机房加 5 bit节点拆分，一个机房最多只有 32 个 worker；Kubernetes 在滚动发布时可能让新旧版本短暂共存，容量规划必须包含这种重叠。反过来，预留很多从未使用的节点位，会压缩时间寿命或单毫秒序列容量。

把业务类型、机房和租户继续塞进 Snowflake，看上去能从 ID 解析更多信息，也会把组织结构固化进长期数据。机房编号重排、业务合并和租户迁移以后，历史 ID 中的信息不会自动更新。解析能力确有业务价值时，应为格式增加明确版本，并保持旧解析器可用；只为了排障方便，日志单独记录元数据通常更灵活。

ID 还能暴露生成时间和节点。外部用户拿到 Snowflake 后可以估算对象创建时间，观察相邻 ID 还可能推测流量变化。安全敏感的业务可以对外使用独立随机业务号，内部继续使用 Snowflake 主键；也可以采用可逆置换隐藏局部连续性，但不能把置换当作访问控制。

### worker ID 重复会直接产生重复 ID

只要时间戳、worker ID 和 sequence 三部分相同，结果就完全相同。静态配置在少量固定机器上容易管理，进入容器环境后会遇到新的生命周期：Pod 名称变化、IP 被复用、实例快速重启、两个环境误用同一配置，都可能让两个活跃进程拿到相同 worker ID。

可选分配方式包括配置中心登记、ZooKeeper 临时节点、数据库租约，以及从稳定的实例身份映射。无论采用哪种方式，都要回答三个问题：分配是否唯一，身份失效后多久可以复用，旧进程恢复时怎样阻止它继续发号。只在启动时“查询一个当前没被占用的数字”，随后永久缓存，仍可能遇到租约过期后的旧实例。

| worker ID 来源 | 优点 | 主要风险 |
| --- | --- | --- |
| 静态配置 | 简单，运行时无依赖 | 人工冲突、扩缩容慢、环境复制出错 |
| IP 或端口取模 | 不需要登记服务 | 地址复用与哈希碰撞，容器环境不稳定 |
| 数据库分配 | 易于审计，可做租约 | 启动依赖数据库，旧实例恢复需要 fencing |
| ZooKeeper 顺序节点 | 分配有序，Session 可感知失联 | Session 过期和旧进程恢复仍需处理 |
| StatefulSet 序号 | 身份稳定，适合固定副本 | 跨集群命名冲突，临时扩容和迁移受约束 |

租约方式还需要一个类似 Fencing Token 的代次。worker 7 的第一任持有者暂停，租约到期后第二任接管；第一任恢复时如果继续使用相同 worker ID 和当前时间，两者仍可能在同一毫秒选择相同 sequence。生成器要在失去租约后停止发号，或把不可复用的 epoch/代次纳入 ID 空间。仅靠协调服务删除旧租约无法暂停旧进程。

Leaf 的 Snowflake 模式使用 ZooKeeper 顺序节点生成 worker ID，并把首次取得的 worker ID 缓存在本地文件中，以降低运行时对 ZooKeeper 的依赖。这个设计改善了 ZooKeeper 暂时不可用时的启动能力，也要求运维保证本地缓存与实例身份不会被错误复制。

### 时钟回拨需要明确策略

原始 Snowflake 实现在 `timestamp < lastTimestamp` 时拒绝发号。等待时钟重新追上适合小幅回拨；回拨持续很久时，等待等于服务不可用。另一些实现会使用备用 worker ID、维护逻辑偏移或切换到中心发号服务。每种方案都需要证明不会与过去已经使用的时间区间相撞。

NTP 校时不等于时钟永不后退。虚拟机迁移、宿主机时间调整、错误的运维命令和时钟源切换都可能造成跳变。上线时至少要监控当前时间与 `lastTimestamp` 的差值、拒绝次数、等待时长和每个 worker 的身份冲突。

常见处理策略各有边界：

| 策略 | 适用情况 | 代价与风险 |
| --- | --- | --- |
| 直接拒绝 | 正确性优先，调用方能降级 | 回拨期间停止发号 |
| 等待追平 | 只有几毫秒的小回拨 | 占住线程，无法处理大回拨 |
| 使用逻辑时间 | 能持久化并恢复逻辑进度 | 实现复杂，重启时不能丢失状态 |
| 切换备用 worker | 已预留互不重叠的身份 | 备用池有限，切换状态要持久化 |
| 降级到中心号段 | 系统同时维护两种生成方式 | 两个空间必须预先隔离，不能临时拼接 |

应用不能在发现回拨后简单把 `lastTimestamp` 设为当前时间。过去那个毫秒可能已经生成过从 0 开始的一批 sequence，再次进入同一个时间与 worker 组合会重新走过相同号码。等待或切换必须确保三元组不会重现。

Snowflake 还有一个容易忽略的寿命问题。epoch 与时间位宽一旦写入数据格式，就成为长期协议。41 bit 毫秒只能覆盖约 69 年；业务未必运行那么久，但数据归档、离线计算和多语言解析代码可能远比最初服务活得久。改变 epoch 或位宽之前，需要版本化格式，不能让同一列出现两种无法区分的解释。

## 五、号段模式把每次协调改成批量协调

Snowflake 把协调放在 worker 身份上，号段模式则保留中心分配，但一次领取成千上万个号码。数据库只保存每个业务当前分配到的上界：

```sql
CREATE TABLE id_alloc (
    biz_tag      VARCHAR(128) NOT NULL,
    max_id       BIGINT NOT NULL,
    step         INT NOT NULL,
    description  VARCHAR(256),
    update_time  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                 ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (biz_tag)
);
```

假设 `short_link` 当前记录是 `max_id = 300000, step = 10000`。发号节点在同一数据库事务中执行：

```sql
BEGIN;
UPDATE id_alloc
SET max_id = max_id + step
WHERE biz_tag = 'short_link';

SELECT max_id, step
FROM id_alloc
WHERE biz_tag = 'short_link';
COMMIT;
```

更新完成后返回的 `max_id` 是 310000，本次领取的区间是 `[300000, 310000)` 或 `[300001, 310000]`，具体端点取决于实现约定。发号节点随后用内存原子计数器分配这一万个值。另一个节点执行同样事务时，会在行更新上串行化，并拿到下一个不重叠区间。

数据库协调频率从“每个 ID 一次”降为“每个号段一次”。若 `step = 10000`，理论上每一万次发号才需要一次数据库更新。节点崩溃会丢掉尚未使用的尾段，产生空洞，却不会让其他节点重新领取这段范围。

号段模式不依赖应用机器的物理时钟，也没有 worker ID 冲突。它仍然依赖分配表的单调状态。如果数据库恢复到旧备份，或者两个可写主库从相同 `max_id` 各自前进，就可能重新发出已经使用过的区间。数据库拓扑和恢复流程属于唯一性协议的一部分。

### Step 同时决定数据库压力、浪费和故障缓冲

假设一个 Leaf 节点稳定消费 5000 ID/s，`step=10000` 时每两秒就要更新数据库，数据库抖动很容易落到请求尾延迟；把 `step` 提到 300 万，一个号段能用十分钟，节点刚领取就崩溃时最多浪费近 300 万个号码。号码空间足够大时，浪费通常比重复安全，但过大的跳跃会让监控、人工核对和下游对“增长速度”的错误假设暴露出来。

双 Buffer 已经准备好 next 时，数据库故障缓冲接近 current 剩余量加一个完整 next；next 尚未加载时，只有 current 剩余量。因而“Leaf 可以容忍数据库故障十分钟”不是固定产品属性，它随业务 QPS、Step、预取状态和 Leaf 节点数量变化。监控应该直接估算剩余可用秒数，而不是只显示还有多少个 ID。

## 六、美团 Leaf 怎样实现号段模式

美团公开的 Leaf 提供 Segment 与 Snowflake 两种模式。这一节聚焦 Leaf-segment，因为它展示了一个简单号段算法进入生产后需要增加哪些状态。

美团 2019 年的文章记录了 Leaf 的演进：第一版在号段用完时同步访问数据库，最大延迟取决于更新号段的耗时；数据库恰好在切换时不可用，发号请求也会中断。后续版本引入异步更新和双 Buffer，让当前号段继续服务，同时提前准备下一段。

### `leaf_alloc` 保存已经预留出去的上界

Leaf 的表以 `biz_tag` 区分业务，例如 `short_link`、`order` 和 `payment` 可以拥有独立序列。`max_id` 表示数据库已经预留出去的上界，不等于业务表中实际插入的最大 ID。Leaf Server 领取区间后，即使一个 ID 都没有写入业务库，数据库中的 `max_id` 也不会倒退。

Leaf 源码中的 `IDAllocDaoImpl` 把更新上界和读取最新记录放在一个 MyBatis `SqlSession` 事务内。普通路径使用表中配置的 `step`，动态步长路径把计算出的 `nextStep` 传给更新语句，再读取新的 `LeafAlloc`。事务串行化同一个 `biz_tag` 的区间申请，业务请求不直接访问这张表。

Leaf Server 会周期性读取数据库中的业务 tag，并把新增 tag 加入本地缓存、移除已经删除的 tag。第一次请求某个 tag 时，源码对对应 `SegmentBuffer` 做同步初始化，成功从数据库装载 current 后才把 `initOk` 设为 true。缓存本身使用 `ConcurrentHashMap`，但一个 tag 的初始化和两个 Segment 的切换仍需要更细粒度的同步状态。

内存里的一个 `Segment` 至少保存三个值：下一个待发号码、区间上界和本段步长。源码在装载时先计算：

```java
long value = leafAlloc.getMaxId() - buffer.getStep();
segment.getValue().set(value);
segment.setMax(leafAlloc.getMaxId());
segment.setStep(buffer.getStep());
```

发号路径通过 `getAndIncrement()` 取得当前值，并检查它是否小于 `max`。因此源码实际使用的是左闭右开区间 `[value, max)`。理解这个端点约定很重要，否则重写客户端或迁移实现时容易在边界处重复或浪费一个号码。

### 双 Buffer 把数据库访问移出切换点

![Leaf-segment 双 Buffer 的预取与切换](/images/posts/distributed-id-leaf-double-buffer.svg)

`SegmentBuffer` 持有两个 `Segment`。一个是 current，另一个是 next。当前段仍有号码时，请求线程只做内存原子递增；当剩余量低于源码中的阈值，线程池异步调用 `updateSegmentFromDb` 填充 next。当前段耗尽后，写锁保护 `switchPos()`，next 成为新的 current。

当前 `SegmentIDGenImpl` 的触发条件是：next 尚未准备好，当前段空闲数量小于 `0.9 * step`，并且 `threadRunning` 从 false 成功切到 true。换句话说，一个新号段消费超过约 10% 后，就会尝试预取下一段。`threadRunning` 避免同一 Buffer 同时启动多个加载任务，`nextReady` 表示备用段能否切换。

请求线程先持有读锁读取 current，并用原子 `getAndIncrement()` 竞争号码。取到的值小于 `max` 就立即返回；值已经越界时，线程释放读锁，等待可能正在运行的加载任务短暂推进，再取得写锁。写锁内会再次尝试 current，因为其他线程可能刚刚完成切换；仍然耗尽时，只有 `nextReady=true` 才执行 `switchPos()`。

这段“双重检查”不是多余代码。读锁释放到写锁获得之间，后台线程可能装好 next，另一个请求也可能先完成切换。如果切换逻辑只依据锁外读到的旧状态，就可能重复切换或错误报告无号可用。源码用读写锁保护位置切换，用原子布尔值保护后台装载资格，用原子计数器保护段内分配，三种同步手段各自覆盖不同状态。

这个设计把数据库耗时藏在当前号段的消费时间里。如果预取失败，当前段仍可继续发号；后台没有凭空创造可用性，数据库必须在当前段耗尽前恢复并让 next 加载成功。两个段都不可用时，源码返回 `EXCEPTION_ID_TWO_SEGMENTS_ARE_NULL`，调用方应把它视为发号失败，不能临时改用本地随机数破坏同一业务的 ID 契约。

### 动态 Step 让缓存时间适应流量

固定 `step` 在流量变化时会产生两个问题。QPS 增长十倍，同一号段支撑的时间缩短为十分之一，数据库故障缓冲随之缩短；QPS 很低而号段很大，进程重启会浪费更多未使用号码，新区间与已写入记录之间也会出现较大空洞。

美团文章用 `Q × T = L` 描述 QPS、号段消费周期和号段长度之间的关系，希望把消费周期稳定在一个区间。当前源码设置 `SEGMENT_DURATION = 15 分钟`，计算规则为：

| 上一号段的消费时间 | 下一个应用侧 Step |
| --- | --- |
| 小于 15 分钟 | 在不超过 `MAX_STEP` 的前提下翻倍 |
| 15 到 30 分钟 | 保持不变 |
| 大于 30 分钟 | 尝试减半，但不低于数据库配置的最小 Step |

这不是指数退避。它是根据上一段消费时长做倍增、保持或减半。流量突然增长几十倍时，算法仍需要至少经历一次较快消耗才能放大下一段；若数据库同时故障，现有 Buffer 依然可能提前耗尽。动态 Step 改善的是持续流量变化，不能消除瞬时洪峰和数据库依赖。

举例来说，数据库初始最小 Step 为 10 万：

```text
第 1 段用时 8 分钟  → 下一段 20 万
第 2 段用时 12 分钟 → 下一段 40 万
第 3 段用时 22 分钟 → 仍为 40 万
第 4 段用时 45 分钟 → 尝试降到 20 万
```

下降不会低于数据库配置的最小 Step。源码中的 `MAX_STEP` 也限制持续翻倍，避免高流量阶段把一个区间无限放大。数据库里的 `step` 因而承担基线配置，Buffer 中的 `step` 是当前运行时选择；排障时要同时观察两者。

### Leaf 的高可用边界在数据库提交点

美团文章报告，在当时 CentOS、4 核 8 GB 虚拟机的测试环境中，Leaf 远程调用达到 5 万以上 QPS，TP99 小于 1 毫秒。这个数字说明内存发号路径可以很短，不代表任意网络、JVM、数据库和客户端配置都能复现同样结果。部署验收应使用自己的调用协议、并发模型和故障场景。

Leaf-segment 的正常路径很轻，风险集中在低频控制面：

- 数据库提交成功而响应丢失时，客户端重试会领取下一个区间，前一个区间可能整体空缺。
- Leaf 节点崩溃时，内存中未使用的号码作废；重新启动后领取新区间。
- 数据库短暂不可用时，两个 Buffer 中尚未消费的号码决定还能支撑多久。
- 数据库恢复到较旧的 `max_id` 时，历史号段可能被再次分配，必须在恢复流程中把上界推进到安全值。
- 多机房各自开放写库时，两个分配中心可能从相同上界领取重叠区间；需要一个全局权威写点，或预先划分互不相交的号码空间。

监控也应围绕这些状态展开。Leaf 自带的监控界面可以查看各业务号段、双 Buffer 和当前发放位置；生产告警还需要覆盖申请数据库号段的延迟与失败、当前段剩余量、next 是否 ready、Step 变化、发号异常码和业务唯一索引冲突。

### 数据库恢复比日常发号更需要演练

假设数据库中的 `max_id` 已推进到 500 万，Leaf 节点也已经向业务发出其中一部分。运维从一个只包含 `max_id=400万` 的备份恢复分配表，服务启动后一切 SQL 都能成功，却会再次分配 400 万到 500 万之间的旧号码。这种事故不会被数据库可用性探针发现。

恢复前需要从可信证据计算安全上界。证据可能来自业务表最大 ID、仍在运行的 Leaf Buffer、审计日志和灾备库。仅取业务表 `MAX(id)` 也未必安全，因为 Leaf 已预留但尚未写入的区间可能在其他存活节点内。最保守的办法是停止所有发号节点，把 `max_id` 推进到高于所有已分配区间的值并预留安全余量，再恢复服务。

双主写入更危险。两个数据库都从 500 万开始，各自成功更新到 510 万，两个机房便获得完全相同的区间。半同步复制降低丢失窗口，但在网络隔离下是否允许两边同时写仍由故障切换策略决定。美团文章明确把号段模式描述为最终强依赖数据库，并说明其当时通过数据库中间件、主从切换和跨机房同步控制这一层风险。引用 Leaf 架构时，也要把这项前提一起带上。

## 七、用 Leaf 给短链接发号

短链接案例只走创建链路。用户提交长链接，应用用稳定幂等键识别同一次创建意图，向 Leaf 请求 `biz_tag=short_link` 的 ID，随后写入业务表：

```text
POST /links, Idempotency-Key: req-8f3
        │
        ├── Leaf-segment.get("short_link") → 300001
        │
        ├── Base62.encode(300001) → "1G2j"
        │
        └── INSERT short_link(id, short_code, long_url, request_key)
```

```sql
CREATE TABLE short_link (
    id           BIGINT UNSIGNED NOT NULL,
    short_code   VARCHAR(16) NOT NULL,
    long_url     TEXT NOT NULL,
    request_key  VARCHAR(64) NOT NULL,
    created_at   DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_short_code (short_code),
    UNIQUE KEY uk_request_key (request_key)
) ENGINE = InnoDB;
```

Leaf ID 在这里同时充当全局 ID 和数据库主键。Base62 把数字换成更短、适合 URL 的字符形式；只要编码是一一映射，短码唯一性来自底层 ID。Base62 可逆，也不隐藏递增关系，授权与防枚举不能依赖它。

发号成功而 `INSERT` 失败时，`300001` 直接废弃。应用不应把号码放回公共池，因为它无法证明号码是否已经被另一次超时写入使用。客户端重试时也不能只再申请一个 ID；同一个 `request_key` 要查询第一次创建的结果，否则一次用户意图会生成多个有效短链接。Leaf 解决号码冲突，幂等表或唯一约束解决请求重复，两者处在不同层。

创建链路可以先在本地生成短码，再用一条事务写入短链接记录与幂等结果：

```sql
BEGIN;

INSERT INTO short_link(id, short_code, long_url, request_key, created_at)
VALUES (:id, :shortCode, :longUrl, :requestKey, NOW(3));

INSERT INTO request_result(request_key, resource_id, status)
VALUES (:requestKey, :id, 'SUCCEEDED');

COMMIT;
```

两个相同 `request_key` 并发到达时，唯一约束决定一个胜者。失败者读取已经提交的 `resource_id` 并返回同一短链接。若事务结果未知，服务端按 `request_key` 查询，而不是再次创建。这个过程可能浪费几个 Leaf ID，却能保持业务效果唯一。

短码还可能因为编码规则变更而拥有版本。旧记录使用纯 Base62，新记录增加可逆扰动时，短码解析器需要区分格式；底层全局 ID 不必随展示方式变化。将内部 ID 和外部业务表示分层，会让以后修改域名、长度和防枚举策略更容易。

至于短码怎样找到数据库分片，取决于后续路由设计。可以用 ID 计算逻辑槽，也可以按其他业务字段分片；Leaf 只返回唯一数字，不承诺它能定位数据。这部分会在分库分表文章中展开。

## 八、全局 ID 是否应该直接作为 MySQL 主键

InnoDB 的二级索引叶子记录会携带主键列，因此主键长度会影响每个二级索引。`BIGINT` 类型的 Snowflake 或 Leaf ID 保持 8 字节，在尺寸上通常比文本 UUID 更紧凑。趋势递增的值也会让新插入大多落在索引右侧附近。

不过，Snowflake 不等于严格自增。多个 worker 在同一毫秒生成的 ID 会交错；Leaf 多个 Server 各自消费不同号段时，请求返回顺序也可能是 `1、1001、2、2001`。它们的写入局部性通常好于 UUIDv4 的全空间随机分布，但是否造成可观测的页分裂和缓存差异，需要在实际并发和索引结构上测量，不能仅凭算法名字下结论。

保留本地自增主键、另建全局业务 ID，适合下列情况：

- 查询总能先根据分片键定位单表，主键不需要跨片唯一；
- 数据库希望保留严格递增的聚簇键；
- 对外业务编号有独立格式、生命周期或安全要求；
- 团队愿意维护两列和额外唯一索引。

让全局 ID 直接做主键，则适合在写库前就需要引用对象、数据会跨分片合并、事件只携带一个稳定标识，或者希望减少一套内部行号的场景。应用必须处理发号服务不可用，并确保所有写入入口遵守同一生成协议。

UUID 也能作为主键。使用 UUIDv7、紧凑二进制存储和合适的数据库类型，可以减少 UUIDv4 文本主键的部分问题。主键选择应基于实际索引数量、插入模式、跨系统交换格式与运维能力，而不是把“全局唯一”直接等同于“最好的聚簇键”。

## 九、故障发生时，哪一层还在保证唯一

把生成器画成一条正常路径容易遗漏恢复条件。一次完整评审应从每个持久状态反推故障后果。

| 故障 | UUID | Snowflake | Leaf-segment |
| --- | --- | --- | --- |
| 单个应用进程崩溃 | 新进程继续随机生成 | 内存序列丢失，需保证 worker 与时间组合安全 | 未使用号段作废，其他节点继续 |
| 物理时钟回拨 | v7 实现需定义单调策略；v4 基本不依赖时间 | 可能拒绝发号或产生冲突风险 | 不依赖应用时钟保证唯一 |
| 节点身份冲突 | 无 worker ID | 相同 worker 可能撞号 | 无 worker ID |
| 中心数据库不可用 | 不受影响 | 本地发号可继续 | 依靠已缓存号段暂时继续 |
| 中心状态恢复到旧版本 | 不适用 | 身份分配系统可能重复分配 worker | `max_id` 倒退可能重发旧号段 |
| 跨语言存储 | 注意字节序和文本格式 | 注意 64 bit 精度、epoch 与位布局 | 注意 64 bit 精度和业务 tag |

JavaScript 的普通 `Number` 只能精确表示到 `2^53 - 1`。64 bit Snowflake 或 Leaf ID 通过 JSON 传给浏览器时，应使用字符串或 `BigInt` 兼容方案，不能让序列化层先把低位舍入。一个后端完全唯一的 ID，经过网关或前端数值转换后仍可能变成另一个值。

唯一约束应留在业务数据库中。它能发现生成器配置错误、数据重复导入和回放异常，也是事故中最接近事实的证据。发号器声称“绝不重复”不应成为删除唯一索引的理由；若写入规模让全局唯一索引无法实现，也要有离线重复检测和明确的冲突处置路径。

### 可用性要从创建业务的角度计算

发号器可用不代表创建业务可用。Leaf 返回 ID 后数据库可能拒绝写入；Snowflake 正常工作时，worker 所在服务的下游仍可能过载。反过来，Leaf 数据库故障时，业务仍能消费缓存号段。监控应把“成功生成 ID”“成功持久化业务记录”和“客户端拿到确定响应”分成三个阶段。

降级策略也要保持 ID 空间隔离。Leaf 不可用时临时切到 Snowflake，如果两套生成器都可能覆盖同一个 64 bit 范围，就无法仅靠数据库唯一约束避免大量冲突。可以预留格式位、使用互斥的数值区间，或者直接暂停创建并保留查询能力。故障现场临时选择 `System.currentTimeMillis()` 作为 ID，通常会把一次可用性事故升级为数据正确性事故。

## 十、怎样选择 UUID、Snowflake 与 Leaf

| 维度 | UUIDv4 / UUIDv7 | Snowflake | Leaf-segment |
| --- | --- | --- | --- |
| 生成位置 | 每个调用方本地 | 每个 worker 本地 | Leaf Server 内存 |
| 主要协调点 | 无中心注册 | worker ID 分配 | 数据库批量分配号段 |
| 常见长度 | 128 bit | 64 bit | 64 bit 整数 |
| 顺序特征 | v4 随机；v7 时间有序 | 趋势递增 | 每段内递增，整体趋势递增 |
| 应用时钟风险 | v4 低；v7 需处理回拨与单调性 | 高 | 低 |
| 中心依赖故障 | 无 | 取决于 worker 分配方式 | 缓存耗尽后受数据库影响 |
| 运维重点 | 实现版本、随机源、存储格式 | 时钟、worker 身份、epoch | 分配表、Buffer、Step、数据库恢复 |
| 常见用途 | 请求、文件、离线合并 | 高吞吐 64 bit 业务主键 | 集中治理的订单号、短链接 ID |

小型单库系统优先使用数据库自增。跨组织或离线生成、无法依赖中心服务时，UUID 通常最省运维。需要 64 bit、趋势递增和极短本地路径，并且团队能治理时钟与节点身份时，可以选择 Snowflake。希望集中管理业务序列、不愿把唯一性绑定到物理时钟，同时能维护高可用数据库时，Leaf-segment 更合适。

混合使用也很常见。HTTP 请求用 UUIDv7 作为 request ID，订单表用 Leaf ID，日志平台再用自己的 Snowflake 变体。它们的唯一范围、解析方式和暴露边界应写入接口契约，避免一个团队把另一套 ID 当作带业务含义的可解析字段。

### 四类常见需求会得出不同答案

链路追踪最关心的是各进程无需协调也能尽早创建 ID。请求刚进入边缘节点，还没有访问数据库，就要把 trace ID 写入日志并向下游传播。UUIDv4 或 UUIDv7 很适合这个位置；128 bit 和文本长度带来的成本，相比跨所有入口维护一个发号服务通常更低。若希望日志按创建时间大致聚集，可以优先考虑 UUIDv7，同时核对各语言库对同毫秒单调性的实现。

订单、支付单和短链接的要求不同。它们常用 `BIGINT` 存储，需要在插入主表前拿到 ID，还希望由平台统一管理业务序列。团队已经维护高可用 MySQL 和独立 Leaf 服务时，号段模式能绕开应用时钟与 worker 分配。数据库恢复流程必须纳入发号系统的变更和演练，不能把 `leaf_alloc` 当作普通配置表随意回档。

日志采集、事件流和大规模本地写入更看重生成路径不依赖中心服务。节点身份与时钟能够由基础设施统一治理时，Snowflake 可以把每次发号缩成内存计算。节点频繁漂移、无法可靠分配 worker ID 的平台，则可能让这份运维成本超过一次远程 Leaf 调用。

普通业务后台往往不需要上述复杂度。一个 MySQL 主库、几个应用副本和每秒几百次创建，继续使用 `AUTO_INCREMENT` 已经具备清晰的唯一性和恢复路径。未来可能分库不是现在部署发号集群的充分理由；可以先把数据库主键与对外业务 ID 的职责分开，为迁移保留字段和接口边界。

### 发号 API 也要定义失败和兼容语义

把 Leaf 包成 `GET /api/segment/get/short_link` 之后，调用方仍需要契约。成功响应应把 ID 作为字符串还是 JSON 数字返回；业务 tag 不存在、两个 Segment 耗尽、数据库超时分别使用什么稳定错误码；客户端能否重试，以及一次批量申请会不会部分成功，都要明确。

调用超时仍然是 UNKNOWN。Leaf 可能已经从内存取出一个 ID，只是响应丢失。客户端重试会得到新 ID，这通常只造成空洞；如果调用方已经用第一次的值执行了部分业务，重试链路必须依赖业务幂等键，而不是要求发号器返回同一个号码。发号接口没有足够上下文判断两个调用是否属于同一业务意图。

ID 的位布局和传输类型也应版本化。Snowflake 服务改变 epoch 或 bit 分配，解析程序必须知道从哪个版本开始生效；Leaf 从有符号范围切换到无符号范围时，Java、MySQL、Protobuf 和前端要同时兼容。最安全的接口把 ID 视为不透明标识，只有受控的诊断工具解析时间与节点字段。业务代码不应根据 ID 中的时间位判断订单是否过期，也不应把数值相邻当成记录具有业务关系。

## 十一、用测试和监控证明生成器满足承诺

单元测试连续调用一万次没有重复，只覆盖了最容易的路径。分布式 ID 测试应保存生成节点、调用开始与完成时间、原始 ID、解析出的各字段和最终写入结果，然后主动制造协议关心的故障。

Snowflake 至少需要验证：

- 多 worker 并发生成并做全量去重；
- 同一毫秒用满 sequence 后是否等待下一毫秒；
- 时钟小幅和大幅回拨时采取什么动作；
- 两个实例误用同一 worker ID 时能否在上线前被发现；
- 重启后 worker 身份与 epoch 是否保持约定；
- JSON、消息队列和前端是否按字符串无损传输。

Leaf-segment 的测试更偏恢复过程：

- 多个 Leaf Server 同时申请同一 `biz_tag`，区间不得重叠；
- 当前段消费超过预取阈值时，next 在后台加载；
- 数据库在预取期间不可用，当前段仍能继续发号；
- 当前段耗尽而 next 未准备好时，服务明确失败；
- 节点在领取号段后立刻崩溃，重启不会重发旧区间；
- 把分配表恢复到旧快照，演练怎样发现并推进安全上界；
- Step 在不同消费周期下按源码规则变化，且不越过上限和最小值。

一个基础并发测试可以让每个节点生成固定数量，再用集合和字段解析检查不变量：

```java
int workers = 16;
int perWorker = 200_000;
Set<Long> ids = ConcurrentHashMap.newKeySet(workers * perWorker);

IntStream.range(0, workers).parallel().forEach(workerId -> {
    SnowflakeIdGenerator generator = new SnowflakeIdGenerator(workerId);
    for (int i = 0; i < perWorker; i++) {
        long id = generator.nextId();
        if (!ids.add(id)) {
            throw new AssertionError("duplicate id: " + id);
        }
    }
});

if (ids.size() != workers * perWorker) {
    throw new AssertionError("lost ids");
}
```

这段测试只能证明当前进程、当前时钟和正确 worker 配置下没有重复。更有价值的版本会注入可控时钟、重复 worker、进程重启和序列耗尽，并把结果写入与生产相同的数据类型。对 Leaf 则需要启动真实数据库事务，模拟响应丢失和快照恢复；Mock DAO 无法验证号段更新的隔离行为。

线上指标要能解释容量还能支撑多久。除了 QPS 和延迟，Leaf 应记录每个 `biz_tag` 的 current 剩余量、nextReady、最近数据库加载耗时、Step、预计缓存可用秒数和加载失败次数；Snowflake 应记录 worker 身份、最近时间戳、回拨差值、序列耗尽与拒绝次数。业务库的唯一键冲突必须单独告警，因为它可能是发号协议已经失效的第一条证据。

## 十二、把协调放在团队能够证明和恢复的位置

UUID 通过更大的标识空间减少协调，Snowflake 把协调收缩到节点身份分配，号段模式把逐次协调摊成批量协调。三者没有统一的“性能最佳”答案，区别在于唯一性依赖什么状态，以及那个状态损坏后怎样恢复。

主键、业务 ID 和分片键可以共用一个字段，也可以各自独立。合并能减少字段和转换，拆分能降低发号、存储与路由之间的耦合。本文只走到“全局 ID 能否作为主键”；如何选择分片键、怎样凭业务 ID 找到数据、基因法和扩容迁移，会在下一篇分库分表文章中继续。

## 参考资料

- [RFC 9562: Universally Unique IDentifiers](https://www.rfc-editor.org/rfc/rfc9562.html)
- [Twitter Engineering: Announcing Snowflake](https://blog.x.com/engineering/en_us/a/2010/announcing-snowflake)
- [twitter-archive/snowflake](https://github.com/twitter-archive/snowflake)
- [美团技术团队：Leaf 分布式 ID 生成服务开源](https://tech.meituan.com/2019/03/07/open-source-project-leaf.html)
- [Meituan-Dianping/Leaf](https://github.com/Meituan-Dianping/Leaf)
- [Leaf SegmentIDGenImpl](https://github.com/Meituan-Dianping/Leaf/blob/master/leaf-core/src/main/java/com/sankuai/inf/leaf/segment/SegmentIDGenImpl.java)
- [MySQL: Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)
- [Redis INCR](https://redis.io/docs/latest/commands/incr/)
