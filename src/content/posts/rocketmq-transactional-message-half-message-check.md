---
title: RocketMQ 事务消息：半消息与回查怎样保证一致性
description: 拆解 RocketMQ 事务消息的「半消息 + 二次确认 + 状态回查」机制，说明它如何解决本地事务与消息发送的双写窗口，覆盖 COMMIT/ROLLBACK/UNKNOW 三态、回查的兜底与失败模式，以及与本地消息表（Outbox）的取舍。
category: 后端
subcategory: 消息队列
articleClass: focused
seriesOrder: 30
featured: true
publishedAt: 2026-10-01T21:20:00+08:00
updatedAt: 2026-10-06T15:46:00+08:00
tags: [RocketMQ, 事务消息, 半消息, 回查, 本地事务, Outbox, 一致性, 消息队列]
---

「用户下单」要同时做两件事：把订单写进数据库，再发一条消息通知下游（扣库存、发券、发短信）。这两件事无法成为一个原子操作——数据库提交了、消息还没发出去；或者消息发出去了、数据库却回滚了。这个"双写窗口"，是消息队列落地业务时最经典的一致性难题。

RocketMQ 的事务消息就是为这个窗口设计的。它的解法可以一句话概括：**先发一条消费者暂时看不见的"半消息"，执行本地事务后再决定这条消息是投递还是丢弃；如果"决定"这一步因为崩溃或断网而丢失，Broker 会主动回来问"你的本地事务到底成没成"**。

本文回答一个问题：这套“半消息 + 回查”机制具体怎么工作，它在什么情况下能收敛一致、什么情况下不能。代码采用 RocketMQ 4.x Remoting 的 `TransactionMQProducer` API，内部实现以 Apache RocketMQ 4.9.8 为参照；5.x gRPC SDK 的接口与部署方式不同，不能直接混用。站内 [分布式事务](/posts/distributed-transactions-2pc-tcc-saga-outbox/)讨论解法全景，本文深入事务消息的发布侧边界；消费可靠性另见 [消息怎样不丢失](/posts/message-queue-reliable-delivery-no-loss/)。

## 一、先看清要解决的窗口在哪

把"下单"拆成两步，双写窗口就现形了：

```text
1. 数据库：INSERT 订单（本地事务提交）
2. 消息：发一条"订单已创建"给下游
```

如果先做 1 再做 2，1 成功、2 失败（进程崩溃、网络闪断），订单落库了，下游却永远不知道这笔订单——库存没扣、用户没收到通知。如果先做 2 再做 1，消息发了、订单回滚了，下游按消息去查订单却查不到——数据对不上。

问题的本质是：**数据库和消息队列是两个独立系统，跨它们的操作没有原生原子性**。要堵住这个窗口，得让"业务数据"和"待发消息"在某一个时刻达成一致，再由另一方据此推进。

事务消息的思路是反过来排顺序：**先让消息"挂起"，再提交本地事务，最后根据本地事务结果决定消息去留**。消息先到 Broker 上占个位、但不投递，本地事务成了就放行、败了就丢弃——这样消息的可见性和本地事务的提交绑在了同一次决定上。

## 二、半消息 + 二次确认：两阶段机制

事务消息分两阶段。第一阶段发一条半消息（half message）：Broker 按存储配置接收并返回发送结果，但它暂不可投递，消费者看不到。生产者要检查发送结果是否符合所需的刷盘与复制条件，再执行本地事务；第二阶段，根据本地事务结果发提交（Commit）、回滚（Rollback）或未知状态。

```java
TransactionMQProducer producer = new TransactionMQProducer("order-group");
producer.setTransactionListener(new TransactionListener() {
    @Override
    public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        // 示例辅助函数：提交业务与事务结果记录后才返回 COMMIT；
        // 确认回滚返回 ROLLBACK，提交结果未知则返回 UNKNOW。
        return createOrderAndRecordTxOutcome(msg);
    }

    @Override
    public LocalTransactionState checkLocalTransaction(MessageExt msg) {
        // 示例辅助函数：按稳定 transactionId 查询权威持久记录。
        // 已提交 -> COMMIT，明确终止 -> ROLLBACK；
        // 仍执行、记录缺失、查询失败 -> UNKNOW。
        return queryDurableTxOutcome(msg);
    }
});
producer.sendMessageInTransaction(msg, null);
```

这段代码展示回调形状，两个辅助函数需要业务系统实现。`executeLocalTransaction` 在半消息发送满足成功条件后执行本地事务，`checkLocalTransaction` 留给 Broker 回查。回查查询原事务的结果，不重新下单。特别不能写成 `orderExists ? COMMIT : ROLLBACK`：查不到订单，可能只是原事务尚未提交、读副本滞后或查询失败，并不能证明它已经回滚。

在 4.9.8 实现中，半消息先写内部 Topic `RMQ_SYS_TRANS_HALF_TOPIC`，对业务消费者不可见。Commit 会恢复原 Topic 等属性并写入业务消息，再记录半消息已经处理；Rollback 记录该半消息不再放行。这里不是把磁盘上的记录物理搬走或立即擦除，旧日志仍由保留与清理机制处理。“半消息不可见”保证了下游不会提前消费，但发送确认的耐久程度仍取决于刷盘和复制策略。

![半消息、二次确认与状态回查的完整时序](/images/posts/rocketmq-transactional-message-flow.svg)

正常路径是半消息确认、本地事务执行，再按结果 Commit 或 Rollback。第二次确认丢失或事务结果未知时，Broker 按检查策略回查生产者。已提交才放行，明确回滚则不投递，仍未知则在策略允许范围内继续等待。

## 三、三个状态，和一个必须写对的回查

事务状态有三种：`COMMIT_MESSAGE`（提交，消费者可消费）、`ROLLBACK_MESSAGE`（回滚，消息丢弃）、`UNKNOW`（暂时无法确定）。`UNKNOW` 不是错误，它是"我还不知道本地事务结果"的诚实回答——常见于本地事务还在执行、或结果还没落库的情况。返回 `UNKNOW` 后，Broker 会等一段时间再回查。

回查不是无限进行的。`transactionTimeOut`、`transactionCheckInterval` 与 `transactionCheckMax` 分别约束可检查时间、扫描周期与检查次数，具体值以运行版本和配置为准；并不是超过一个超时值就必定立刻回查。在 [4.9.8 的检查实现](https://github.com/apache/rocketmq/blob/rocketmq-all-4.9.8/broker/src/main/java/org/apache/rocketmq/broker/transaction/queue/TransactionalMessageServiceImpl.java)中，还要考虑检查保护时间、已有处理记录及消息保留时间。次数耗尽的默认处置会尝试转写 `TRANS_CHECK_MAXTIME_TOPIC`，见 [默认检查监听器](https://github.com/apache/rocketmq/blob/rocketmq-all-4.9.8/broker/src/main/java/org/apache/rocketmq/broker/transaction/queue/DefaultTransactionalMessageCheckListener.java)。这不是普通消费失败的 DLQ，不能假设业务死信工具一定能看到它。

4.x 回查路由还依赖 Producer Group。原实例离线后，同组其他在线生产者可能接收回查，因此组内实例必须具有相同的查询能力，并能访问共享的权威事务状态。不能只查进程内存，也不能按订单号查到某一笔旧订单就认定本次事务成功。稳定的 `transactionId` 应对应本次逻辑操作，业务记录与已提交结果在同一数据库事务内落库；读路径必须避免把副本滞后解释成回滚。

对于仍在执行、没有结果记录或查询失败的事务，先返回 `UNKNOW`。[官方事务消息说明](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)明确要求在执行中的事务不要提前返回 Commit 或 Rollback。长期未知则需要业务超时处置：通过锁、版本或状态条件阻止原执行者继续提交，确认最终终止后才记录回滚。否则回查刚判断“取消”，原事务稍后又成功，就会造成业务已提交而消息永久不可见。

回查还是异步的，跑在生产者侧的独立线程里。官方示例专门为事务消息的 check 设置了一个线程池——`checkLocalTransaction` 被 Broker 的检查请求触发、并发执行。这带来两个推论：一是回查逻辑可能和业务请求并发跑，它读到的必须是"已经落库、能跨线程一致读到"的状态；二是回查请求会排队，线程池太小会在流量高峰积压回查，导致半消息迟迟得不到最终状态。所以事务消息的回查，本质是一套"生产者端要自己维护好的查询服务"，不是 Broker 替你包办。

## 四、失败模式与它到底保证什么

事务消息在本地事务结果判定正确、存储与恢复条件成立时，让消息可见性跟随事务结果收敛。它不保证数据库和所有下游在同一时刻完成，也不负责消费者的业务事务。要理解边界，得看清几类失败各自的结果。

以用户下单为例，本地事务是“插入订单、扣减本库库存、记录本次事务已提交”，消息通知下游发券。正常路径是半消息确认、本地事务提交、发送 Commit、业务消息可见、下游幂等发券。若库存位于另一个独立服务，就不能把远程扣库存也说成同一个本地事务；需要另行设计跨服务补偿。

**半消息发出后、本地事务执行前崩溃**：第一次查不到结果时先返回未知。业务恢复逻辑确认该操作终止且不会再提交后，持久记录回滚，再由回查返回 Rollback。不能仅凭一次空查询完成这个判断。

**本地事务提交后、第二次确认发出前崩溃**：业务数据与对应事务的已提交记录一起落库，回查据此返回 Commit。检查实例可用、半消息仍在有效恢复范围内时，消息可以被放行。消费者可能晚收到，不能承诺固定几秒内完成。

**回查本身也失败**：没有可用生产者、查询超时、次数耗尽或保留时间越界，都可能使消息无法自动放行。必须观察长期未知事务、异常半消息处置和业务结果；关键链路仍需扫描与对账。对账补发使用原业务键，避免恢复时再次发券。

**消费者重复消费**：Commit 之后、消费者消费完成之前崩溃，消息会被再次投递。事务消息解决的是"消息和本地事务是否一致"，不解决"消费是否恰好一次"。消费端仍然要幂等——这回到《超时、重试、幂等》那篇的原则：事务消息负责把"不该发的消息"拦在门外，幂等负责把"重复发的消息"消化掉，两者各管一段。

事务消息是一种面向最终一致性的事务协调机制，可以用于分布式事务方案，但不是 XA 式跨资源原子提交。它解决发布侧的双写窗口，不提供下游业务恰好执行一次的保证，也不能用“故障概率很小”替代结果查询和恢复设计。

事务消息也不是银弹，三种场景它帮不上忙。一是"本地事务"本身跨了多个系统、没有一个单一业务键能反查出最终状态——回查不知道该查谁，这套机制就落不了地。二是本地事务执行时间很长（比如要同步等外部接口），半消息长时间挂着、回查反复触发，消费者迟迟收不到消息。三是要求多个下游"要么都成功要么都失败"的强一致——事务消息只保证"消息和本地事务一致"，不保证"多个下游之间一致"，后者要靠 Saga 或对账。认清这些边界，才不会把事务消息当成万能的事务替代品，也不会在它覆盖不了的地方硬用它。

## 五、事务消息还是本地消息表：怎么选

解决同一个双写窗口，还有一条不依赖 MQ 特性的路：**本地消息表 / Transactional Outbox**。把"业务记录 + 待发消息"放进同一个本地数据库事务，后台任务轮询消息表、把没发出去的消息补发出去。站内分布式事务那篇已经讲过 Outbox 的机制。

两者的取舍很清晰：

| 维度 | RocketMQ 事务消息 | 本地消息表 / Outbox |
| --- | --- | --- |
| 依赖 | 绑死 RocketMQ 的事务消息能力 | 任何 MQ 都能用，甚至不用 MQ |
| 一致性 | 半消息 + 回查，由 Broker 兜底 | 靠数据库事务 + 后台补发 |
| 实现成本 | 实现 TransactionListener，写好回查 | 建消息表、写轮询发送任务、对账 |
| 跨实例回查 | 同 Producer Group 会被代查，回查必须查库 | 无此约束，逻辑更直白 |
| 适用 | 团队已用 RocketMQ，且愿意写对回查 | 要解耦 MQ、或已有 Outbox 基础设施 |

团队已经在用 RocketMQ，且能保存和查询本地事务结果时，可以优先评估事务消息。它省去了自行维护发布消息表和扫描器的一部分工作，但仍要实现可靠回查、超限处置和监控。如果需要跨 MQ，或者已有成熟的 Outbox 基础设施，继续使用本地消息表也合理。先写数据库再裸发消息，两种恢复机制都没有，则会留下双写窗口。

两种方案协调的是业务提交与事件发布。消费者仍需幂等处理重复，并通过关键链路对账发现应执行却未完成的业务。

还有一种中间态值得一提：如果系统已经跑着本地消息表 / Outbox，没必要全量换成事务消息——两者可以共存、按链路区分。和本地事务强绑定、又恰好落在 RocketMQ 上的关键路径，用事务消息省事；跨 MQ、或已经有成熟 Outbox 基础设施的路径，继续用 Outbox。选型是逐链路判断，不是全站一刀切。

## 参考资料

- [RocketMQ 官方文档：Transactional Message Sending](https://rocketmq.apache.org/docs/4.x/producer/06message5/)
- [RocketMQ 4.9.8：TransactionListener](https://github.com/apache/rocketmq/blob/rocketmq-all-4.9.8/client/src/main/java/org/apache/rocketmq/client/producer/TransactionListener.java)
- [RocketMQ 4.9.8：BrokerConfig](https://github.com/apache/rocketmq/blob/rocketmq-all-4.9.8/common/src/main/java/org/apache/rocketmq/common/BrokerConfig.java)
