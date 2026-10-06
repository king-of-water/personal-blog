---
title: RocketMQ、Kafka、RabbitMQ 怎么选
description: 从消息模型、业务语义、确认与恢复、容量和团队条件比较 RocketMQ、Kafka、RabbitMQ。区分 RabbitMQ 队列与 Streams、RocketMQ 客户端版本及 Kafka 事务边界，避免用固定吞吐排名和默认可靠性替代选型。
category: 后端
subcategory: 消息队列
articleClass: flagship
seriesOrder: 20
featured: true
publishedAt: 2026-10-02T20:59:00+08:00
updatedAt: 2026-10-06T15:46:00+08:00
tags: [消息队列, RocketMQ, Kafka, RabbitMQ, 选型, 对比, 事务消息, 延迟消息, 消息回溯, 吞吐]
---

「我们要上消息队列，用哪个？」这个问题最常见的答案是「高吞吐就 Kafka，业务消息就 RocketMQ，简单点就 RabbitMQ」。这句话方向对，却几乎没用——它没告诉你在具体约束下怎么判断，也掩盖了一个更根本的问题：三个系统不是"三种档次的同一个东西"，而是三种定位。

三者的常见使用方式不同：RabbitMQ 的队列模型强调交换机路由、任务分发与确认；Kafka 围绕分区日志、消费位点和事件回放组织能力；RocketMQ 在持久消息模型上提供事务、定时、重试与死信等业务语义。这是选型入口，不是产品能力的全部。尤其 RabbitMQ 还有支持非破坏性读取与历史回放的 Streams，不能把它整体概括成“取走就删”。

站内《消息队列怎样削峰》的结尾留了一个钩子：选型要根据顺序、回放、路由、延迟、吞吐、运维体系和云服务约束来判断，而不是一句话结束。这篇文章就把这七个约束拆开，落到三个系统上，最后给一套能直接用的决策顺序。结论先说：**先判断你的消息是"任务"还是"事件流"，再看吞吐量级和特殊语义，最后让生态和团队拍板**。

## 一、三个系统是三种定位，不是三档性能

选型的第一步不是比参数，而是先看清"你在选一个什么东西"。

RabbitMQ 的 AMQP 0.9.1 队列模型包含 exchange、queue、binding。消息按交换机类型和绑定规则路由，手动确认模式下由消费者 ACK 后释放相应消息；取到消息本身不等于完成。direct、topic、fanout、headers 提供不同路由方式，优先级、TTL 和死信能力还要核对队列类型与版本。任务分发是它常见的使用方式。

Kafka 的核心是 topic、partition 和 append-only log。消息写进分区日志，按 offset 顺序追加，消费者用 offset 记录自己读到哪，读过的消息不会删除（保留一段时间）。它的强项是**事件流**——一条消息是一个事实，可以被多个消费者独立读取、可以回放、可以重算。它适合的是"事件溯源、数据管道、日志采集"这类"要反复读、要多方读"的场景。

RocketMQ 的 Topic 与 MessageQueue 组织业务消息，原生提供事务与定时能力。4.x 常用固定延迟级别；5.x 的定时消息可以指定投递时间戳，但支持范围、精度和容量有约束，不是任意远期时间或精确到点执行。订单、支付、库存是常见场景，业务一致性仍需要应用共同实现。

![三种定位：消息代理、分布式日志、业务消息平台](/images/posts/mq-selection-positioning.svg)

图中展示常见定位，而不是排他边界。任务分发可以优先考察 RabbitMQ 队列或 RocketMQ；独立订阅和回放可优先考察 Kafka，也可以评估 [RabbitMQ Streams](https://www.rabbitmq.com/docs/streams)。Kafka 用消费组完成工作分配是正式模型，不是错误地模拟队列；代价在于应用要管理位点、长任务与重试等需求。

三者都有重叠能力。选型需要比较实现目标语义的成本，而不是寻找“免费的正确性”：使用原生功能仍要配置确认、处理失败、限制资源，并验证业务结果。一个系统能发送消息，不代表它已经满足长任务租约、回放或按业务对象保序的要求。

## 二、消息模型：路由、分区与日志

三个系统的消息模型决定了"消息怎么被组织、怎么被找到、怎么被并行消费"。

| 维度 | RabbitMQ | Kafka | RocketMQ |
| --- | --- | --- | --- |
| 核心结构 | exchange → queue → consumer | topic → partition → consumer group | topic → queue → consumer group |
| 消息路由 | 服务端按 routing key + 交换机类型路由 | 无服务端路由，分区内顺序读 | 按 tag / SQL 过滤 |
| 消费模型 | 队列支持推送订阅或主动获取；Streams 另有消费模型 | 消费组内按分区分配并拉取 | 4.x Remoting 回调或 LitePull；5.x gRPC 有 Push / Simple 等 |
| 消息删除 | 队列按确认等策略释放；Streams 按保留策略清理 | 按保留或压缩策略，不随消费删除 | 按保留与空间策略，不等消费者全部消费 |
| 并行边界 | 队列可有多个消费者；Streams 可分片 | 一组内每分区同一时刻分配给一个成员 | 4.x 常见队列级；5.x 部分类型使用消息级负载均衡 |

三者的差异在代码里一目了然：

```java
// RabbitMQ：路由在服务端，用 exchange + binding 决定消息去哪
channel.exchangeDeclare("order", "topic");
channel.queueBind("order.paid", "order", "paid.#");
channel.basicPublish("order", "paid.42", null, body);

// Kafka：无服务端路由，写 topic，消费者按分区拉取
producer.send(new ProducerRecord<>("orders", key, body));
records = consumer.poll(Duration.ofMillis(100));

// RocketMQ：写 topic + tag，消费者按 tag 过滤
producer.send(new Message("orders", "paid", body));
consumer.subscribe("orders", "paid");
```

RabbitMQ 的 exchange 与 binding 适合复杂路由。同一队列的消息交付顺序与业务完成顺序不是一回事：多消费者、优先级和重新投递都会影响观察到的顺序。需要顺序处理时应限制并发并核对消费者与队列配置，不能据此断言它完全没有保序能力。

Kafka 分区日志有序，但收到后交给无序线程池仍会乱序。RocketMQ 4.x 的队列分配与 5.x 消息级负载均衡不能笼统等同；普通并发消费也不自动保证业务有序。按对象保序需要同时检查生产发送顺序、稳定路由、顺序消费方式和失败重试策略。

## 三、吞吐与延迟：量级差异从哪来

不能把“RabbitMQ 万级、RocketMQ 十万级、Kafka 百万级”当作产品固有上限。硬件、消息大小、批次、队列或分区数量、确认策略、副本、客户端和负载形状都会改变结果。未提供同条件基准时，固定排名没有可复用的证据。

Kafka 的批量与顺序日志有利于摊薄开销，具体传输路径还受 TLS、压缩与客户端请求影响，不能用“零拷贝”解释所有情况。批次等待可换取吞吐，也会增加低流量延迟；这属于可调取舍，不等于 Kafka 必然比另一个系统延迟更差。

RocketMQ 也利用顺序写、缓存与批量。事务、定时、过滤以及刷盘和复制策略会改变资源成本，普通消息的结果不能直接代表定时或事务消息。容量评估要使用计划上线的消息类型和确认策略。

RabbitMQ 的路由、队列类型、复制与确认也有成本。持久化并不意味着每条消息独立 fsync；[发布确认文档](https://www.rabbitmq.com/docs/confirms)说明了批量刷盘与异步确认。Streams 又提供不同的日志模型，因此不能用队列的一份旧基准代表整个产品。

吞吐应作为候选方案的验收条件：在相同耐久要求和失败恢复预算下，能否满足峰值发布、持续消费与尾延迟。达到某个 QPS 不能自动排除产品；达不到时也要先确认瓶颈是否在客户端、热分区或下游数据库。

一个估算例子：100 万用户每天各产生 50 条消息，集中在 8 小时，平均约 1,736 条/秒；若预计峰值 2 万条/秒，每条 1 KiB，原始发布流量约 19.5 MiB/秒。副本、协议、索引与重试继续增加资源消耗。这个计算只给出负载输入，不能证明任何产品一定够用。低流量系统也可以沿用现有 Kafka 托管设施，成本应看团队已有条件，而不是产品标签。

## 四、业务语义的分水岭：顺序、事务、延迟、回溯

吞吐是"能不能扛住"，业务语义是"扛住之后能不能用"。这里才是三个系统真正拉开差距的地方。

| 能力 | RabbitMQ | Kafka | RocketMQ |
| --- | --- | --- | --- |
| 顺序消息 | 需约束交付、消费者并发与重投 | 分区日志有序，应用仍需保序 | 需使用对应版本的顺序消息与消费配置 |
| 事务边界 | AMQP 事务不包含外部数据库；业务可用 Outbox | Kafka 事务可原子提交记录与消费位点，不包含任意外部数据库 | 半消息 + 本地事务结果查询，不包含下游业务提交 |
| 延迟/定时消息 | TTL + DLX 或可用插件，需核对版本与限制 | 通常需要外部调度或额外机制 | 4.x 延迟级别；5.x 支持受范围和精度约束的时间戳 |
| 消息回溯 | 普通队列不保留已确认历史；Streams 支持回放 | 在保留与压缩边界内重读 | 在保留范围内回溯，具体能力依客户端与管理接口 |
| 优先级 / TTL / 死信 | 原生且灵活 | 不支持优先级 | 重试队列 + 死信队列内置 |

RocketMQ 事务消息直接处理本地事务与发布的一致性。代码形状可以参考 [半消息与回查](/posts/rocketmq-transactional-message-half-message-check/)，关键是正确返回三态，而不是只判断某条订单是否存在：

```java
TransactionMQProducer producer = new TransactionMQProducer("order-group");
producer.setTransactionListener(new TransactionListener() {
    public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        return executeAndRecordTxOutcome(msg); // COMMIT / ROLLBACK / UNKNOW
    }
    public LocalTransactionState checkLocalTransaction(MessageExt msg) {
        return queryDurableTxOutcome(msg); // 仍执行、查询失败或记录缺失不直接回滚
    }
});
producer.sendMessageInTransaction(msg, null);
```

示例中的辅助函数由业务实现。半消息先不可见，本地事务完成后提交或回滚，结果未知则等待回查。它要求持久、准确的结果查询与异常恢复，并非消除所有双写风险。Kafka 事务解决其协议覆盖范围内的读写与位点提交；RabbitMQ 的 AMQP 事务也不与 MySQL 自动组成原子事务。若希望解耦 MQ，可在三者前面使用 Transactional Outbox。

顺序先问业务对象：通常同一订单有序就够，不必所有订单串行。但同一个 key 不能单独保证端到端顺序。生产者并发发送、失败重试、路由变化、无序业务线程池，以及失败消息转到另一个队列后让后续消息先执行，都可能破坏顺序。保序需要贯穿发送、存储、处理与恢复；全局顺序还会压低并行度。

延迟消息要区分“到时可投递”和“到时业务完成”。RocketMQ [5.x 定时消息](https://rocketmq.apache.org/docs/featureBehavior/02delaymessage/)有允许时间范围和调度精度，积压还会增加实际处理延迟。RabbitMQ 的 TTL + DLX 需要检查队头过期、死信转发可靠性等限制，并把到期调度队列与异常死信区分开；插件也要确认维护状态与兼容性。Kafka 通常配合外部调度器或额外时间管理机制，额外开发成本应计入选型。

Kafka 的日志位点适合事件重算与独立订阅，但重读范围受保留、压缩和数据删除影响。RocketMQ 同样不能读取已被清理的历史。RabbitMQ 普通队列不提供已确认历史回放，Streams 则可以；若回放是核心需求，必须把候选的具体存储模型写清楚，而不是只列产品名。

## 五、堆积、可靠性与生态运维

积压需要同时考虑容量、保留期限和追赶读取成本。Kafka、RocketMQ 的日志模型适合保留消息，但大量历史读取、冷热数据切换、磁盘水位与复制恢复仍会影响性能，不能承诺“积压亿条不影响吞吐”。RabbitMQ 队列与 Streams 的目标不同，也不能统一排除。

设计时应使用预计停机时间推导最坏积压，再判断剩余消费能力能否在保留期内追赶。队列长期不能收敛，换产品也不能解决下游永久容量不足。详见 [积压、消费能力与流量整形](/posts/message-queue-peak-shaving-backlog-consumer-capacity/)。

可靠性必须核对具体确认边界。RabbitMQ 通常组合持久化队列、消息持久标记、publisher confirms、正确路由与手动消费 ACK，复制队列可评估 quorum queues；旧式镜像队列不应作为新版本方案。Kafka 要一起看 `acks`、ISR、副本、写入门槛与选主策略；RocketMQ 要看刷盘、复制、发送状态与消费确认。不能说三者“默认都至少一次且不丢”：自动确认、提前提交位点、未处理发送失败等用法都可能漏处理。完整分析见 [消息怎样不丢失](/posts/message-queue-reliable-delivery-no-loss/)。

运维成本来自实际部署：客户端与协议兼容性、拓扑、副本、升级、备份、监控、重放工具及托管服务。RabbitMQ 单机容易启动，不等于高可用集群最轻；Kafka 已有成熟托管体系时，也可能比新引入另一套系统更省成本。团队经验和现有基础设施往往比产品标签重要。

## 六、怎么拍板：四步决策

把前面的维度收拢成四个问题，按顺序问，比拉一张几十行的对比表有用。

![消息队列选型的四步决策](/images/posts/mq-selection-decision.svg)

**第一步，消息是任务还是事件流？** 一件要被某个消费者处理完的工作（订单处理、发短信、任务调度），是任务；一条要保留、要回放、要多个团队各自消费的事实（日志、埋点、状态变更），是事件流。任务优先 RabbitMQ / RocketMQ，事件流优先 Kafka。这一步能把一半的选型定下来。

**第二步，容量要求是什么？** 列出消息大小、峰值持续时间、持续消费、允许积压、尾延迟与副本策略，再核对同条件下的候选容量，不用固定 QPS 门槛排除产品。

**第三步，有没有硬性的业务语义？** 事务与定时可优先考察 RocketMQ；复杂路由可优先考察 RabbitMQ；事件回放与流处理可优先考察 Kafka，也要评估 Streams 等候选。然后检查具体版本限制和应用需要补的逻辑，不能只看功能表里有没有勾。

**第四步，生态、团队和云。** 团队熟不熟、多语言客户端齐不齐、云上有没有托管、周边工具（监控、Connector、流处理）够不够。前三步选出来的"技术正确"答案，常常在这一步被"运维现实"修正。

把四步放进三个假设场景。订单系统需要事务消息与半小时未支付提醒，团队已有 RocketMQ 经验，可优先验证 RocketMQ。埋点系统需要多个团队重算历史且已有 Kafka 流处理设施，可优先沿用 Kafka；每天十亿条平均约 1.16 万条/秒，不能直接推成百万级峰值。工单系统消息少、按部门路由，可考察 RabbitMQ 队列。三者都只是候选结论，仍需验证容量、恢复与上线成本。

## 七、几个常见误判

“高吞吐就 Kafka”忽略了业务语义。需要本地事务协调和延迟投递时，要比较原生能力与自建调度、Outbox 的维护成本；已经有这些基础设施的团队，也可能继续使用 Kafka。日志回放与流处理是它的重要候选理由，不能只用一个吞吐数字替代判断。

**「RocketMQ 就是另一个 Kafka」。** 不能只因为都有 Topic 和日志，就忽略事务回查、定时、重试与生态差异；同样也不能仅凭品牌断言它无法承担某种吞吐。

**「RabbitMQ 吞吐低所以不选」。** 先区分队列与 Streams，再查看自己的容量与确认要求。路由和团队已有运维能力可能比没有上下文的性能排名更重要。

**「先选型，迁移以后再说」。** 迁移涉及双写、消费位点、历史数据、确认和重试语义，成本必须提前考虑；不能在缺乏项目条件时断言一定比数据库迁移更高。

“先小规模上 RabbitMQ，大了迁 Kafka”需要说明迁移什么。若从队列确认转向分区位点，消费者的并发、重试、进度与回放都要重新设计；若原先使用 RabbitMQ Streams，差异又不一样。迁移可以渐进完成，但不能只搬消息格式而忽略消费协议与业务状态。

## 八、落到一张决策表

| 你的场景 | 建议 | 关键原因 |
| --- | --- | --- |
| 任务分发、灵活路由 | RabbitMQ 队列 | 交换机与绑定匹配路由需求，确认与队列类型另行核对 |
| 订单/支付/库存，要事务与延迟消息 | RocketMQ | 原生事务消息、延迟消息、重试死信 |
| 日志采集、埋点、数据管道、事件历史 | Kafka，也可评估 Streams | 保留范围内回放、独立位点与相关工具生态 |
| 流处理、多团队消费同一事件流 | Kafka | 独立消费位点、Connector 生态 |
| 业务消息 + 已有 RocketMQ 运维经验 | RocketMQ | 优先复用已有能力，核对版本、语义和容量 |
| 团队只熟一套、运维资源有限 | 优先评估已有系统 | 满足必要约束时，复用可降低建设和迁移负担 |

选型不是选"最好的消息队列"，是选"最匹配你约束的那个"。把"消息是任务还是事件流、吞吐多少、要不要特殊语义、生态熟不熟"这四个问题答清楚，答案通常就出来了。剩下的，就是别让"高吞吐就 Kafka"这种一句话结论替你思考。

如果系统已经在用某个 MQ，什么时候该考虑迁？信号是三个：吞吐已经逼近当前产品的能力上限且优化无望；业务开始频繁需要当前产品缺失的硬语义（比如在 Kafka 上反复自己实现延迟消息）；团队在同时维护多个 MQ、运维成本明显不划算。迁移的目标不是"换个更快的"，而是"换到定位更匹配的"，并且要在动手前把消费位点对齐和历史消息搬运的方案想清楚——否则迁移本身就成了一个新的技术债。

选型的结论最后要落成一段能被后来人挑战的文字：我们选 X，是因为消息是任务还是事件流、吞吐量级是多少、需要或不需要哪些语义、团队对哪套最熟。把理由写下来，比记住"当时谁拍板选了谁"更有价值——三年后有人质疑"当初为什么不用 Kafka"时，这段文字就是答案。

## 参考资料

- [RabbitMQ 官方文档：Queues / Reliability](https://www.rabbitmq.com/docs/)
- [Kafka 官方文档：Design](https://kafka.apache.org/documentation/)
- [RocketMQ 官方文档：Consumer / 特性](https://rocketmq.apache.org/docs/)
- [RabbitMQ：Publisher confirms 与 Consumer acknowledgements](https://www.rabbitmq.com/docs/confirms)
- [Kafka：KRaft（去 ZooKeeper）](https://kafka.apache.org/documentation/#kraft)
- [RocketMQ：事务消息](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)
- [RocketMQ：消费者类型与负载均衡](https://rocketmq.apache.org/docs/featureBehavior/06consumertype/)
- [RabbitMQ：Streams 与历史回放](https://www.rabbitmq.com/docs/streams)
- [Kafka 4.1：生产者确认与幂等配置](https://kafka.apache.org/41/configuration/producer-configs/)
